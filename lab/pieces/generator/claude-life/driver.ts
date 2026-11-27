import { definePiece, oklch, type Palette } from '../../../api/index.ts';

// Cellular automata: Life-like rules or Lenia (continuous) on a toroidal grid. GPU state (not synced): two
// storage buffers of vec4f per cell, ping-ponged.
//   Life steps `rate` times per beat; Lenia steps every tick (faster and a little bigger growth when loud).
//   Rules: every bar, the band that rose most over its own 4-bar average in the bar before (a coarse "pitch
//   class": the feature stream has 16 bands, no chroma) picks the Life rule, or Lenia's growth centre/width.
//   Onsets (kicks, snares) stamp random soup discs; a small one every 1.5 s keeps silence alive.
//   Colour by age: newborns at the bright end of the palette, cooling with age; dead cells leave an afterglow.

/** Life-like rules as [birth, survive] neighbour counts. */
const RULES: [number[], number[]][] = [
  [[3], [2, 3]], // Conway
  [[3, 6], [2, 3]], // HighLife
  [[3, 6, 8], [2, 4, 5]], // Morley
  [[3, 6], [1, 2, 5]], // 2x2
  [[3, 6, 7, 8], [3, 4, 6, 7, 8]], // Day & Night
  [[3, 5, 7], [1, 3, 5, 8]], // Amoeba
];
const mask = (ns: number[]) => ns.reduce((m, n) => m | (1 << n), 0);
/** Lenia growth centre / width per class (single-ring bump kernel). */
const LENIA: [number, number][] = [[0.15, 0.017], [0.15, 0.02], [0.13, 0.02], [0.17, 0.022], [0.12, 0.018], [0.18, 0.027]];

const SIM_BYTES = 64 + 8 * 16, DRAW_BYTES = 48 + 8 * 16, MAX_SEEDS = 8, MAX_CATCHUP = 4, RMAX = 12, TPB = 28;

export default definePiece({
  gpu: ({ device, shader }) => {
    const simMod = shader('sim.wgsl'), drawMod = shader('draw.wgsl');
    const bgl = device.createBindGroupLayout({
      label: 'claude-life sim',
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
        { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
      ],
    });
    const layout = device.createPipelineLayout({ bindGroupLayouts: [bgl] });
    const cp = (entryPoint: string) => device.createComputePipeline({ label: `claude-life ${entryPoint}`, layout, compute: { module: simMod, entryPoint } });
    const seedP = cp('cs_seed'), lifeP = cp('cs_life'), leniaP = cp('cs_lenia');
    const draw = device.createRenderPipeline({
      label: 'claude-life draw', layout: 'auto',
      vertex: { module: drawMod, entryPoint: 'vs_full' },
      fragment: { module: drawMod, entryPoint: 'fs_draw', targets: [{ format: 'rgba16float' }] },
    });
    const simU = device.createBuffer({ label: 'claude-life sim u', size: SIM_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const drawU = device.createBuffer({ label: 'claude-life draw u', size: DRAW_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const kernB = device.createBuffer({ label: 'claude-life kernel', size: (2 * RMAX + 1) ** 2 * 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    const simData = new ArrayBuffer(SIM_BYTES), su = new Uint32Array(simData), sf = new Float32Array(simData);
    const df = new Float32Array(DRAW_BYTES / 4);

    let W = 0, H = 0, cur = 0, lastTick = -Infinity, R = 0, taps = 0, wasLenia = -1;
    let bufs: GPUBuffer[] = [], simBg: GPUBindGroup[] = [], drawBg: GPUBindGroup[] = [];
    let classBar = -1, cls = 0;

    const alloc = (w: number, h: number) => {
      for (const b of bufs) b.destroy();
      W = w; H = h; cur = 0;
      bufs = [0, 1].map((i) => device.createBuffer({ label: `claude-life cells ${i}`, size: w * h * 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST }));
      simBg = [0, 1].map((i) => device.createBindGroup({
        layout: bgl,
        entries: [{ binding: 0, resource: { buffer: simU } }, { binding: 1, resource: { buffer: bufs[i] } }, { binding: 2, resource: { buffer: bufs[1 - i] } }, { binding: 3, resource: { buffer: kernB } }],
      }));
      drawBg = [0, 1].map((i) => device.createBindGroup({
        layout: draw.getBindGroupLayout(0),
        entries: [{ binding: 0, resource: { buffer: drawU } }, { binding: 1, resource: { buffer: bufs[i] } }],
      }));
    };

    /** Lenia's single-ring bump kernel, normalized to sum 1: (dx, dy, weight, 0) for every non-zero tap. */
    const kernel = (r: number) => {
      const k: number[] = [];
      let sum = 0;
      for (let dy = -r; dy <= r; dy++)
        for (let dx = -r; dx <= r; dx++) {
          const q = Math.hypot(dx, dy) / r;
          if (q <= 0 || q >= 1) continue;
          const w = Math.exp(4 - 1 / (q * (1 - q)));
          if (w < 1e-4) continue;
          k.push(dx, dy, w, 0); sum += w;
        }
      for (let i = 2; i < k.length; i += 4) k[i] /= sum;
      device.queue.writeBuffer(kernB, 0, new Float32Array(k));
      R = r; taps = k.length / 4;
    };

    /** Fresh board: sparse random soup (Life) or a scatter of noise blobs (Lenia), the same on every host. */
    const reset = (rand: (a: number, b?: number) => number, seed: number, lenia: boolean) => {
      const cells = new Float32Array(W * H * 4);
      if (!lenia) {
        for (let i = 0; i < W * H; i++) if (rand(seed, i) < 0.18) cells.set([1, 0, 1, 0], i * 4);
      } else {
        for (let s = 0; s < 24; s++) {
          const cx = rand(seed, s * 3) * W, cy = rand(seed, s * 3 + 1) * H, r = R * (0.8 + rand(seed, s * 3 + 2));
          for (let y = Math.floor(cy - r); y < cy + r; y++)
            for (let x = Math.floor(cx - r); x < cx + r; x++) {
              if (Math.hypot(x - cx, y - cy) >= r) continue;
              const i = ((y % H + H) % H) * W + ((x % W + W) % W);
              const v = rand(seed + 7, i);
              cells.set([v, 0, v, 0], i * 4);
            }
        }
      }
      device.queue.writeBuffer(bufs[0], 0, cells);
      cur = 0;
    };

    return {
      frame({ enc, out, in: ins, params, audio, time, tick, past, raw, rand, width, height }) {
        const bps = (audio.bpm > 0 ? audio.bpm : 3600 / TPB) / 60;
        const beats = time * bps;
        const modeP = params.mode as number;
        const lenia = modeP === 2 ? Math.floor(beats / (Math.max(1, params.bars as number) * 4)) % 2 === 1 : modeP === 1;
        const r = Math.max(3, Math.min(RMAX, Math.round(params.radius as number)));
        if (r !== R) kernel(r);
        const h = Math.round(Math.min(540, Math.max(40, params.cells as number))), w = Math.max(16, Math.round((h * width) / height));
        let fresh = false;
        if (w !== W || h !== H) { alloc(w, h); fresh = true; }
        let ticks = tick - lastTick;
        if (fresh || ticks < 0 || ticks > 120) { reset(rand, tick, lenia); ticks = 1; }
        ticks = Math.min(ticks, MAX_CATCHUP);
        const prevTick = tick - ticks;
        lastTick = tick;
        wasLenia = lenia ? 1 : 0;

        // the bar's "pitch class": the band (2..13) that rose most over its own 4-bar mean in the previous bar
        const bar = Math.floor(beats / 4);
        if (bar !== classBar) {
          classBar = bar;
          const b0 = Math.round((bar * 4 / bps) * 60), barT = Math.round((4 / bps) * 60);
          const now = new Float64Array(16), long = new Float64Array(16);
          let tot = 0;
          for (let t = b0 - 4 * barT; t < b0; t += 2) {
            if (t < 0) continue;
            for (let b = 2; b < 14; b++) { const v = raw.get(t, b) / 255; long[b] += v; if (t >= b0 - barT) { now[b] += v; tot += v; } }
          }
          cls = 0;
          if (tot > barT * 0.3) {
            let best = -Infinity;
            for (let b = 2; b < 14; b++) { const s = now[b] / (long[b] / 4 + 1e-3); if (s > best) { best = s; cls = b - 2; } }
          }
        }
        const rule = RULES[cls % RULES.length], [mu0, sigma] = LENIA[cls % LENIA.length];

        const bass = (audio.bands[0] + audio.bands[1] + audio.bands[2]) / 3;
        let kick = 0;
        for (let ago = 0; ago < 24; ago++) if (past(ago).onset) { kick = Math.exp(-ago / 6); break; }

        // seeds: each onset since the last frame stamps a disc of soup; a small one every 90 ticks
        const seeds: number[] = [];
        const amt = params.seeds as number;
        for (let t = prevTick + 1; t <= tick && seeds.length < MAX_SEEDS * 4; t++) {
          const a = past(tick - t);
          if (amt > 0 && a.onset) {
            const rad = lenia ? R * (1 + 1.2 * rand(t, 2)) * Math.min(1.5, amt) : (4 + 10 * rand(t, 2)) * amt;
            seeds.push(rand(t, 0) * W, rand(t, 1) * H, rad, 0.7 + 0.3 * (a.bands[0] + a.bands[1]) / 2);
          }
          if (t % 90 === 0) seeds.push(rand(t, 3) * W, rand(t, 4) * H, lenia ? R * 1.2 : 5, 1);
        }
        const nseed = Math.min(MAX_SEEDS, seeds.length / 4);

        // steps this frame: Life on the beat grid, Lenia per tick
        const rate = Math.max(0.25, params.rate as number);
        const lifeSteps = Math.floor((tick * rate * bps) / 60) - Math.floor((prevTick * rate * bps) / 60);
        const steps = lenia ? Math.max(1, Math.round(params.steps as number)) * ticks : Math.min(MAX_CATCHUP, lifeSteps);
        const drive = params.drive as number;
        su.set([W, H, nseed, taps, mask(rule[0]), mask(rule[1]), Math.imul(tick, 2654435761) >>> 0, 0], 0);
        sf.set([
          mu0 + drive * 0.012 * (bass - 0.35), sigma, (params.dt as number) * (0.8 + 0.8 * audio.rms * drive), lenia ? 0.96 : 0.7,
          lenia ? (params.drift as number) * (0.4 + 1.6 * bass) * ticks : 0, lenia ? (params.swirl as number) * ticks : 0, 0.5, lenia ? 1 : 0,
        ], 8);
        sf.fill(0, 16);
        sf.set(seeds.slice(0, nseed * 4), 16);
        device.queue.writeBuffer(simU, 0, simData);

        const gx = Math.ceil(W / 16), gy = Math.ceil(H / 16);
        const pass = enc.beginComputePass({ label: 'claude-life' });
        if (nseed > 0 || lenia) { pass.setPipeline(seedP); pass.setBindGroup(0, simBg[cur]); pass.dispatchWorkgroups(gx, gy); cur = 1 - cur; }
        pass.setPipeline(lenia ? leniaP : lifeP);
        for (let i = 0; i < steps; i++) { pass.setBindGroup(0, simBg[cur]); pass.dispatchWorkgroups(gx, gy); cur = 1 - cur; }
        pass.end();

        const pal = (ins.palette as Palette | undefined)?.stops ?? Array.from({ length: 6 }, (_, i) => oklch(0.3 + i * 0.12, 0.14, audio.pal + 0.1 + i / 8));
        df.fill(0);
        df.set([W, H, Math.min(8, pal.length), params.glow as number, kick, audio.rms, (beats / 16) * (params.cycle as number), params.relief as number], 0);
        df.set([lenia ? 1 : 0, params.gap as number, (params.age as number) * (lenia ? 80 : 10), params.trail as number], 8);
        pal.slice(0, 8).forEach((s, i) => df.set(s, 12 + i * 4));
        device.queue.writeBuffer(drawU, 0, df);
        const rp = enc.beginRenderPass({ colorAttachments: [{ view: out.out.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }] });
        rp.setPipeline(draw); rp.setBindGroup(0, drawBg[cur]); rp.draw(3); rp.end();
      },
      dispose: () => { for (const b of bufs) b.destroy(); simU.destroy(); drawU.destroy(); kernB.destroy(); },
      status: () => `${W}x${H} ${wasLenia ? `lenia R${R}` : 'life'}, class ${cls}`,
    };
  },
});
