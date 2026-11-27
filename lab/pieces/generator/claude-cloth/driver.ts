import { definePiece, oklch, type Palette } from '../../../api/index.ts';

// Cloth. GPU state (not synced): ping-ponged particle positions, the previous positions (verlet)
// and the rest/pin layout. Per elapsed tick: `steps` substeps of integrate (P0 -> P1) and an odd
// number of Jacobi constraint passes (P1 -> P0 -> ... -> P0), so the result always lands in P0.
// Drawn with 4x MSAA as a shaded mesh plus its rod over a gradient, resolved into the output.

const SIM_BYTES = 80, DRAW_BYTES = (32 + 24 + 16 + 32) * 4, MAX_CATCHUP = 4, WIDTH = 1.6, MSAA = 4;

function perspective(fovy: number, aspect: number, near: number, far: number): number[] {
  const f = 1 / Math.tan(fovy / 2), nf = 1 / (near - far);
  return [f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, far * nf, -1, 0, 0, near * far * nf, 0];
}
function lookAt(eye: number[], at: number[]): number[] {
  const sub = (a: number[], b: number[]) => a.map((x, i) => x - b[i]);
  const norm = (a: number[]) => { const l = Math.hypot(...a); return a.map((x) => x / l); };
  const cross = (a: number[], b: number[]) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const z = norm(sub(eye, at)), x = norm(cross([0, 1, 0], z)), y = cross(z, x);
  return [x[0], y[0], z[0], 0, x[1], y[1], z[1], 0, x[2], y[2], z[2], 0, -dot(x, eye), -dot(y, eye), -dot(z, eye), 1];
}

/** Rest layout per pin mode: pole (left column), top (top row), corners (two top corners). */
function layoutCloth(cols: number, rows: number, mode: number): Float32Array {
  const h = WIDTH / (cols - 1), ht = h * (rows - 1), data = new Float32Array(cols * rows * 4);
  for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
    const i = y * cols + x;
    const px = mode === 0 ? x * h : x * h - WIDTH / 2, py = ht / 2 - y * h;
    // a tiny deterministic ripple so the first gust has something to catch
    const pz = 0.002 * Math.sin(x * 0.9 + y * 1.7);
    const pinned = mode === 0 ? x === 0 : mode === 1 ? y === 0 : y === 0 && (x === 0 || x === cols - 1);
    data.set([px, py, pz, pinned ? 1 : 0], i * 4);
  }
  return data;
}

export default definePiece({
  gpu: ({ device, shader }) => {
    const simMod = shader('sim.wgsl'), drawMod = shader('draw.wgsl');
    const C = GPUShaderStage.COMPUTE;
    const bgl = device.createBindGroupLayout({
      label: 'claude-cloth sim',
      entries: [
        { binding: 0, visibility: C, buffer: { type: 'uniform' } },
        { binding: 1, visibility: C, buffer: { type: 'read-only-storage' } },
        { binding: 2, visibility: C, buffer: { type: 'storage' } },
        { binding: 3, visibility: C, buffer: { type: 'storage' } },
        { binding: 4, visibility: C, buffer: { type: 'read-only-storage' } },
      ],
    });
    const layout = device.createPipelineLayout({ bindGroupLayouts: [bgl] });
    const cp = (entryPoint: string) => device.createComputePipeline({ label: `claude-cloth ${entryPoint}`, layout, compute: { module: simMod, entryPoint } });
    const integrate = cp('cs_integrate'), relax = cp('cs_relax');

    const V = GPUShaderStage.VERTEX, F = GPUShaderStage.FRAGMENT;
    const dbgl = device.createBindGroupLayout({
      label: 'claude-cloth draw',
      entries: [
        { binding: 0, visibility: V | F, buffer: { type: 'uniform' } },
        { binding: 1, visibility: V, buffer: { type: 'read-only-storage' } },
      ],
    });
    const dlayout = device.createPipelineLayout({ bindGroupLayouts: [dbgl] });
    const rpipe = (vs: string, fs: string, depth: boolean) => device.createRenderPipeline({
      label: `claude-cloth ${fs}`, layout: dlayout,
      vertex: { module: drawMod, entryPoint: vs },
      fragment: { module: drawMod, entryPoint: fs, targets: [{ format: 'rgba16float' }] },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: depth ? { format: 'depth24plus', depthWriteEnabled: true, depthCompare: 'less' } : { format: 'depth24plus', depthWriteEnabled: false, depthCompare: 'always' },
      multisample: { count: MSAA },
    });
    const bg = rpipe('vs_full', 'fs_bg', false), cloth = rpipe('vs_cloth', 'fs_cloth', true), rod = rpipe('vs_rod', 'fs_rod', true);

    const simU = device.createBuffer({ label: 'claude-cloth sim u', size: SIM_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const drawU = device.createBuffer({ label: 'claude-cloth draw u', size: DRAW_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const simData = new ArrayBuffer(SIM_BYTES), su = new Uint32Array(simData), sf = new Float32Array(simData);
    const df = new Float32Array(DRAW_BYTES / 4);

    let COLS = 0, ROWS = 0, MODE = -1, nIdx = 0, lastTick = -Infinity;
    let P: GPUBuffer[] = [], prev: GPUBuffer | null = null, rest: GPUBuffer | null = null, idx: GPUBuffer | null = null;
    let A: GPUBindGroup | null = null, B: GPUBindGroup | null = null, drawBg: GPUBindGroup | null = null;
    let msaa: GPUTexture | null = null, depth: GPUTexture | null = null;

    const alloc = (cols: number, rows: number, mode: number) => {
      for (const b of P) b.destroy(); prev?.destroy(); rest?.destroy(); idx?.destroy();
      COLS = cols; ROWS = rows; MODE = mode;
      const n = cols * rows, S = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST;
      const restData = layoutCloth(cols, rows, mode);
      P = [0, 1].map((i) => device.createBuffer({ label: `claude-cloth pos ${i}`, size: n * 16, usage: S }));
      prev = device.createBuffer({ label: 'claude-cloth prev', size: n * 16, usage: S });
      rest = device.createBuffer({ label: 'claude-cloth rest', size: n * 16, usage: S });
      for (const b of [P[0], P[1], prev, rest]) device.queue.writeBuffer(b, 0, restData);
      const tris: number[] = [];
      for (let y = 0; y < rows - 1; y++) for (let x = 0; x < cols - 1; x++) {
        const i = y * cols + x;
        tris.push(i, i + 1, i + cols, i + 1, i + cols + 1, i + cols);
      }
      nIdx = tris.length;
      idx = device.createBuffer({ label: 'claude-cloth index', size: nIdx * 4, usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST });
      device.queue.writeBuffer(idx, 0, new Uint32Array(tris));
      const group = (a: number) => device.createBindGroup({
        layout: bgl,
        entries: [simU, P[a], P[1 - a], prev!, rest!].map((buffer, binding) => ({ binding, resource: { buffer } })),
      });
      A = group(0); B = group(1);
      drawBg = device.createBindGroup({ layout: dbgl, entries: [drawU, P[0]].map((buffer, binding) => ({ binding, resource: { buffer } })) });
    };

    return {
      frame({ enc, out, in: ins, params, audio, time, tick, past, width, height }) {
        const cols = Math.round(Math.min(160, Math.max(8, params.cols as number)));
        const rows = Math.round(Math.min(120, Math.max(6, params.rows as number)));
        const mode = Math.round(params.pin as number);
        let fresh = false;
        if (cols !== COLS || rows !== ROWS || mode !== MODE) { alloc(cols, rows, mode); fresh = true; }
        let ticks = tick - lastTick;
        if (!fresh && (ticks < 0 || ticks > 120)) {
          // a jump: start over from the rest layout
          const restData = layoutCloth(COLS, ROWS, MODE);
          for (const b of [P[0], P[1], prev!]) device.queue.writeBuffer(b, 0, restData);
          fresh = true;
        }
        if (fresh) ticks = 1;
        ticks = Math.min(ticks, MAX_CATCHUP);
        lastTick = tick;
        if (!msaa || msaa.width !== width || msaa.height !== height) {
          msaa?.destroy(); depth?.destroy();
          msaa = device.createTexture({ label: 'claude-cloth msaa', size: [width, height], format: 'rgba16float', sampleCount: MSAA, usage: GPUTextureUsage.RENDER_ATTACHMENT });
          depth = device.createTexture({ label: 'claude-cloth depth', size: [width, height], format: 'depth24plus', sampleCount: MSAA, usage: GPUTextureUsage.RENDER_ATTACHMENT });
        }

        const avg = (lo: number, hi: number, f = audio) => { let s = 0; for (let b = lo; b <= hi; b++) s += f.bands[b]; return s / (hi - lo + 1); };
        let bass = 0, mid = 0, high = 0;
        let loud = 0;
        for (let ago = 0; ago < 10; ago++) { const f = past(ago); bass += avg(0, 3, f) / 10; mid += avg(4, 9, f) / 10; high += avg(10, 15, f) / 10; loud += f.rms / 10; }
        let kick = 0;
        for (let ago = 0; ago < 40; ago++) if (past(ago).onset) { kick = Math.max(kick, Math.exp(-ago / 15)); }

        const steps = Math.max(1, Math.round(params.steps as number));
        const iters = Math.max(1, Math.round(params.iters as number)) | 1;
        const dt = 1 / (60 * steps);
        // quiet: a limp flag stirring; loud: flying flat out, so the music changes the whole silhouette
        const lvl = (params.idle as number) + (params.react as number) * bass * 1.6;
        const S = (params.wind as number) * (1 + 12 * lvl);
        // the wind blows away from the pole, or through the banner toward the camera, and the mids swing it
        const sw = (params.swing as number) * (0.35 * Math.sin(time * 0.11) + 0.6 * (mid - 0.25));
        const base = mode === 0 ? [Math.cos(sw), 0.04, -Math.sin(sw) - 0.12] : [Math.sin(sw) + 0.2, 0.05, 1];
        const bl = Math.hypot(...base), dir = base.map((c) => c / bl);
        const gust = (params.gust as number) * kick * (4 + 1.5 * S);
        su.set([COLS, ROWS, MODE, 0], 0);
        sf.set([dt, 1 - (params.damping as number), WIDTH / (COLS - 1), 0.45 * (params.stiffness as number)], 4);
        sf.set([dir[0] * S, dir[1] * S, dir[2] * S, params.aero as number], 8);
        sf.set([dir[0] * gust, dir[1] * gust, dir[2] * gust, (params.flutter as number) * (0.6 + 8 * high)], 12);
        sf.set([time, 1.6, 0.12, 9.8 * (params.gravity as number)], 16);
        device.queue.writeBuffer(simU, 0, simData);

        const gx = Math.ceil(COLS / 8), gy = Math.ceil(ROWS / 8);
        const pass = enc.beginComputePass({ label: 'claude-cloth' });
        for (let t = 0; t < steps * ticks; t++) {
          pass.setPipeline(integrate); pass.setBindGroup(0, A!); pass.dispatchWorkgroups(gx, gy);
          pass.setPipeline(relax);
          for (let k = 0; k < iters; k++) { pass.setBindGroup(0, k % 2 === 0 ? B! : A!); pass.dispatchWorkgroups(gx, gy); }
        }
        pass.end();

        // camera: a slow drift around the cloth's middle
        const aspect = width / height, ht = (WIDTH / (COLS - 1)) * (ROWS - 1);
        const target = mode === 0 ? [WIDTH * 0.48, -ht * 0.08, -0.1] : [0, -ht * 0.05, 0.15];
        const d = params.distance as number;
        const eye = [target[0] + d * 0.35 * Math.sin(time * 0.07), target[1] - 0.1 + 0.12 * Math.sin(time * 0.05 + 1), target[2] + d * Math.cos(0.35 * Math.sin(time * 0.07))];
        const pal = (ins.palette as Palette | undefined)?.stops ?? Array.from({ length: 6 }, (_, i) => oklch(0.15 + i * 0.15, 0.15, audio.pal + 0.05 + i / 7));
        const bps = (audio.bpm > 0 ? audio.bpm : 120) / 60;
        const top = ht / 2;
        const rodA = mode === 0 ? [0, top + 0.06, 0] : [-WIDTH / 2 - 0.05, top + 0.012, 0];
        const rodB = mode === 0 ? [0, -3, 0] : [WIDTH / 2 + 0.05, top + 0.012, 0];
        df.fill(0);
        df.set(lookAt(eye, target), 0);
        df.set(perspective(0.75, aspect, 0.05, 30), 16);
        df.set([...eye, time], 32);
        // the light swells with the loudness
        const pulse = params.pulse as number;
        df.set([-0.45, 0.75, 0.55, (params.glow as number) * (1 - pulse + pulse * (0.55 + 1.1 * loud))], 36);
        df.set([COLS, ROWS, Math.min(8, pal.length), Math.round(params.pattern as number)], 40);
        df.set([params.stripes as number, kick * (params.flash as number), (time * bps / 16) * (params.cycle as number), params.bg as number], 44);
        df.set([...rodA, mode === 0 ? 0.018 : 0.013], 48);
        df.set([...rodB, mode === 2 ? 0 : 1], 52);
        // the spectrum pattern: lightly smoothed bands
        for (let b = 0; b < 16; b++) { let s = 0; for (let ago = 0; ago < 4; ago++) s += past(ago).bands[b] / 4; df[56 + b] = s; }
        pal.slice(0, 8).forEach((st, i) => df.set(st, 72 + i * 4));
        device.queue.writeBuffer(drawU, 0, df);

        const rp = enc.beginRenderPass({
          colorAttachments: [{ view: msaa.createView(), resolveTarget: out.out.createView(), loadOp: 'clear', storeOp: 'discard', clearValue: [0, 0, 0, 1] }],
          depthStencilAttachment: { view: depth!.createView(), depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'discard' },
        });
        rp.setBindGroup(0, drawBg!);
        rp.setPipeline(bg); rp.draw(3);
        rp.setPipeline(cloth); rp.setIndexBuffer(idx!, 'uint32'); rp.drawIndexed(nIdx);
        rp.setPipeline(rod); rp.draw(6);
        rp.end();
      },
      dispose: () => { for (const b of P) b.destroy(); prev?.destroy(); rest?.destroy(); idx?.destroy(); msaa?.destroy(); depth?.destroy(); simU.destroy(); drawU.destroy(); },
      status: () => `${COLS}x${ROWS} cloth`,
    };
  },
});
