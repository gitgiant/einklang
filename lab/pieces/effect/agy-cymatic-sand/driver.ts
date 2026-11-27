import { definePiece, oklch, type GpuCtx, type Palette } from '../../../api/index.ts';

// GPU particle Chladni & cymatic sand simulation coupled to the picked media.
// Dominant musical pitch (MIDI note or spectral peak/centroid) selects standing-wave eigenmodes;
// sand grains inherit the picture's colours, gather along both Chladni nodal lines and media
// edge contours, jolt on onsets, and re-form the live picture at phrase turns.

const MODES: readonly [number, number, number][] = [
  [1, 2, 1],
  [2, 3, -1],
  [1, 4, 1],
  [3, 4, -1],
  [2, 5, 1],
  [3, 5, -1],
  [4, 5, 1],
  [2, 6, -1],
  [3, 7, 1],
  [5, 6, -1],
  [4, 7, 1],
  [5, 8, -1],
];

const HOLD = 42;
const SIM_BYTES = 128;
const DRAW_BYTES = 240;
const MAX_CATCHUP = 3;

function pickPitchMode(past: GpuCtx['past'], age: number): { idx: number; norm: number } {
  for (let i = 0; i < 90; i++) {
    const n = past(age + i).note;
    if (n >= 0) {
      const idx = ((n % MODES.length) + MODES.length) % MODES.length;
      return { idx, norm: (((n - 36) % 36) + 36) % 36 / 36 };
    }
  }
  const bands = new Float32Array(16);
  for (let lag = 0; lag < 18; lag += 3) {
    const f = past(age + lag);
    for (let b = 0; b < 16; b++) bands[b] += f.bands[b];
  }
  let peak = 0;
  let wSum = 0;
  let cSum = 0;
  for (let b = 0; b < 16; b++) {
    if (bands[b] > bands[peak]) peak = b;
    wSum += bands[b];
    cSum += bands[b] * (b / 15);
  }
  if (bands[peak] < 0.12) return { idx: 0, norm: 0.25 };
  const idx = (peak * 5 + Math.round((cSum / Math.max(wSum, 1e-4)) * 7)) % MODES.length;
  return { idx, norm: cSum / Math.max(wSum, 1e-4) };
}

export default definePiece({
  gpu: ({ device, shader, formats }) => {
    const simMod = shader('sim.wgsl');
    const drawMod = shader('draw.wgsl');
    const C = GPUShaderStage.COMPUTE;
    const VF = GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT;

    const simBgl = device.createBindGroupLayout({
      label: 'agy-cymatic-sand sim bgl',
      entries: [
        { binding: 0, visibility: C, buffer: { type: 'uniform' } },
        { binding: 1, visibility: C, buffer: { type: 'storage' } },
        { binding: 2, visibility: C, sampler: { type: 'filtering' } },
        { binding: 3, visibility: C, texture: { sampleType: 'float' } },
        { binding: 4, visibility: C, texture: { sampleType: 'float' } },
        { binding: 5, visibility: C, texture: { sampleType: 'float' } },
      ],
    });

    const drawBgl = device.createBindGroupLayout({
      label: 'agy-cymatic-sand draw bgl',
      entries: [
        { binding: 0, visibility: VF, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
        { binding: 2, visibility: VF, sampler: { type: 'filtering' } },
        { binding: 3, visibility: VF, texture: { sampleType: 'float' } },
        { binding: 4, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 5, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
      ],
    });

    const simLayout = device.createPipelineLayout({ bindGroupLayouts: [simBgl] });
    const drawLayout = device.createPipelineLayout({ bindGroupLayouts: [drawBgl] });
    const initP = device.createComputePipeline({
      label: 'agy-cymatic-sand init',
      layout: simLayout,
      compute: { module: simMod, entryPoint: 'cs_init' },
    });
    const stepP = device.createComputePipeline({
      label: 'agy-cymatic-sand step',
      layout: simLayout,
      compute: { module: simMod, entryPoint: 'cs_step' },
    });

    const add = { srcFactor: 'one', dstFactor: 'one', operation: 'add' } as const;
    const grainP = device.createRenderPipeline({
      label: 'agy-cymatic-sand grains',
      layout: drawLayout,
      vertex: { module: drawMod, entryPoint: 'vs_grain' },
      fragment: { module: drawMod, entryPoint: 'fs_grain', targets: [{ format: formats.tex, blend: { color: add, alpha: add } }] },
    });
    const resolveP = device.createRenderPipeline({
      label: 'agy-cymatic-sand resolve',
      layout: drawLayout,
      vertex: { module: drawMod, entryPoint: 'vs_full' },
      fragment: { module: drawMod, entryPoint: 'fs_resolve', targets: [{ format: formats.tex }] },
    });

    const smp = device.createSampler({
      magFilter: 'linear',
      minFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
    });
    const dummy = device.createTexture({
      label: 'agy-cymatic-sand dummy',
      size: [1, 1],
      format: formats.tex,
      usage: GPUTextureUsage.TEXTURE_BINDING,
    });
    const simU = device.createBuffer({
      label: 'agy-cymatic-sand sim u',
      size: SIM_BYTES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    const drawU = device.createBuffer({
      label: 'agy-cymatic-sand draw u',
      size: DRAW_BYTES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    const simData = new ArrayBuffer(SIM_BYTES);
    const su = new Uint32Array(simData);
    const sf = new Float32Array(simData);
    const df = new Float32Array(DRAW_BYTES / 4);

    let N = 0;
    let AW = 0;
    let AH = 0;
    let lastTick = -Infinity;
    let grainsB: GPUBuffer | null = null;
    let accTex: GPUTexture | null = null;
    let simBg: GPUBindGroup | null = null;
    let grainBg: GPUBindGroup | null = null;
    let resolveBg: GPUBindGroup | null = null;
    let lastPic: unknown = null;
    let lastLuma: unknown = null;
    let lastEdges: unknown = null;

    const allocGrains = (n: number) => {
      grainsB?.destroy();
      N = n;
      lastPic = null;
      grainsB = device.createBuffer({
        label: 'agy-cymatic-sand grains',
        size: n * 32,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      });
    };

    return {
      frame({ enc, out, in: ins, params, audio, time, tick, past, width, height }) {
        const aspect = width / height;
        const n = Math.round(Math.min(160, Math.max(24, params.count as number)) * 1000);
        let fresh = false;
        if (n !== N) {
          allocGrains(n);
          fresh = true;
        }
        if (!accTex || AW !== width || AH !== height) {
          accTex?.destroy();
          AW = width;
          AH = height;
          lastPic = null;
          accTex = device.createTexture({
            label: 'agy-cymatic-sand acc',
            size: [width, height],
            format: formats.tex,
            usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT,
          });
        }

        const pic = ins.in as GPUTexture;
        const luma = ins.luma as GPUTexture | undefined;
        const edges = ins.edges as GPUTexture | undefined;
        if (pic !== lastPic || luma !== lastLuma || edges !== lastEdges) {
          lastPic = pic;
          lastLuma = luma;
          lastEdges = edges;
          const pv = pic.createView();
          const lv = (luma ?? dummy).createView();
          const ev = (edges ?? dummy).createView();
          simBg = device.createBindGroup({
            layout: simBgl,
            entries: [
              { binding: 0, resource: { buffer: simU } },
              { binding: 1, resource: { buffer: grainsB! } },
              { binding: 2, resource: smp },
              { binding: 3, resource: pv },
              { binding: 4, resource: lv },
              { binding: 5, resource: ev },
            ],
          });
          const mkDrawBg = (aTex: GPUTexture) =>
            device.createBindGroup({
              layout: drawBgl,
              entries: [
                { binding: 0, resource: { buffer: drawU } },
                { binding: 1, resource: { buffer: grainsB! } },
                { binding: 2, resource: smp },
                { binding: 3, resource: pv },
                { binding: 4, resource: aTex.createView() },
                { binding: 5, resource: ev },
              ],
            });
          grainBg = mkDrawBg(dummy);
          resolveBg = mkDrawBg(accTex);
        }

        let ticks = tick - lastTick;
        if (fresh || ticks < 0 || ticks > 120) {
          ticks = 1;
          fresh = true;
        }
        ticks = Math.min(ticks, MAX_CATCHUP);
        lastTick = tick;

        // Smoothed audio bands & onset envelope
        const bandAvg = (lo: number, hi: number, f = audio) => {
          let s = 0;
          for (let b = lo; b <= hi; b++) s += f.bands[b];
          return s / (hi - lo + 1);
        };
        let bass = 0;
        let mid = 0;
        let hi = 0;
        for (let ago = 0; ago < 5; ago++) {
          const f = past(ago);
          bass += bandAvg(0, 2, f) / 5;
          mid += bandAvg(4, 9, f) / 5;
          hi += bandAvg(10, 15, f) / 5;
        }
        let kick = 0;
        let onsetAgo = -1;
        for (let ago = 0; ago < 22; ago++) {
          if (past(ago).onset) {
            kick = Math.max(kick, Math.exp(-ago / 6.5));
            if (onsetAgo < 0) onsetAgo = ago;
          }
        }
        const joltHit = onsetAgo >= 0 && onsetAgo < ticks ? 1 : 0;

        // Pitch-selected Chladni eigenmode pair with smooth morphing
        const age = ((tick % HOLD) + HOLD) % HOLD;
        const curPick = pickPitchMode(past, age);
        const prevPick = pickPitchMode(past, age + HOLD);
        const mPrev = MODES[prevPick.idx];
        const mCur = MODES[curPick.idx];
        const morphT = curPick.idx === prevPick.idx ? 1 : Math.min(1, age / (HOLD * 0.65));
        const morph = morphT * morphT * (3 - 2 * morphT);

        // Phrase re-formation window
        const phrasePhase = (audio.bar + audio.phase) / 4;
        const distPhrase = Math.min(phrasePhase, 1 - phrasePhase);
        const reformEnv = (params.reform as number) * Math.exp(-((distPhrase / 0.09) ** 2));

        const beatEnv = Math.exp(-audio.phase * 4.2);
        const mode = Math.round(params.mode as number) & 3;
        const rot = time * 0.24 + bass * 0.55;
        const seed = Math.imul(tick + 17, 2654435761) >>> 0;

        sf.fill(0);
        su.set([N, mode, seed, joltHit], 0);
        sf.set([aspect, 1 / 60, time, reformEnv], 4);
        sf.set([bass, mid, hi, audio.rms], 8);
        sf.set([kick, beatEnv, params.react as number, params.chladni as number], 12);
        sf.set([params.edge_pull as number, params.luma_warp as number, params.vibrate as number, params.jolt as number], 16);
        sf.set([mPrev[0], mPrev[1], mPrev[2], morph], 20);
        sf.set([mCur[0], mCur[1], mCur[2], curPick.norm], 24);
        sf.set([luma ? 1 : 0, edges ? 1 : 0, rot, 0], 28);
        device.queue.writeBuffer(simU, 0, simData);

        const groups = Math.ceil(N / 256);
        const cp = enc.beginComputePass({ label: 'agy-cymatic-sand sim' });
        cp.setBindGroup(0, simBg!);
        if (fresh) {
          cp.setPipeline(initP);
          cp.dispatchWorkgroups(groups);
        }
        cp.setPipeline(stepP);
        for (let t = 0; t < ticks; t++) {
          cp.dispatchWorkgroups(groups);
        }
        cp.end();

        // Draw uniforms & palette
        const pal =
          (ins.palette as Palette | undefined)?.stops ??
          Array.from({ length: 6 }, (_, i) => oklch(0.32 + i * 0.12, 0.15, audio.pal + 0.12 + i * 0.08));

        const size = (params.size as number) * (height / 1080);
        const area = Math.max(1, size * size * 2.8);
        const gain = Math.min(1.6, ((width * height) / (N * area)) * 0.72);

        df.fill(0);
        df.set([width, height, aspect, Math.max(0.8, size)], 0);
        df.set([params.streak as number, gain, kick, beatEnv], 4);
        df.set([bass, mid, hi, audio.rms], 8);
        df.set([params.under as number, params.pal_mix as number, Math.min(8, pal.length), (time * 0.05) % 1], 12);
        df.set([reformEnv, params.glow as number, params.react as number, mode], 16);
        df.set([mCur[0], mCur[1], mCur[2], rot], 20);
        df.set([luma ? 1 : 0, edges ? 1 : 0, time, 0], 24);
        pal.slice(0, 8).forEach((st, i) => df.set(st, 28 + i * 4));
        device.queue.writeBuffer(drawU, 0, df);

        const rp1 = enc.beginRenderPass({
          label: 'agy-cymatic-sand splat',
          colorAttachments: [{ view: accTex.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 0] }],
        });
        rp1.setPipeline(grainP);
        rp1.setBindGroup(0, grainBg!);
        rp1.draw(6, N);
        rp1.end();

        const rp2 = enc.beginRenderPass({
          label: 'agy-cymatic-sand resolve',
          colorAttachments: [{ view: out.out.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }],
        });
        rp2.setPipeline(resolveP);
        rp2.setBindGroup(0, resolveBg!);
        rp2.draw(3);
        rp2.end();
      },
      dispose() {
        grainsB?.destroy();
        accTex?.destroy();
        simU.destroy();
        drawU.destroy();
        dummy.destroy();
      },
    };
  },
});
