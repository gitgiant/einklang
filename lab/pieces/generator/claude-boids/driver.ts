import { definePiece, oklch, type Palette } from '../../../api/index.ts';

// Boids. GPU state (not synced): ping-ponged boid buffers plus a uniform grid (per-cell counter and
// CAP slots) rebuilt every step. Per elapsed tick: `steps` x (clear grid, bin, flock step).
// Drawn as additive glowing streaks over an optional dusk-sky gradient from the palette's dark end.

const SIM_BYTES = 80, DRAW_BYTES = 48 + 8 * 16, CAP = 24, MAX_CATCHUP = 4;

export default definePiece({
  gpu: ({ device, shader }) => {
    const simMod = shader('sim.wgsl'), drawMod = shader('draw.wgsl');
    const C = GPUShaderStage.COMPUTE;
    const bgl = device.createBindGroupLayout({
      label: 'claude-boids sim',
      entries: [
        { binding: 0, visibility: C, buffer: { type: 'uniform' } },
        { binding: 1, visibility: C, buffer: { type: 'read-only-storage' } },
        { binding: 2, visibility: C, buffer: { type: 'storage' } },
        { binding: 3, visibility: C, buffer: { type: 'storage' } },
        { binding: 4, visibility: C, buffer: { type: 'storage' } },
      ],
    });
    const layout = device.createPipelineLayout({ bindGroupLayouts: [bgl] });
    const cp = (entryPoint: string) => device.createComputePipeline({ label: `claude-boids ${entryPoint}`, layout, compute: { module: simMod, entryPoint } });
    const init = cp('cs_init'), clear = cp('cs_clear'), bin = cp('cs_bin'), step = cp('cs_step');

    const dbgl = device.createBindGroupLayout({
      label: 'claude-boids draw',
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
      ],
    });
    const dlayout = device.createPipelineLayout({ bindGroupLayouts: [dbgl] });
    const sky = device.createRenderPipeline({
      label: 'claude-boids sky', layout: dlayout,
      vertex: { module: drawMod, entryPoint: 'vs_full' },
      fragment: { module: drawMod, entryPoint: 'fs_sky', targets: [{ format: 'rgba16float' }] },
    });
    const add: GPUBlendComponent = { srcFactor: 'one', dstFactor: 'one', operation: 'add' };
    const birds = device.createRenderPipeline({
      label: 'claude-boids birds', layout: dlayout,
      vertex: { module: drawMod, entryPoint: 'vs_boid' },
      fragment: { module: drawMod, entryPoint: 'fs_boid', targets: [{ format: 'rgba16float', blend: { color: add, alpha: add } }] },
    });

    const simU = device.createBuffer({ label: 'claude-boids sim u', size: SIM_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const drawU = device.createBuffer({ label: 'claude-boids draw u', size: DRAW_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const simData = new ArrayBuffer(SIM_BYTES), su = new Uint32Array(simData), sf = new Float32Array(simData);
    const df = new Float32Array(DRAW_BYTES / 4);

    let N = 0, GW = 0, GH = 0, cur = 0, lastTick = -Infinity, key = '';
    let bufs: GPUBuffer[] = [], counts: GPUBuffer | null = null, slots: GPUBuffer | null = null;
    let simBg: GPUBindGroup[] = [], drawBg: GPUBindGroup[] = [];

    const alloc = (n: number, gw: number, gh: number) => {
      for (const b of bufs) b.destroy(); counts?.destroy(); slots?.destroy();
      N = n; GW = gw; GH = gh; cur = 0;
      const S = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST;
      bufs = [0, 1].map((i) => device.createBuffer({ label: `claude-boids ${i}`, size: n * 16, usage: S }));
      counts = device.createBuffer({ label: 'claude-boids counts', size: gw * gh * 4, usage: S });
      slots = device.createBuffer({ label: 'claude-boids slots', size: gw * gh * CAP * 4, usage: S });
      simBg = [0, 1].map((i) => device.createBindGroup({
        layout: bgl,
        entries: [
          { binding: 0, resource: { buffer: simU } }, { binding: 1, resource: { buffer: bufs[i] } },
          { binding: 2, resource: { buffer: bufs[1 - i] } }, { binding: 3, resource: { buffer: counts! } },
          { binding: 4, resource: { buffer: slots! } },
        ],
      }));
      drawBg = [0, 1].map((i) => device.createBindGroup({
        layout: dbgl,
        entries: [{ binding: 0, resource: { buffer: drawU } }, { binding: 1, resource: { buffer: bufs[i] } }],
      }));
    };

    return {
      frame({ enc, out, in: ins, params, audio, time, tick, past, rand, width, height }) {
        const aspect = width / height;
        const n = Math.round(Math.min(65536, Math.max(256, params.count as number)));
        const radius = params.radius as number;
        const cell = Math.max(radius, 0.01);
        const gw = Math.max(1, Math.ceil(aspect / cell)), gh = Math.max(1, Math.ceil(1 / cell));
        const k = `${n}:${gw}:${gh}`;
        let fresh = false;
        if (k !== key) { key = k; alloc(n, gw, gh); fresh = true; }
        let ticks = tick - lastTick;
        if (fresh || ticks < 0 || ticks > 120) { fresh = true; ticks = 1; }
        ticks = Math.min(ticks, MAX_CATCHUP);
        lastTick = tick;

        let bass = 0;
        for (let ago = 0; ago < 8; ago++) { const f = past(ago); bass += (f.bands[0] + f.bands[1] + f.bands[2]) / 24; }
        let kick = 0, scatter = 0, onsetAgo = -1;
        for (let ago = 0; ago < 30; ago++) if (past(ago).onset) {
          kick = Math.max(kick, Math.exp(-ago / 6));
          scatter = Math.max(scatter, Math.exp(-ago / 5));
          if (onsetAgo < 0) onsetAgo = ago;
        }
        const st = tick - Math.max(0, onsetAgo);
        // roaming attractor: two slow incommensurate orbits, closed-form in time
        const ax = aspect * (0.5 + 0.3 * Math.sin(time * 0.13) + 0.08 * Math.sin(time * 0.41 + 1));
        const ay = 0.5 + 0.22 * Math.sin(time * 0.17 + 2) + 0.06 * Math.cos(time * 0.37);
        // the scatter centre sits near the attractor, where the flock is
        const sx = ax + (rand(st, 1) - 0.5) * 0.3, sy = ay + (rand(st, 2) - 0.5) * 0.3;
        const steps = Math.max(1, Math.round(params.steps as number));
        const tight = 1 + (params.tighten as number) * bass * 2.5;
        const speed = (params.speed as number) * (0.85 + 0.4 * audio.rms);

        su.set([N, GW, GH, Math.floor(rand(5, 5) * 1e9)], 0);
        sf.set([aspect, radius, cell, 1 / (60 * steps)], 4);
        sf.set([params.separation as number, params.alignment as number, (params.cohesion as number) * tight, speed], 8);
        sf.set([ax, ay, (params.pull as number) * (0.7 + 0.6 * bass), 2.5], 12);
        sf.set([sx, sy, scatter * (params.scatter as number) * 8, radius * (params.space as number) / Math.sqrt(tight)], 16);
        device.queue.writeBuffer(simU, 0, simData);

        const pass = enc.beginComputePass({ label: 'claude-boids' });
        const gb = Math.ceil(N / 256), gc = Math.ceil((GW * GH) / 256);
        if (fresh) { pass.setPipeline(init); pass.setBindGroup(0, simBg[1]); pass.dispatchWorkgroups(gb); cur = 0; }
        for (let i = 0; i < steps * ticks; i++) {
          pass.setBindGroup(0, simBg[cur]);
          pass.setPipeline(clear); pass.dispatchWorkgroups(gc);
          pass.setPipeline(bin); pass.dispatchWorkgroups(gb);
          pass.setPipeline(step); pass.dispatchWorkgroups(gb);
          cur = 1 - cur;
        }
        pass.end();

        const pal = (ins.palette as Palette | undefined)?.stops ?? Array.from({ length: 6 }, (_, i) => oklch(0.2 + i * 0.13, 0.12, audio.pal + i / 8));
        const bps = (audio.bpm > 0 ? audio.bpm : 120) / 60;
        df.fill(0);
        df.set([aspect, params.size as number, params.streak as number, params.glow as number], 0);
        df.set([speed, kick * (params.flash as number), (time * bps / 16) * (params.cycle as number), 0], 4);
        df.set([Math.min(8, pal.length), params.sky as number, 0, 0], 8);
        pal.slice(0, 8).forEach((s, i) => df.set(s, 12 + i * 4));
        device.queue.writeBuffer(drawU, 0, df);
        const rp = enc.beginRenderPass({ colorAttachments: [{ view: out.out.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }] });
        rp.setBindGroup(0, drawBg[cur]);
        rp.setPipeline(sky); rp.draw(3);
        rp.setPipeline(birds); rp.draw(6, N);
        rp.end();
      },
      dispose: () => { for (const b of bufs) b.destroy(); counts?.destroy(); slots?.destroy(); simU.destroy(); drawU.destroy(); },
      status: () => `${N} boids, ${GW}x${GH} grid`,
    };
  },
});
