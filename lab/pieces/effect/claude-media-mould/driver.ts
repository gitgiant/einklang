import { definePiece, oklch, BAR_TICKS, TICKS_PER_BEAT, type Palette } from '../../../api/index.ts';

// Media mould. GPU state (not synced): an agent buffer, a ping-ponged trail map (density + carried
// colour) and an atomic deposit buffer. Per elapsed tick: `steps` x (agents sense/turn/move/deposit,
// then diffuse + decay). A share of the agents respawns on bright spots at every onset (in a disc)
// and at every phrase start (anywhere), so the colony re-forms around the picture.

const SIM_BYTES = 80, DRAW_BYTES = 48 + 8 * 16, MAX_CATCHUP = 3, REF_H = 540, PHRASE = 4 * BAR_TICKS;

export default definePiece({
  gpu: ({ device, shader }) => {
    const simMod = shader('sim.wgsl'), drawMod = shader('draw.wgsl');
    const C = GPUShaderStage.COMPUTE, F = GPUShaderStage.FRAGMENT;
    const bgl = device.createBindGroupLayout({
      label: 'claude-media-mould sim',
      entries: [
        { binding: 0, visibility: C, buffer: { type: 'uniform' } },
        { binding: 1, visibility: C, buffer: { type: 'storage' } },
        { binding: 2, visibility: C, buffer: { type: 'read-only-storage' } },
        { binding: 3, visibility: C, buffer: { type: 'storage' } },
        { binding: 4, visibility: C, buffer: { type: 'storage' } },
      ],
    });
    const mediaBgl = device.createBindGroupLayout({
      label: 'claude-media-mould media',
      entries: [
        { binding: 0, visibility: C | F, sampler: { type: 'filtering' } },
        ...[1, 2, 3].map((binding) => ({ binding, visibility: C | F, texture: { sampleType: 'float' as const } })),
      ],
    });
    const drawBgl = device.createBindGroupLayout({
      label: 'claude-media-mould draw',
      entries: [
        { binding: 0, visibility: F, buffer: { type: 'uniform' } },
        { binding: 1, visibility: F, buffer: { type: 'read-only-storage' } },
      ],
    });
    const layout = device.createPipelineLayout({ bindGroupLayouts: [bgl, mediaBgl] });
    const cp = (entryPoint: string) => device.createComputePipeline({ label: `claude-media-mould ${entryPoint}`, layout, compute: { module: simMod, entryPoint } });
    const spawn = cp('cs_spawn'), move = cp('cs_agents'), diffuse = cp('cs_diffuse');
    const draw = device.createRenderPipeline({
      label: 'claude-media-mould draw', layout: device.createPipelineLayout({ bindGroupLayouts: [drawBgl, mediaBgl] }),
      vertex: { module: drawMod, entryPoint: 'vs_full' },
      fragment: { module: drawMod, entryPoint: 'fs_draw', targets: [{ format: 'rgba16float' }] },
    });
    const samp = device.createSampler({ magFilter: 'linear', minFilter: 'linear', addressModeU: 'repeat', addressModeV: 'repeat' });
    const simU = [0, 1].map((i) => device.createBuffer({ label: `claude-media-mould sim u ${i}`, size: SIM_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST }));
    const drawU = device.createBuffer({ label: 'claude-media-mould draw u', size: DRAW_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const simData = new ArrayBuffer(SIM_BYTES), su = new Uint32Array(simData), sf = new Float32Array(simData);
    const df = new Float32Array(DRAW_BYTES / 4);

    let W = 0, H = 0, N = 0, cur = 0, lastTick = -Infinity;
    let agents: GPUBuffer | null = null, dep: GPUBuffer | null = null, trails: GPUBuffer[] = [];
    // simBg[u][i]: uniform buffer u (0 = steps, 1 = spawn), trail i read
    let simBg: GPUBindGroup[][] = [], drawBg: GPUBindGroup[] = [];

    const alloc = (w: number, h: number, n: number) => {
      agents?.destroy(); dep?.destroy(); for (const b of trails) b.destroy();
      W = w; H = h; N = n; cur = 0;
      const S = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST;
      agents = device.createBuffer({ label: 'claude-media-mould agents', size: n * 16, usage: S });
      dep = device.createBuffer({ label: 'claude-media-mould deposit', size: w * h * 16, usage: S });
      trails = [0, 1].map((i) => device.createBuffer({ label: `claude-media-mould trail ${i}`, size: w * h * 16, usage: S }));
      simBg = simU.map((ub) => [0, 1].map((i) => device.createBindGroup({
        layout: bgl,
        entries: [
          { binding: 0, resource: { buffer: ub } }, { binding: 1, resource: { buffer: agents! } },
          { binding: 2, resource: { buffer: trails[i] } }, { binding: 3, resource: { buffer: trails[1 - i] } },
          { binding: 4, resource: { buffer: dep! } },
        ],
      })));
      drawBg = [0, 1].map((i) => device.createBindGroup({
        layout: drawBgl,
        entries: [{ binding: 0, resource: { buffer: drawU } }, { binding: 1, resource: { buffer: trails[i] } }],
      }));
    };

    return {
      frame({ enc, out, in: ins, params, audio, time, tick, past, rand, width, height }) {
        const h = Math.round(Math.min(1080, Math.max(135, params.cells as number))), w = Math.max(16, Math.round((h * width) / height));
        const n = Math.round(Math.min(600, Math.max(10, params.agents as number)) * 1000);
        let fresh = false;
        if (w !== W || h !== H || n !== N) { alloc(w, h, n); fresh = true; }
        let ticks = tick - lastTick;
        if (fresh || ticks < 0 || ticks > 120) {
          enc.clearBuffer(trails[0]); enc.clearBuffer(trails[1]); enc.clearBuffer(dep!);
          cur = 0; ticks = 1; fresh = true;
        }
        ticks = Math.min(ticks, MAX_CATCHUP);
        lastTick = tick;

        const media = device.createBindGroup({
          layout: mediaBgl,
          entries: [{ binding: 0, resource: samp }, ...[ins.in, ins.luma, ins.edges].map((t, i) => ({ binding: i + 1, resource: (t as GPUTexture).createView() }))],
        });

        const avg = (lo: number, hi: number, f = audio) => { let s = 0; for (let b = lo; b <= hi; b++) s += f.bands[b]; return s / (hi - lo + 1); };
        let bass = 0, mid = 0;
        for (let ago = 0; ago < 6; ago++) { const f = past(ago); bass += avg(0, 2, f) / 6; mid += avg(5, 10, f) / 6; }
        let kick = 0, onsetAgo = -1;
        for (let ago = 0; ago < 30; ago++) if (past(ago).onset) { kick = Math.max(kick, Math.exp(-ago / 8)); if (onsetAgo < 0) onsetAgo = ago; }

        const s = h / REF_H, react = params.react as number;
        const ang = ((params.angle as number) * Math.PI / 180) * (1 + 0.8 * react * (mid - 0.3));
        const reach = (params.reach as number) * s * (1 + 1.2 * react * bass);
        const speed = (params.speed as number) * s * (1 + 0.8 * react * audio.rms + 0.6 * react * kick);
        const deposit = (params.deposit as number) * (0.6 + 0.8 * audio.rms + 0.6 * kick);
        const perCell = N / (W * H), mean = Math.max(0.01, perCell * (params.deposit as number) / Math.max(0.01, 1 - (params.decay as number)));
        const fill = (seed: number, share: number, bx: number, by: number, br: number) => {
          su.set([W, H, N, seed >>> 0], 0);
          sf.set([Math.max(0.05, ang), Math.max(1, reach), (params.turn as number) * Math.PI / 180, speed], 4);
          sf.set([deposit, params.decay as number, params.diffuse as number, (params.food as number) * (1 + 0.5 * react * bass)], 8);
          sf.set([params.wall as number, 1 / mean, share, 0.15], 12);
          sf.set([bx, by, br, 0], 16);
        };

        // spawns: everything at the start, a share at each phrase start (anywhere, bright first), a burst
        // on each onset since the last frame (a disc round a seeded spot)
        const tp = ((tick % PHRASE) + PHRASE) % PHRASE;
        const phraseHit = tp < ticks && !fresh;
        const burstAmt = params.burst as number;
        const hit = onsetAgo >= 0 && onsetAgo < ticks && burstAmt > 0;
        const bt = tick - Math.max(0, onsetAgo);
        let spawnShare = 0, br = 0, bx = 0, by = 0, seed = 0;
        if (fresh) { spawnShare = 1; seed = tick * 7 + 1; }
        else if (phraseHit) { spawnShare = params.reform as number; seed = tick * 7 + 2; }
        else if (hit) {
          spawnShare = burstAmt; seed = Math.floor(rand(bt, 3) * 0xffffffff);
          bx = (0.15 + 0.7 * rand(bt, 4)) * W; by = (0.15 + 0.7 * rand(bt, 5)) * H; br = (0.08 + 0.12 * rand(bt, 6)) * H;
        }
        if (spawnShare > 0) { fill(seed, spawnShare, bx, by, br); device.queue.writeBuffer(simU[1], 0, simData); }
        fill(Math.floor(rand(tick, 9) * 0xffffffff), 0, 0, 0, 0);
        device.queue.writeBuffer(simU[0], 0, simData);

        const gx = Math.ceil(N / 256);
        const pass = enc.beginComputePass({ label: 'claude-media-mould' });
        pass.setBindGroup(1, media);
        if (spawnShare > 0) { pass.setPipeline(spawn); pass.setBindGroup(0, simBg[1][cur]); pass.dispatchWorkgroups(gx); }
        const steps = Math.max(1, Math.round(params.steps as number)) * ticks;
        const cx = Math.ceil(W / 16), cy = Math.ceil(H / 16);
        for (let i = 0; i < steps; i++) {
          pass.setBindGroup(0, simBg[0][cur]);
          pass.setPipeline(move); pass.dispatchWorkgroups(gx);
          pass.setPipeline(diffuse); pass.dispatchWorkgroups(cx, cy);
          cur = 1 - cur;
        }
        pass.end();

        const pal = (ins.palette as Palette | undefined)?.stops ?? Array.from({ length: 6 }, (_, i) => oklch(0.3 + i * 0.12, 0.14, audio.pal + i / 10));
        const bps = (audio.bpm > 0 ? audio.bpm : 120) / 60;
        const env = Math.exp(-tp / (TICKS_PER_BEAT * 3));
        df.fill(0);
        df.set([W, H, Math.min(8, pal.length), params.glow as number, kick * (params.flash as number), audio.rms, (time * bps / 16) * (params.cycle as number), (0.5 / mean) * (params.exposure as number)], 0);
        df.set([Math.min(1, (params.show as number) + (params.reform as number) * 0.6 * env), params.tint as number, params.sat as number, 0], 8);
        pal.slice(0, 8).forEach((st, i) => df.set(st, 12 + i * 4));
        device.queue.writeBuffer(drawU, 0, df);
        const rp = enc.beginRenderPass({ colorAttachments: [{ view: out.out.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }] });
        rp.setPipeline(draw); rp.setBindGroup(0, drawBg[cur]); rp.setBindGroup(1, media); rp.draw(3); rp.end();
      },
      dispose: () => { agents?.destroy(); dep?.destroy(); for (const b of trails) b.destroy(); for (const b of simU) b.destroy(); drawU.destroy(); },
      status: () => `${N / 1000}k agents, ${W}x${H} trail`,
    };
  },
});
