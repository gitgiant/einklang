import { definePiece, oklch, type Palette } from '../../../api/index.ts';

// N-body galaxy. GPU state (not synced): ping-ponged position and velocity buffers.
// Group A = (P0, V0 -> P1, V1), group B = (P1, V1 -> P0, V0); `cur` names the buffers holding now.
// Per elapsed tick: `steps` all-pairs steps. The core mass follows the bass; an onset since the
// last frame kicks the velocities first (in place on the current buffers).

const SIM_BYTES = 64, DRAW_BYTES = (32 + 12 + 8 * 4) * 4, MAX_CATCHUP = 4;

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

export default definePiece({
  gpu: ({ device, shader }) => {
    const simMod = shader('sim.wgsl'), drawMod = shader('draw.wgsl');
    const C = GPUShaderStage.COMPUTE;
    const bgl = device.createBindGroupLayout({
      label: 'claude-nbody sim',
      entries: [
        { binding: 0, visibility: C, buffer: { type: 'uniform' } },
        { binding: 1, visibility: C, buffer: { type: 'read-only-storage' } },
        { binding: 2, visibility: C, buffer: { type: 'read-only-storage' } },
        { binding: 3, visibility: C, buffer: { type: 'storage' } },
        { binding: 4, visibility: C, buffer: { type: 'storage' } },
      ],
    });
    const layout = device.createPipelineLayout({ bindGroupLayouts: [bgl] });
    const cp = (entryPoint: string) => device.createComputePipeline({ label: `claude-nbody ${entryPoint}`, layout, compute: { module: simMod, entryPoint } });
    const init = cp('cs_init'), kickP = cp('cs_kick'), step = cp('cs_step');

    const V = GPUShaderStage.VERTEX, F = GPUShaderStage.FRAGMENT;
    const dbgl = device.createBindGroupLayout({
      label: 'claude-nbody draw',
      entries: [
        { binding: 0, visibility: V | F, buffer: { type: 'uniform' } },
        { binding: 1, visibility: V, buffer: { type: 'read-only-storage' } },
        { binding: 2, visibility: V, buffer: { type: 'read-only-storage' } },
      ],
    });
    const dlayout = device.createPipelineLayout({ bindGroupLayouts: [dbgl] });
    const add: GPUBlendComponent = { srcFactor: 'one', dstFactor: 'one', operation: 'add' };
    const rpipe = (vs: string, fs: string, blend: boolean) => device.createRenderPipeline({
      label: `claude-nbody ${fs}`, layout: dlayout,
      vertex: { module: drawMod, entryPoint: vs },
      fragment: { module: drawMod, entryPoint: fs, targets: [blend ? { format: 'rgba16float', blend: { color: add, alpha: add } } : { format: 'rgba16float' }] },
    });
    const bg = rpipe('vs_full', 'fs_bg', false), stars = rpipe('vs_star', 'fs_star', true), core = rpipe('vs_core', 'fs_core', true);

    const simU = device.createBuffer({ label: 'claude-nbody sim u', size: SIM_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const drawU = device.createBuffer({ label: 'claude-nbody draw u', size: DRAW_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const simData = new ArrayBuffer(SIM_BYTES), su = new Uint32Array(simData), sf = new Float32Array(simData);
    const df = new Float32Array(DRAW_BYTES / 4);

    let N = 0, mode = -1, cur = 0, lastTick = -Infinity;
    let P: GPUBuffer[] = [], Vb: GPUBuffer[] = [];
    let A: GPUBindGroup | null = null, B: GPUBindGroup | null = null, drawBg: GPUBindGroup[] = [];

    const alloc = (n: number) => {
      for (const b of [...P, ...Vb]) b.destroy();
      N = n; cur = 0;
      const S = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST;
      P = [0, 1].map((i) => device.createBuffer({ label: `claude-nbody pos ${i}`, size: n * 16, usage: S }));
      Vb = [0, 1].map((i) => device.createBuffer({ label: `claude-nbody vel ${i}`, size: n * 16, usage: S }));
      const group = (a: number) => device.createBindGroup({
        layout: bgl,
        entries: [simU, P[a], Vb[a], P[1 - a], Vb[1 - a]].map((buffer, binding) => ({ binding, resource: { buffer } })),
      });
      A = group(0); B = group(1);
      drawBg = [0, 1].map((i) => device.createBindGroup({
        layout: dbgl,
        entries: [drawU, P[i], Vb[i]].map((buffer, binding) => ({ binding, resource: { buffer } })),
      }));
    };

    return {
      frame({ enc, out, in: ins, params, audio, time, tick, past, rand, width, height }) {
        const n = Math.max(256, Math.round(Math.min(16384, params.count as number) / 256) * 256);
        const m = Math.round(params.start as number);
        let fresh = false;
        if (n !== N) { alloc(n); fresh = true; }
        if (m !== mode) { mode = m; fresh = true; }
        let ticks = tick - lastTick;
        if (fresh || ticks < 0 || ticks > 120) { fresh = true; ticks = 1; }
        ticks = Math.min(ticks, MAX_CATCHUP);
        lastTick = tick;

        let bass = 0, loud = 0;
        for (let ago = 0; ago < 8; ago++) { const f = past(ago); bass += (f.bands[0] + f.bands[1] + f.bands[2]) / 24; loud += f.rms / 8; }
        let kick = 0, onsetAgo = -1;
        for (let ago = 0; ago < 30; ago++) if (past(ago).onset) { kick = Math.max(kick, Math.exp(-ago / 7)); if (onsetAgo < 0) onsetAgo = ago; }

        const steps = Math.max(1, Math.round(params.steps as number));
        const coreM = (params.core as number) * (1 + (params.pull as number) * bass);
        const soft = params.soft as number, diskR = 1;
        const hit = onsetAgo >= 0 && onsetAgo < ticks && (params.kick as number) > 0;
        const kt = tick - Math.max(0, onsetAgo);
        su.set([N, fresh ? Math.floor(rand(7, 7) * 0xffffffff) >>> 0 : (Math.floor(rand(kt, 8) * 0xffffffff) >>> 0), mode, 0], 0);
        sf.set([(params.speed as number) / (60 * steps), soft * soft, coreM, (soft * 2) ** 2], 4);
        sf.set([params.cool as number, params.kick as number, rand(kt, 9) * Math.PI * 2, 1 / N], 8);
        sf.set([diskR * 4, diskR, params.thick as number, 1], 12);
        device.queue.writeBuffer(simU, 0, simData);

        const gx = Math.ceil(N / 256);
        const pass = enc.beginComputePass({ label: 'claude-nbody' });
        if (fresh) { pass.setPipeline(init); pass.setBindGroup(0, B!); pass.dispatchWorkgroups(gx); cur = 0; }
        else if (hit) { pass.setPipeline(kickP); pass.setBindGroup(0, cur === 0 ? B! : A!); pass.dispatchWorkgroups(gx); }
        pass.setPipeline(step);
        for (let i = 0; i < steps * ticks; i++) {
          pass.setBindGroup(0, cur === 0 ? A! : B!); pass.dispatchWorkgroups(gx);
          cur = 1 - cur;
        }
        pass.end();

        // camera: a slow orbit at a tilt that breathes, pushing in on the bass
        const aspect = width / height;
        const az = time * (params.orbit as number) * Math.PI * 2 / 60;
        const el = (params.tilt as number) + 0.12 * Math.sin(time * 0.05);
        const dist = (params.distance as number) * (1 - 0.12 * bass);
        const eye = [dist * Math.cos(el) * Math.cos(az), dist * Math.sin(el), dist * Math.cos(el) * Math.sin(az)];
        const pal = (ins.palette as Palette | undefined)?.stops ?? Array.from({ length: 6 }, (_, i) => oklch(0.12 + i * 0.16, 0.12, audio.pal + 0.62 + i / 12));
        const bps = (audio.bpm > 0 ? audio.bpm : 120) / 60;
        df.fill(0);
        df.set(lookAt(eye, [0, 0, 0]), 0);
        df.set(perspective(0.8, aspect, 0.05, 50), 16);
        const pulse = params.pulse as number, glow = (params.glow as number) * (1 - pulse + pulse * (0.45 + 1.3 * loud));
        df.set([params.size as number, glow, kick, (time * bps / 16) * (params.cycle as number)], 32);
        df.set([Math.min(8, pal.length), coreM, params.coreglow as number, params.bg as number], 36);
        df.set([aspect, Math.sqrt(coreM + 0.9), params.dust as number, 0], 40);
        pal.slice(0, 8).forEach((st, i) => df.set(st, 44 + i * 4));
        device.queue.writeBuffer(drawU, 0, df);
        const rp = enc.beginRenderPass({ colorAttachments: [{ view: out.out.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }] });
        rp.setBindGroup(0, drawBg[cur]);
        rp.setPipeline(bg); rp.draw(3);
        rp.setPipeline(stars); rp.draw(6, N);
        rp.setPipeline(core); rp.draw(6);
        rp.end();
      },
      dispose: () => { for (const b of [...P, ...Vb]) b.destroy(); simU.destroy(); drawU.destroy(); },
      status: () => `${N} bodies`,
    };
  },
});
