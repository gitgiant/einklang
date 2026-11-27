import { definePiece, oklch, type Palette } from '../../../api/index.ts';

// Media-driven cellular automata (Life-like rules & continuous Lenia) on a toroidal cell grid.
// Every cell stores state (alive/mass, age, afterglow, flash) AND inherited RGB video colour.
// Media edges and luma continuously seed living cells and steer Lenia growth along contours;
// beats re-lock colonies onto the picture, bar spectral peaks pick the rule, and onsets burst.

const RULES: [number[], number[]][] = [
  [[3], [2, 3]], // Conway
  [[3, 6], [2, 3]], // HighLife
  [[3, 6, 8], [2, 4, 5]], // Morley
  [[3, 6], [1, 2, 5]], // 2x2
  [[3, 6, 7, 8], [3, 4, 6, 7, 8]], // Day & Night
  [[3, 5, 7], [1, 3, 5, 8]], // Amoeba
];
const bitmask = (ns: number[]) => ns.reduce((m, n) => m | (1 << n), 0);
const LENIA_MU = [0.15, 0.142, 0.16, 0.135, 0.168, 0.152];
const LENIA_SIGMA = 0.095;

// Sim uniform: 28 u32/f32 header (112 B) + 8 * vec4f seeds (128 B) = 240 B
const SIM_BYTES = 240;
// Draw uniform: 16 floats (64 B) + 8 * vec4f palette (128 B) = 192 B
const DRAW_BYTES = 192;
const MAX_SEEDS = 8;
const MAX_CATCHUP = 4;
const RMAX = 9;
const TPB = 28;

export default definePiece({
  gpu: ({ device, shader, formats }) => {
    const simMod = shader('sim.wgsl');
    const drawMod = shader('draw.wgsl');
    const C = GPUShaderStage.COMPUTE;
    const F = GPUShaderStage.FRAGMENT;

    const simBgl = device.createBindGroupLayout({
      label: 'agy-media-life sim bgl',
      entries: [
        { binding: 0, visibility: C, buffer: { type: 'uniform' } },
        { binding: 1, visibility: C, buffer: { type: 'read-only-storage' } },
        { binding: 2, visibility: C, buffer: { type: 'storage' } },
        { binding: 3, visibility: C, buffer: { type: 'read-only-storage' } },
        { binding: 4, visibility: C, buffer: { type: 'storage' } },
        { binding: 5, visibility: C, sampler: { type: 'filtering' } },
        { binding: 6, visibility: C, texture: { sampleType: 'float' } }, // in (pic)
        { binding: 7, visibility: C, texture: { sampleType: 'float' } }, // luma
        { binding: 8, visibility: C, texture: { sampleType: 'float' } }, // edges
      ],
    });

    const drawBgl = device.createBindGroupLayout({
      label: 'agy-media-life draw bgl',
      entries: [
        { binding: 0, visibility: F, buffer: { type: 'uniform' } },
        { binding: 1, visibility: F, buffer: { type: 'read-only-storage' } },
        { binding: 2, visibility: F, sampler: { type: 'filtering' } },
        { binding: 3, visibility: F, texture: { sampleType: 'float' } }, // in (pic)
      ],
    });

    const simLayout = device.createPipelineLayout({ bindGroupLayouts: [simBgl] });
    const cp = (entryPoint: string) =>
      device.createComputePipeline({
        label: `agy-media-life ${entryPoint}`,
        layout: simLayout,
        compute: { module: simMod, entryPoint },
      });
    const initP = cp('cs_init');
    const seedP = cp('cs_seed');
    const massP = cp('cs_mass');
    const lifeP = cp('cs_life');
    const leniaP = cp('cs_lenia');

    const drawPipe = device.createRenderPipeline({
      label: 'agy-media-life draw',
      layout: device.createPipelineLayout({ bindGroupLayouts: [drawBgl] }),
      vertex: { module: drawMod, entryPoint: 'vs_full' },
      fragment: { module: drawMod, entryPoint: 'fs_draw', targets: [{ format: formats.tex }] },
    });

    const smp = device.createSampler({
      magFilter: 'linear',
      minFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
    });
    const dummy = device.createTexture({
      label: 'agy-media-life dummy',
      size: [1, 1],
      format: formats.tex,
      usage: GPUTextureUsage.TEXTURE_BINDING,
    });

    const simU = device.createBuffer({
      label: 'agy-media-life sim u',
      size: SIM_BYTES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    const drawU = device.createBuffer({
      label: 'agy-media-life draw u',
      size: DRAW_BYTES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    const kernB = device.createBuffer({
      label: 'agy-media-life kernel',
      size: (2 * RMAX + 1) ** 2 * 16,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    const massB = device.createBuffer({
      label: 'agy-media-life mass',
      size: 16,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });

    const simData = new ArrayBuffer(SIM_BYTES);
    const su = new Uint32Array(simData);
    const sf = new Float32Array(simData);
    const df = new Float32Array(DRAW_BYTES / 4);

    let W = 0, H = 0, cur = 0, lastTick = -Infinity, R = 0, taps = 0, wasLenia = -1;
    let bufs: GPUBuffer[] = [];
    let simBg: GPUBindGroup[] = [];
    let drawBg: GPUBindGroup[] = [];
    let lastPic: unknown = null, lastLuma: unknown = null, lastEdges: unknown = null;
    let classBar = -1, cls = 0;

    const alloc = (w: number, h: number) => {
      for (const b of bufs) b.destroy();
      W = w; H = h; cur = 0;
      lastPic = lastLuma = lastEdges = null;
      // 32 bytes per cell (state: vec4f, color: vec4f)
      bufs = [0, 1].map((i) =>
        device.createBuffer({
          label: `agy-media-life cells ${i}`,
          size: w * h * 32,
          usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        }),
      );
    };

    const rebuildGroups = (pic: GPUTexture, luma?: GPUTexture, edges?: GPUTexture) => {
      const pv = pic.createView();
      const lv = (luma ?? dummy).createView();
      const ev = (edges ?? dummy).createView();
      simBg = [0, 1].map((i) =>
        device.createBindGroup({
          layout: simBgl,
          entries: [
            { binding: 0, resource: { buffer: simU } },
            { binding: 1, resource: { buffer: bufs[i] } },
            { binding: 2, resource: { buffer: bufs[1 - i] } },
            { binding: 3, resource: { buffer: kernB } },
            { binding: 4, resource: { buffer: massB } },
            { binding: 5, resource: smp },
            { binding: 6, resource: pv },
            { binding: 7, resource: lv },
            { binding: 8, resource: ev },
          ],
        }),
      );
      drawBg = [0, 1].map((i) =>
        device.createBindGroup({
          layout: drawBgl,
          entries: [
            { binding: 0, resource: { buffer: drawU } },
            { binding: 1, resource: { buffer: bufs[i] } },
            { binding: 2, resource: smp },
            { binding: 3, resource: pv },
          ],
        }),
      );
    };

    const buildKernel = (r: number) => {
      const k: number[] = [];
      let sum = 0;
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          const q = Math.hypot(dx, dy) / r;
          if (q <= 0 || q >= 1) continue;
          const w = Math.exp(4 - 1 / (q * (1 - q)));
          if (w < 1e-4) continue;
          k.push(dx, dy, w, 0);
          sum += w;
        }
      }
      for (let i = 2; i < k.length; i += 4) k[i] /= sum;
      device.queue.writeBuffer(kernB, 0, new Float32Array(k));
      R = r;
      taps = k.length / 4;
    };

    return {
      frame({ enc, out, in: ins, params, audio, time, tick, past, raw, rand, width, height }) {
        const pic = (ins.in as GPUTexture | undefined) ?? dummy;
        const luma = ins.luma as GPUTexture | undefined;
        const edges = ins.edges as GPUTexture | undefined;

        const bps = (audio.bpm > 0 ? audio.bpm : 3600 / TPB) / 60;
        const beats = time * bps;
        const modeP = Math.round(params.mode as number);
        const lenia = modeP === 2
          ? Math.floor(beats / (Math.max(1, Math.round(params.bars as number)) * 4)) % 2 === 1
          : modeP === 1;

        const r = Math.max(3, Math.min(RMAX, Math.round(params.radius as number)));
        if (r !== R) buildKernel(r);

        const h = Math.round(Math.min(360, Math.max(64, params.cells as number)));
        const w = Math.max(32, Math.round((h * width) / height));
        let fresh = false;
        if (w !== W || h !== H) {
          alloc(w, h);
          fresh = true;
        }
        if (pic !== lastPic || luma !== lastLuma || edges !== lastEdges) {
          rebuildGroups(pic, luma, edges);
          lastPic = pic; lastLuma = luma; lastEdges = edges;
        }

        let ticks = tick - lastTick;
        if (fresh || ticks < 0 || ticks > 120) {
          fresh = true;
          ticks = 1;
        }
        const regimeSwitched = wasLenia !== -1 && wasLenia !== (lenia ? 1 : 0);
        ticks = Math.min(ticks, MAX_CATCHUP);
        const prevTick = tick - ticks;
        lastTick = tick;
        wasLenia = lenia ? 1 : 0;

        // Spectral bar-level class picks the Life rule or Lenia mu
        const bar = Math.floor(beats / 4);
        if (bar !== classBar) {
          classBar = bar;
          const b0 = Math.round((bar * 4 / bps) * 60);
          const barT = Math.round((4 / bps) * 60);
          const now = new Float64Array(16);
          const long = new Float64Array(16);
          let tot = 0;
          for (let t = b0 - 4 * barT; t < b0; t += 2) {
            if (t < 0) continue;
            for (let b = 2; b < 14; b++) {
              const v = raw.get(t, b) / 255;
              long[b] += v;
              if (t >= b0 - barT) { now[b] += v; tot += v; }
            }
          }
          cls = Math.abs(bar) % RULES.length;
          if (tot > barT * 0.25) {
            let best = -Infinity;
            for (let b = 2; b < 14; b++) {
              const s = now[b] / (long[b] / 4 + 1e-3);
              if (s > best) { best = s; cls = b - 2; }
            }
          }
        }
        const rule = RULES[cls % RULES.length];
        const mu = LENIA_MU[cls % LENIA_MU.length];

        const react = params.react as number;
        let energy = 0;
        for (let ago = 0; ago < 90; ago += 3) energy += past(ago).rms / 30;
        const bass = (audio.bands[0] + audio.bands[1] + audio.bands[2]) / 3;
        const highs = (audio.bands[10] + audio.bands[11] + audio.bands[12] + audio.bands[13]) / 4;
        let kick = 0;
        for (let ago = 0; ago < 24; ago++) {
          if (past(ago).onset) { kick = Math.exp(-ago / 6.5); break; }
        }
        const beatEnv = Math.exp(-audio.phase * 4.5);

        // Seed discs stamped on onsets, beats, and periodic silence keeper
        const seeds: number[] = [];
        for (let t = prevTick + 1; t <= tick && seeds.length < MAX_SEEDS * 4; t++) {
          const a = past(tick - t);
          if (a.onset) {
            const bLvl = (a.bands[0] + a.bands[1]) * 0.5;
            const rad = lenia
              ? R * (1.2 + 1.5 * rand(t, 2))
              : (6 + 14 * rand(t, 2)) * (0.7 + 0.6 * react);
            seeds.push(rand(t, 0) * W, rand(t, 1) * H, rad, 0.75 + 0.25 * bLvl);
          }
          if (t % 75 === 0) {
            seeds.push(rand(t, 3) * W, rand(t, 4) * H, lenia ? R * 1.4 : 8, 0.85);
          }
          if (a.rms > 0.04 && Math.floor((t * bps) / 60) !== Math.floor(((t - 1) * bps) / 60)) {
            seeds.push(
              rand(t, 5) * W,
              rand(t, 6) * H,
              lenia ? R * (1.0 + 1.4 * a.rms) : 5 + 14 * a.rms,
              0.7 + 0.3 * a.rms,
            );
          }
        }
        const nseed = Math.min(MAX_SEEDS, seeds.length / 4);

        const rate = Math.max(1, (params.rate as number) * (0.75 + 0.5 * audio.rms * react));
        const lifeSteps = Math.floor((tick * rate * bps) / 60) - Math.floor((prevTick * rate * bps) / 60);
        const steps = lenia ? ticks : Math.min(MAX_CATCHUP, Math.max(lifeSteps, kick > 0.85 ? 1 : 0));

        const decayP = params.decay as number;
        const edgeSeed = (params.edge_seed as number) * (0.55 + 0.9 * react * (beatEnv * 0.65 + kick * 0.8 + highs * 0.4));
        const lumaSeed = (params.luma_seed as number) * (0.45 + 0.95 * react * (beatEnv * 0.6 + kick * 0.7 + bass * 0.5));
        const mediaPull = params.media_pull as number;

        su.fill(0);
        su.set([
          W, H, nseed, taps,
          bitmask(rule[0]), bitmask(rule[1]), Math.imul(tick, 2654435761) >>> 0, regimeSwitched ? 1 : 0,
        ], 0);
        sf.set([
          mu, mu * LENIA_SIGMA, (params.dt as number) * (0.8 + 0.75 * audio.rms * react), lenia ? Math.min(0.97, decayP + 0.08) : decayP,
          edgeSeed, lumaSeed, mediaPull, lenia ? 1 : 0,
          0.1 + 0.34 * Math.min(1, energy * react), 4.2, luma ? 1 : 0, edges ? 1 : 0,
          (0.0012 + 0.0038 * bass * react) * ticks, 0.35 + 1.2 * bass * react, beatEnv, kick,
          0.08 + 0.25 * beatEnv, highs, 0, 0,
        ], 8);
        // Offset 28 floats = 112 bytes: seeds array (8 x vec4f)
        for (let i = 0; i < nseed * 4; i++) sf[28 + i] = seeds[i];
        device.queue.writeBuffer(simU, 0, simData);

        const gx = Math.ceil(W / 16);
        const gy = Math.ceil(H / 16);

        if (fresh) {
          const ip = enc.beginComputePass({ label: 'agy-media-life init' });
          ip.setPipeline(initP);
          ip.setBindGroup(0, simBg[cur]);
          ip.dispatchWorkgroups(gx, gy);
          ip.end();
          cur = 1 - cur;
        }

        const runSeedAndStep = enc.beginComputePass({ label: 'agy-media-life sim' });
        runSeedAndStep.setPipeline(seedP);
        runSeedAndStep.setBindGroup(0, simBg[cur]);
        runSeedAndStep.dispatchWorkgroups(gx, gy);
        cur = 1 - cur;
        runSeedAndStep.end();

        if (steps > 0) {
          if (lenia) {
            enc.clearBuffer(massB);
            const mp = enc.beginComputePass({ label: 'agy-media-life mass' });
            mp.setPipeline(massP);
            mp.setBindGroup(0, simBg[cur]);
            mp.dispatchWorkgroups(gx, gy);
            mp.end();
          }
          const sp = enc.beginComputePass({ label: 'agy-media-life step' });
          sp.setPipeline(lenia ? leniaP : lifeP);
          for (let s = 0; s < steps; s++) {
            sp.setBindGroup(0, simBg[cur]);
            sp.dispatchWorkgroups(gx, gy);
            cur = 1 - cur;
          }
          sp.end();
        }

        const pal = (ins.palette as Palette | undefined)?.stops ??
          Array.from({ length: 6 }, (_, i) => oklch(0.22 + i * 0.14, 0.16, audio.pal + i / 8));
        df.fill(0);
        df.set([
          W, H, Math.min(8, pal.length), params.glow as number,
          kick * (params.flash as number), audio.rms, (time * bps) / 16, params.relief as number,
          lenia ? 1 : 0, params.gap as number, params.under as number, params.pal_mix as number,
          params.colour as number, params.dither as number, beatEnv, bass * react,
        ], 0);
        pal.slice(0, 8).forEach((st, i) => df.set(st, 16 + i * 4));
        device.queue.writeBuffer(drawU, 0, df);

        const rp = enc.beginRenderPass({
          colorAttachments: [{ view: out.out.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }],
        });
        rp.setPipeline(drawPipe);
        rp.setBindGroup(0, drawBg[cur]);
        rp.draw(3);
        rp.end();
      },
      dispose: () => {
        for (const b of bufs) b.destroy();
        simU.destroy(); drawU.destroy(); kernB.destroy(); massB.destroy(); dummy.destroy();
      },
      status: () => `${W}x${H} ${wasLenia ? 'Lenia' : 'Life'}`,
    };
  },
});
