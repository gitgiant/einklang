import { definePiece, oklch, type Palette } from '../../../api/index.ts';

// Picture swarm. GPU state (not synced): the birds, fixed-point grid sums and the resolved grid, plus
// an HDR accumulation target for the streaks. Per elapsed tick: clear, splat, resolve, step (see
// sim.wgsl). The bass sets the cruising speed, the mids the wander, the beat makes the flock hungrier
// for the bright parts, onsets blast it open from a seeded spot and fatten the birds.

const SIM_BYTES = 96, DRAW_BYTES = 64 + 8 * 16, MAX_CATCHUP = 4;

export default definePiece({
  gpu: ({ device, shader, formats }) => {
    const simMod = shader('sim.wgsl'), drawMod = shader('draw.wgsl');
    const C = GPUShaderStage.COMPUTE, VF = GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT;
    const bgl = device.createBindGroupLayout({
      label: 'claude-picture-swarm sim',
      entries: [
        { binding: 0, visibility: C, buffer: { type: 'uniform' } },
        { binding: 1, visibility: C, buffer: { type: 'storage' } },
        { binding: 2, visibility: C, buffer: { type: 'storage' } },
        { binding: 3, visibility: C, buffer: { type: 'storage' } },
        { binding: 4, visibility: C, sampler: { type: 'filtering' } },
        { binding: 5, visibility: C, texture: { sampleType: 'float' } },
        { binding: 6, visibility: C, texture: { sampleType: 'float' } },
      ],
    });
    const dbgl = device.createBindGroupLayout({
      label: 'claude-picture-swarm draw',
      entries: [
        { binding: 0, visibility: VF, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
        { binding: 2, visibility: VF, sampler: { type: 'filtering' } },
        { binding: 3, visibility: VF, texture: { sampleType: 'float' } },
        { binding: 4, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
      ],
    });
    const layout = device.createPipelineLayout({ bindGroupLayouts: [bgl] });
    const dlayout = device.createPipelineLayout({ bindGroupLayouts: [dbgl] });
    const cp = (entryPoint: string) => device.createComputePipeline({ label: `claude-picture-swarm ${entryPoint}`, layout, compute: { module: simMod, entryPoint } });
    const init = cp('cs_init'), clear = cp('cs_clear'), splat = cp('cs_splat'), resolve = cp('cs_resolve'), step = cp('cs_step');
    const add = { srcFactor: 'one', dstFactor: 'one', operation: 'add' } as const;
    const birdsP = device.createRenderPipeline({
      label: 'claude-picture-swarm birds', layout: dlayout,
      vertex: { module: drawMod, entryPoint: 'vs_bird' },
      fragment: { module: drawMod, entryPoint: 'fs_bird', targets: [{ format: formats.tex, blend: { color: add, alpha: add } }] },
    });
    const resolveP = device.createRenderPipeline({
      label: 'claude-picture-swarm resolve', layout: dlayout,
      vertex: { module: drawMod, entryPoint: 'vs_full' },
      fragment: { module: drawMod, entryPoint: 'fs_resolve', targets: [{ format: formats.tex }] },
    });
    const smp = device.createSampler({ magFilter: 'linear', minFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' });
    const dummy = device.createTexture({ label: 'claude-picture-swarm dummy', size: [1, 1], format: formats.tex, usage: GPUTextureUsage.TEXTURE_BINDING });
    const simU = device.createBuffer({ label: 'claude-picture-swarm sim u', size: SIM_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const drawU = device.createBuffer({ label: 'claude-picture-swarm draw u', size: DRAW_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const simData = new ArrayBuffer(SIM_BYTES), su = new Uint32Array(simData), sf = new Float32Array(simData);
    const df = new Float32Array(DRAW_BYTES / 4);

    let N = 0, GW = 0, GH = 0, AW = 0, AH = 0, lastTick = -Infinity;
    let birds: GPUBuffer | null = null, sums: GPUBuffer | null = null, grid: GPUBuffer | null = null, acc: GPUTexture | null = null;
    let simBg: GPUBindGroup | null = null, birdBg: GPUBindGroup | null = null, drawBg: GPUBindGroup | null = null;
    let lastPic: unknown = null, lastLuma: unknown = null;

    const alloc = (n: number, gw: number, gh: number) => {
      birds?.destroy(); sums?.destroy(); grid?.destroy();
      N = n; GW = gw; GH = gh; lastPic = null;
      const S = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST;
      birds = device.createBuffer({ label: 'claude-picture-swarm birds', size: n * 16, usage: S });
      sums = device.createBuffer({ label: 'claude-picture-swarm sums', size: gw * gh * 12, usage: S });
      grid = device.createBuffer({ label: 'claude-picture-swarm grid', size: gw * gh * 16, usage: S });
    };

    return {
      frame({ enc, out, in: ins, params, audio, time, tick, past, rand, width, height }) {
        const aspect = width / height;
        const n = Math.round(Math.min(400, Math.max(5, params.count as number)) * 1000);
        const gh = Math.round(Math.min(128, Math.max(16, params.grid as number))), gw = Math.max(4, Math.round(gh * aspect));
        let fresh = false;
        if (n !== N || gw !== GW || gh !== GH) { alloc(n, gw, gh); fresh = true; }
        if (!acc || AW !== width || AH !== height) {
          acc?.destroy(); AW = width; AH = height; lastPic = null;
          acc = device.createTexture({ label: 'claude-picture-swarm acc', size: [width, height], format: formats.tex, usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT });
        }
        const pic = ins.in as GPUTexture, luma = ins.luma as GPUTexture | undefined;
        if (pic !== lastPic || luma !== lastLuma) {
          lastPic = pic; lastLuma = luma;
          const pv = pic.createView(), lv = (luma ?? dummy).createView();
          simBg = device.createBindGroup({
            layout: bgl,
            entries: [
              { binding: 0, resource: { buffer: simU } }, { binding: 1, resource: { buffer: birds! } },
              { binding: 2, resource: { buffer: sums! } }, { binding: 3, resource: { buffer: grid! } },
              { binding: 4, resource: smp }, { binding: 5, resource: lv }, { binding: 6, resource: pv },
            ],
          });
          const dg = (a: GPUTexture) => device.createBindGroup({
            layout: dbgl,
            entries: [
              { binding: 0, resource: { buffer: drawU } }, { binding: 1, resource: { buffer: birds! } },
              { binding: 2, resource: smp }, { binding: 3, resource: pv }, { binding: 4, resource: a.createView() },
            ],
          });
          // the birds draw into acc, so their group can't bind it
          birdBg = dg(dummy); drawBg = dg(acc);
        }
        let ticks = tick - lastTick;
        if (fresh || ticks < 0 || ticks > 120) { ticks = 1; fresh = true; }
        ticks = Math.min(ticks, MAX_CATCHUP);
        lastTick = tick;

        const avg = (lo: number, hi: number, f = audio) => { let s = 0; for (let b = lo; b <= hi; b++) s += f.bands[b]; return s / (hi - lo + 1); };
        let bass = 0, mid = 0;
        for (let ago = 0; ago < 6; ago++) { const f = past(ago); bass += avg(0, 2, f) / 6; mid += avg(5, 10, f) / 6; }
        let kick = 0, onsetAgo = -1;
        for (let ago = 0; ago < 30; ago++) if (past(ago).onset) { kick = Math.max(kick, Math.exp(-ago / 8)); if (onsetAgo < 0) onsetAgo = ago; }
        const beatEnv = Math.exp(-audio.phase * 4);
        const react = params.react as number;
        const cruise = (params.speed as number) * (0.5 + react * (0.9 * bass + 0.5 * kick));
        const food = (params.food as number) * 4 * (1 + (params.hunger as number) * react * (beatEnv - 0.35));

        const scatterAmt = params.scatter as number;
        const hit = onsetAgo >= 0 && onsetAgo < ticks && scatterAmt > 0;
        const bt = tick - Math.max(0, onsetAgo);
        su.set([N, GW, GH, Math.imul(tick, 2654435761) >>> 0], 0);
        sf.set([aspect, 1 / 60, cruise, params.alignment as number], 4);
        sf.set([(params.cohesion as number) * 0.02, (params.separation as number) * 0.02, Math.max(0, food), (params.reach as number)], 8);
        sf.set([(params.wander as number) * (0.4 + react * 1.6 * mid), time, params.settle as number, luma ? 1 : 0], 12);
        sf.set([(0.15 + 0.7 * rand(bt, 1)) * aspect, 0.15 + 0.7 * rand(bt, 2), 0.12 + 0.12 * rand(bt, 3), hit ? scatterAmt * 1.2 : 0], 16);
        sf.set([params.contrast as number, N / (GW * GH), 0, 0], 20);
        device.queue.writeBuffer(simU, 0, simData);

        const gb = Math.ceil(N / 256), gc = Math.ceil((GW * GH * 3) / 256);
        const pass = enc.beginComputePass({ label: 'claude-picture-swarm' });
        pass.setBindGroup(0, simBg!);
        if (fresh) { pass.setPipeline(init); pass.dispatchWorkgroups(gb); }
        for (let t = 0; t < ticks; t++) {
          pass.setPipeline(clear); pass.dispatchWorkgroups(gc);
          pass.setPipeline(splat); pass.dispatchWorkgroups(gb);
          pass.setPipeline(resolve); pass.dispatchWorkgroups(Math.ceil(GW / 16), Math.ceil(GH / 16));
          pass.setPipeline(step); pass.dispatchWorkgroups(gb);
        }
        pass.end();

        const pal = (ins.palette as Palette | undefined)?.stops ?? Array.from({ length: 6 }, (_, i) => oklch(0.2 + i * 0.13, 0.12, audio.pal + 0.6 + i / 10));
        const bps = (audio.bpm > 0 ? audio.bpm : 120) / 60;
        const size = (params.size as number) * (height / 1080);
        // each bird adds this much: about one bird's worth per pixel at an even spread
        const area = Math.max(1, size * size * 4 * (1 + 0.5 * (params.streak as number)));
        const gain = (params.glow as number) * Math.min(1.5, (width * height) / (N * area) * 0.8);
        df.fill(0);
        df.set([width, height, aspect, Math.max(0.6, size)], 0);
        df.set([params.streak as number, gain, cruise, kick], 4);
        df.set([params.under as number, params.saturation as number, Math.min(8, pal.length), (time * bps / 16) * (params.cycle as number)], 8);
        df.set([params.sky as number, params.flash as number, 0, 0], 12);
        pal.slice(0, 8).forEach((st, i) => df.set(st, 16 + i * 4));
        device.queue.writeBuffer(drawU, 0, df);

        const rp = enc.beginRenderPass({ colorAttachments: [{ view: acc.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }] });
        rp.setPipeline(birdsP); rp.setBindGroup(0, birdBg!); rp.draw(6, N); rp.end();
        const rr = enc.beginRenderPass({ colorAttachments: [{ view: out.out.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }] });
        rr.setPipeline(resolveP); rr.setBindGroup(0, drawBg!); rr.draw(3); rr.end();
      },
      dispose: () => { birds?.destroy(); sums?.destroy(); grid?.destroy(); acc?.destroy(); simU.destroy(); drawU.destroy(); dummy.destroy(); },
      status: () => `${N / 1000}k birds, ${GW}x${GH} grid`,
    };
  },
});
