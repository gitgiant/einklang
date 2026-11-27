import { definePiece, oklch, type Audio, type Palette } from '../../../api/index.ts';

// SPH liquid tank. GPU state (not synced): particles (pos, vel), predicted positions, pressures,
// a uniform grid (atomic counts + fixed slots per cell). Per elapsed tick, `substeps` of: predict,
// clear, bin, density, relax. The tank's tilt and shake are closed-form functions of the onsets in
// the last two seconds; the sim runs in the tank's frame and gets them as forces: gravity turned
// by -tilt, the shake's acceleration (second difference of the offset), the Euler force of the
// turn's angular acceleration. The bass drives a paddle; an onset since the last frame splashes.

const SIM_BYTES = 112, DRAW_BYTES = (20 + 32) * 4, MAX_CATCHUP = 4, MAXPER = 48;
const TW = 1.6, TH = 0.9, CEIL = TH * 1.6, LOOK = 120;

interface Hit { ago: number; t0: number; bass: number; loud: number }

const bassOf = (f: Audio) => (f.bands[0] + f.bands[1] + f.bands[2]) / 3;

export default definePiece({
  gpu: ({ device, shader }) => {
    const simMod = shader('sim.wgsl'), drawMod = shader('draw.wgsl');
    const C = GPUShaderStage.COMPUTE, rw = { type: 'storage' } as const;
    const bgl = device.createBindGroupLayout({
      label: 'claude-sph sim',
      entries: [{ binding: 0, visibility: C, buffer: { type: 'uniform' } }, ...[1, 2, 3, 4, 5].map((binding) => ({ binding, visibility: C, buffer: rw }))],
    });
    const layout = device.createPipelineLayout({ bindGroupLayouts: [bgl] });
    const cp = (entryPoint: string) => device.createComputePipeline({ label: `claude-sph ${entryPoint}`, layout, compute: { module: simMod, entryPoint } });
    const [init, splash, predict, clear, bin, density, relax] = ['cs_init', 'cs_splash', 'cs_predict', 'cs_clear', 'cs_bin', 'cs_density', 'cs_relax'].map(cp);

    const add: GPUBlendComponent = { srcFactor: 'one', dstFactor: 'one', operation: 'add' };
    const splat = device.createRenderPipeline({
      label: 'claude-sph splat', layout: 'auto',
      vertex: { module: drawMod, entryPoint: 'vs_splat' },
      fragment: { module: drawMod, entryPoint: 'fs_splat', targets: [{ format: 'rgba16float', blend: { color: add, alpha: add } }] },
    });
    const comp = device.createRenderPipeline({
      label: 'claude-sph composite', layout: 'auto',
      vertex: { module: drawMod, entryPoint: 'vs_full' },
      fragment: { module: drawMod, entryPoint: 'fs_comp', targets: [{ format: 'rgba16float' }] },
    });
    const sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' });
    const simU = device.createBuffer({ label: 'claude-sph sim u', size: SIM_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const drawU = device.createBuffer({ label: 'claude-sph draw u', size: DRAW_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const simData = new ArrayBuffer(SIM_BYTES), su = new Uint32Array(simData), sf = new Float32Array(simData);
    const df = new Float32Array(DRAW_BYTES / 4);

    let N = 0, fillNow = -1, GX = 0, GY = 0, h = 0, sp = 0, rho0 = 0, lastTick = -Infinity;
    let bufs: GPUBuffer[] = [], simBg: GPUBindGroup | null = null, splatBg: GPUBindGroup | null = null;
    let tex: GPUTexture | null = null, compBg: GPUBindGroup | null = null, TWpx = 0, THpx = 0;

    const alloc = (n: number, fill: number) => {
      for (const b of bufs) b.destroy();
      N = n; fillNow = fill;
      sp = Math.sqrt((TW * TH * fill) / n); h = 2.4 * sp;
      GX = Math.ceil(TW / h); GY = Math.ceil(CEIL / h);
      // rest density: the kernel sum over a square lattice at the starting spacing
      rho0 = 0;
      for (let a = -3; a <= 3; a++) for (let b = -3; b <= 3; b++) { const q = Math.hypot(a, b) * sp / h; if ((a || b) && q < 1) rho0 += (1 - q) ** 2; }
      const S = GPUBufferUsage.STORAGE;
      const mk = (label: string, bytes: number) => device.createBuffer({ label: `claude-sph ${label}`, size: bytes, usage: S });
      const P = mk('particles', n * 16);
      bufs = [P, mk('predicted', n * 8), mk('pressure', n * 16), mk('counts', GX * GY * 4), mk('cells', GX * GY * MAXPER * 4)];
      simBg = device.createBindGroup({ layout: bgl, entries: [simU, ...bufs].map((buffer, binding) => ({ binding, resource: { buffer } })) });
      splatBg = device.createBindGroup({ layout: splat.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: drawU } }, { binding: 1, resource: { buffer: P } }] });
    };
    const target = (w: number, hh: number) => {
      const tw = Math.max(1, w >> 1), th = Math.max(1, hh >> 1);
      if (tex && tw === TWpx && th === THpx) return;
      tex?.destroy();
      TWpx = tw; THpx = th;
      tex = device.createTexture({ label: 'claude-sph density', size: [tw, th], format: 'rgba16float', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING });
      compBg = device.createBindGroup({
        layout: comp.getBindGroupLayout(0),
        entries: [{ binding: 0, resource: { buffer: drawU } }, { binding: 2, resource: tex.createView() }, { binding: 3, resource: sampler }],
      });
    };

    return {
      frame({ enc, out, in: ins, params, audio, time, tick, sub, past, rand, width, height }) {
        const n = Math.max(1024, Math.round(Math.min(16384, params.count as number) / 256) * 256);
        const fill = params.fill as number;
        let fresh = false;
        if (n !== N || fill !== fillNow) { alloc(n, fill); fresh = true; }
        target(width, height);
        let ticks = tick - lastTick;
        if (fresh || ticks < 0 || ticks > 120) { fresh = true; ticks = 1; }
        ticks = Math.min(ticks, MAX_CATCHUP);
        lastTick = tick;

        // the onsets of the last two seconds, with the bass and loudness they came with
        const hits: Hit[] = [];
        for (let ago = 0; ago < LOOK; ago++) { const f = past(ago); if (f.onset) hits.push({ ago, t0: tick - ago, bass: bassOf(f), loud: f.rms }); }
        const tilt = params.tilt as number, shake = params.shake as number, sway = params.sway as number;
        // tilt: a damped swing per onset, its size from the bass under it (kicks swing, snares barely)
        const theta = (e: number) => {
          const T = (tick + e) / 60;
          let th = sway * (0.6 * Math.sin(T * 0.55) + 0.4 * Math.sin(T * 0.23 + 1));
          for (const k of hits) {
            const a = k.ago + e;
            if (a < 0) continue;
            th += (rand(k.t0, 11) < 0.5 ? -1 : 1) * tilt * (0.25 + k.bass) * Math.sin(0.12 * a) * Math.exp(-a / 24);
          }
          return th;
        };
        // shake: a quick sideways jolt per onset, in world units
        const offset = (e: number) => {
          let x = 0, y = 0;
          for (const k of hits) {
            const a = k.ago + e;
            if (a < 0) continue;
            const ang = rand(k.t0, 12) * Math.PI * 2, amp = 0.02 * shake * (0.3 + k.loud) * (0.4 + k.bass) * Math.sin(0.35 * a) * Math.exp(-a / 7);
            x += Math.cos(ang) * amp; y += 0.35 * Math.sin(ang) * amp;
          }
          return [x, y];
        };
        const th0 = theta(0), clampA = (v: number, m: number) => Math.max(-m, Math.min(m, v));
        const alpha = clampA((theta(1) - 2 * th0 + theta(-1)) * 3600, 150);
        const [x1, y1] = offset(1), [x0, y0] = offset(0), [xm, ym] = offset(-1);
        const ax = clampA((x1 - 2 * x0 + xm) * 3600, 40), ay = clampA((y1 - 2 * y0 + ym) * 3600, 40);
        // tank frame: rotate world vectors by -theta; inertia is minus the tank's acceleration
        const c = Math.cos(-th0), s = Math.sin(-th0), g = params.gravity as number;
        const wx = -ax, wy = -g - ay;
        const acc = [wx * c - wy * s, wx * s + wy * c];

        // the paddle: a smoothed, gated bass envelope
        let env = 0, wsum = 0;
        for (let ago = 0; ago < 16; ago++) { const w = Math.exp(-ago / 3); env += w * Math.min(1, Math.max(0, (bassOf(past(ago)) - 0.3) / 0.6)); wsum += w; }
        env /= wsum;
        const wall = sp * 0.3, paddle = wall + (params.waves as number) * 0.16 * env;

        const subs = Math.max(2, Math.round(params.substeps as number)), dt = (params.speed as number) / (60 * subs);
        let onsetAgo = -1;
        for (const k of hits) { onsetAgo = k.ago; break; }
        const hit = onsetAgo >= 0 && onsetAgo < ticks && (params.splash as number) > 0;
        const pt = tick - Math.max(0, onsetAgo), ploud = hit ? past(onsetAgo).rms : 0;
        su.set([N, GX, GY, MAXPER], 0);
        sf.set([dt, h, rho0, params.stiff as number, params.near as number, params.visc as number, TW, TH], 4);
        sf.set([acc[0], acc[1], alpha, paddle], 12);
        sf.set([(0.12 + 0.76 * rand(pt, 13)) * TW, 0.75 * fill * TH - 0.06, 0.14, (params.splash as number) * 2.4 * (0.5 + ploud)], 16);
        sf.set([6, wall, CEIL], 20);
        su[23] = Math.floor(rand(7, 7) * 0xffffffff) >>> 0;
        sf.set([Math.max(1, Math.floor((TW * 0.45) / sp)), sp, TW / 2, TH / 2], 24);
        device.queue.writeBuffer(simU, 0, simData);

        const gx = Math.ceil(N / 128), gc = Math.ceil((GX * GY) / 128);
        const pass = enc.beginComputePass({ label: 'claude-sph' });
        pass.setBindGroup(0, simBg!);
        const run = (p: GPUComputePipeline, groups: number) => { pass.setPipeline(p); pass.dispatchWorkgroups(groups); };
        if (fresh) run(init, gx);
        else if (hit) run(splash, gx);
        for (let i = 0; i < subs * ticks; i++) { run(predict, gx); run(clear, gc); run(bin, gx); run(density, gx); run(relax, gx); }
        pass.end();

        // draw at the display sub-tick so the tank moves smoothly
        const e = sub / 256, thd = theta(e), [ox, oy] = offset(e);
        let kick = 0;
        for (const k of hits) if (k.ago < 30) kick = Math.max(kick, (0.4 + k.loud) * Math.exp(-k.ago / 7));
        const aspect = width / height, scale = 0.9 * (params.size as number), sc = scale / TH;
        const pal = (ins.palette as Palette | undefined)?.stops ?? Array.from({ length: 7 }, (_, i) => oklch(0.1 + i * 0.14, 0.12, audio.pal + 0.55 + i / 14));
        const bps = (audio.bpm > 0 ? audio.bpm : 120) / 60, blob = params.blob as number;
        df.fill(0);
        df.set([0.5 + (ox * sc) / aspect, 0.55 - oy * sc, sc, thd], 0);
        df.set([aspect, TW, TH, blob * sp], 4);
        df.set([3 / (Math.PI * blob * blob), params.thresh as number, paddle, kick], 8);
        df.set([params.glow as number, params.foam as number, params.bg as number, 0.08 * Math.sin(((time * bps) / 16) * (params.cycle as number) * Math.PI * 2)], 12);
        df.set([audio.rms, Math.min(8, pal.length), TH / (scale * height), wall], 16);
        pal.slice(0, 8).forEach((st, i) => df.set(st, 20 + i * 4));
        device.queue.writeBuffer(drawU, 0, df);

        const rs = enc.beginRenderPass({ colorAttachments: [{ view: tex!.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 0] }] });
        rs.setPipeline(splat); rs.setBindGroup(0, splatBg!); rs.draw(6, N); rs.end();
        const rp = enc.beginRenderPass({ colorAttachments: [{ view: out.out.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }] });
        rp.setPipeline(comp); rp.setBindGroup(0, compBg!); rp.draw(3); rp.end();
      },
      dispose: () => { for (const b of bufs) b.destroy(); simU.destroy(); drawU.destroy(); tex?.destroy(); },
      status: () => `${N} particles, ${GX}x${GY} grid`,
    };
  },
});
