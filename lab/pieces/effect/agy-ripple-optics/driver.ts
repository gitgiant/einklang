import { definePiece, oklch, type Palette } from '../../../api/index.ts';

// GPU 2D shallow-water wave tank + optical caustics & 7-band chromatic prism lens simulation.
// Media luma sets wave depth/speed, media edges reflect waves & emit contour ripples,
// onsets drop pebbles, bass pumps standing swells, highs widen spectral prism dispersion,
// and phrase boundaries smoothly settle the glass so the picture re-forms cleanly.

const SIM_BYTES = 224;
const DRAW_BYTES = 224;
const MAX_DROPS = 8;
const MAX_CATCHUP = 3;

export default definePiece({
  gpu: ({ device, shader, formats }) => {
    const simMod = shader('sim.wgsl');
    const drawMod = shader('draw.wgsl');
    const C = GPUShaderStage.COMPUTE;
    const F = GPUShaderStage.FRAGMENT;

    const simBgl = device.createBindGroupLayout({
      label: 'agy-ripple-optics sim bgl',
      entries: [
        { binding: 0, visibility: C, buffer: { type: 'uniform' } },
        { binding: 1, visibility: C, buffer: { type: 'read-only-storage' } },
        { binding: 2, visibility: C, buffer: { type: 'storage' } },
        { binding: 3, visibility: C, sampler: { type: 'filtering' } },
        { binding: 4, visibility: C, texture: { sampleType: 'float' } },
        { binding: 5, visibility: C, texture: { sampleType: 'float' } },
        { binding: 6, visibility: C, texture: { sampleType: 'float' } },
      ],
    });

    const drawBgl = device.createBindGroupLayout({
      label: 'agy-ripple-optics draw bgl',
      entries: [
        { binding: 0, visibility: F, buffer: { type: 'uniform' } },
        { binding: 1, visibility: F, buffer: { type: 'read-only-storage' } },
        { binding: 2, visibility: F, sampler: { type: 'filtering' } },
        { binding: 3, visibility: F, texture: { sampleType: 'float' } },
        { binding: 4, visibility: F, texture: { sampleType: 'float' } },
        { binding: 5, visibility: F, texture: { sampleType: 'float' } },
      ],
    });

    const simLayout = device.createPipelineLayout({ bindGroupLayouts: [simBgl] });
    const initP = device.createComputePipeline({
      label: 'agy-ripple-optics init',
      layout: simLayout,
      compute: { module: simMod, entryPoint: 'cs_init' },
    });
    const stepP = device.createComputePipeline({
      label: 'agy-ripple-optics step',
      layout: simLayout,
      compute: { module: simMod, entryPoint: 'cs_step' },
    });
    const drawPipe = device.createRenderPipeline({
      label: 'agy-ripple-optics draw',
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
      label: 'agy-ripple-optics dummy',
      size: [1, 1],
      format: formats.tex,
      usage: GPUTextureUsage.TEXTURE_BINDING,
    });
    const simU0 = device.createBuffer({
      label: 'agy-ripple-optics sim u drop',
      size: SIM_BYTES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    const simU1 = device.createBuffer({
      label: 'agy-ripple-optics sim u step',
      size: SIM_BYTES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    const drawU = device.createBuffer({
      label: 'agy-ripple-optics draw u',
      size: DRAW_BYTES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    const simData0 = new ArrayBuffer(SIM_BYTES);
    const su0 = new Uint32Array(simData0);
    const sf0 = new Float32Array(simData0);
    const simData1 = new ArrayBuffer(SIM_BYTES);
    const su1 = new Uint32Array(simData1);
    const sf1 = new Float32Array(simData1);
    const df = new Float32Array(DRAW_BYTES / 4);

    let W = 0;
    let H = 0;
    let cur = 0;
    let lastTick = -Infinity;
    let lastBeatIdx = -1;
    let bufs: GPUBuffer[] = [];
    let simBgDrop: GPUBindGroup[] = [];
    let simBgStep: GPUBindGroup[] = [];
    let drawBg: GPUBindGroup[] = [];
    let lastPic: unknown = null;
    let lastLuma: unknown = null;
    let lastEdges: unknown = null;

    const alloc = (w: number, h: number) => {
      for (const b of bufs) b.destroy();
      W = w;
      H = h;
      cur = 0;
      lastPic = lastLuma = lastEdges = null;
      bufs = [0, 1].map((i) =>
        device.createBuffer({
          label: `agy-ripple-optics cells ${i}`,
          size: w * h * 16,
          usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        }),
      );
    };

    const rebuildGroups = (pic: GPUTexture, luma?: GPUTexture, edges?: GPUTexture) => {
      const pv = pic.createView();
      const lv = (luma ?? dummy).createView();
      const ev = (edges ?? dummy).createView();
      const mkSimBg = (uBuf: GPUBuffer) =>
        [0, 1].map((i) =>
          device.createBindGroup({
            layout: simBgl,
            entries: [
              { binding: 0, resource: { buffer: uBuf } },
              { binding: 1, resource: { buffer: bufs[i] } },
              { binding: 2, resource: { buffer: bufs[1 - i] } },
              { binding: 3, resource: smp },
              { binding: 4, resource: pv },
              { binding: 5, resource: lv },
              { binding: 6, resource: ev },
            ],
          }),
        );
      simBgDrop = mkSimBg(simU0);
      simBgStep = mkSimBg(simU1);
      drawBg = [0, 1].map((i) =>
        device.createBindGroup({
          layout: drawBgl,
          entries: [
            { binding: 0, resource: { buffer: drawU } },
            { binding: 1, resource: { buffer: bufs[i] } },
            { binding: 2, resource: smp },
            { binding: 3, resource: pv },
            { binding: 4, resource: lv },
            { binding: 5, resource: ev },
          ],
        }),
      );
    };

    return {
      frame({ enc, out, in: ins, params, audio, time, tick, past, rand, width, height }) {
        const aspect = width / height;
        const gh = Math.round(Math.min(260, Math.max(96, params.cells as number)));
        const gw = Math.max(16, Math.round(gh * aspect));
        let fresh = false;
        if (gw !== W || gh !== H) {
          alloc(gw, gh);
          fresh = true;
        }

        const pic = ins.in as GPUTexture;
        const luma = ins.luma as GPUTexture | undefined;
        const edges = ins.edges as GPUTexture | undefined;
        if (pic !== lastPic || luma !== lastLuma || edges !== lastEdges) {
          lastPic = pic;
          lastLuma = luma;
          lastEdges = edges;
          rebuildGroups(pic, luma, edges);
        }

        let ticks = tick - lastTick;
        if (fresh || ticks < 0 || ticks > 120) {
          ticks = 1;
          fresh = true;
          lastBeatIdx = -1;
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

        // Dominant pitch / spectral centroid (0..1)
        let pitchNorm = 0.35;
        let foundNote = false;
        for (let ago = 0; ago < 45; ago++) {
          const n = past(ago).note;
          if (n >= 0) {
            pitchNorm = ((n - 36) % 36 + 36) % 36 / 36;
            foundNote = true;
            break;
          }
        }
        if (!foundNote) {
          let wSum = 0;
          let idxSum = 0;
          for (let b = 0; b < 16; b++) {
            const v = audio.bands[b];
            wSum += v;
            idxSum += v * (b / 15);
          }
          if (wSum > 0.08) pitchNorm = idxSum / wSum;
        }

        const beatEnv = Math.exp(-audio.phase * 4.2);
        const react = params.react as number;
        const mode = Math.round(params.mode as number) & 3;
        const pebble = params.pebble as number;

        // Phrase re-formation window: picture settles briefly at start of every 4-bar phrase
        const phrasePhase = (audio.bar + audio.phase) / 4; // 0..1 across 4 bars (1 bar = 4 beats -> bar is 0..3)
        const reformParam = params.reform as number;
        // Brief clean window around phrase boundary (phrasePhase near 0 or 1)
        const distPhrase = Math.min(phrasePhase, 1 - phrasePhase);
        const reformEnv = reformParam * Math.exp(-((distPhrase / 0.085) ** 2));

        // Enqueue pebble drops from onsets & beat impacts
        const drops = new Float32Array(MAX_DROPS * 4);
        let dropCount = 0;
        const pushDrop = (x: number, y: number, rad: number, amp: number) => {
          if (dropCount >= MAX_DROPS) return;
          drops.set([x, y, rad, amp], dropCount * 4);
          dropCount++;
        };

        const activeAudio = audio.rms + bass + hi;
        if (pebble > 0.001 && activeAudio > 0.03) {
          // Onset pebbles: drop 2-3 pebbles in complementary spots
          for (let ago = 0; ago < ticks; ago++) {
            const f = past(ago);
            if (f.onset) {
              const tSeed = tick - ago;
              const amp = pebble * (0.55 + 0.85 * react * (0.4 + bass + 0.7 * hi));
              const px = 0.14 + 0.72 * rand(tSeed, 11);
              const py = 0.14 + 0.72 * rand(tSeed, 23);
              const rad = 0.028 + 0.034 * (0.4 + bass);
              pushDrop(px, py, rad, amp);
              // Harmonic counter-pebble
              const qx = 0.16 + 0.68 * rand(tSeed, 37);
              const qy = 0.16 + 0.68 * rand(tSeed, 53);
              pushDrop(qx, qy, rad * 0.78, -amp * 0.78);
              if (hi > 0.22) {
                pushDrop(0.5 + (px - 0.5) * -0.7, 0.5 + (py - 0.5) * -0.7, rad * 0.55, amp * 0.65);
              }
            }
          }

          // Rhythmic beat pebble when beat index advances on active music
          const beatIdx = Math.floor(audio.bar) * 2 + (audio.phase >= 0.5 ? 1 : 0);
          if (beatIdx !== lastBeatIdx && bass > 0.12) {
            lastBeatIdx = beatIdx;
            const bx = 0.2 + 0.6 * rand(tick, 71);
            const by = 0.2 + 0.6 * rand(tick, 89);
            pushDrop(bx, by, 0.036 + 0.025 * bass, pebble * (0.38 + 0.65 * bass * react));
          }
        }

        // 3 wave substeps per tick for crisp fast wave propagation
        const speed = params.speed as number;
        const c2 = Math.min(0.36, 0.15 * speed * speed);
        const damp = params.damp as number;
        const substeps = 3;

        const gx = Math.ceil(W / 16);
        const gy = Math.ceil(H / 16);

        const fillSim = (su: Uint32Array, sf: Float32Array, dCount: number, stepFlag: number) => {
          sf.fill(0);
          su.set([W, H, mode, dCount], 0);
          sf.set([aspect, c2, damp, params.edge_wall as number], 4);
          sf.set([bass, mid, hi, audio.rms], 8);
          sf.set([kick, beatEnv, time, pitchNorm], 12);
          sf.set([luma ? 1 : 0, edges ? 1 : 0, reformEnv, params.swell as number], 16);
          sf.set([params.edge_wall as number, react, stepFlag, 0], 20);
          if (dCount > 0) sf.set(drops, 24);
        };
        fillSim(su0, sf0, dropCount, 0);
        fillSim(su1, sf1, 0, 1);
        device.queue.writeBuffer(simU0, 0, simData0);
        device.queue.writeBuffer(simU1, 0, simData1);

        if (fresh) {
          const cp = enc.beginComputePass({ label: 'agy-ripple-optics init' });
          cp.setPipeline(initP);
          cp.setBindGroup(0, simBgStep[1 - cur]);
          cp.dispatchWorkgroups(gx, gy);
          cp.end();
        }

        const totalSteps = ticks * substeps;
        const cp = enc.beginComputePass({ label: 'agy-ripple-optics step' });
        cp.setPipeline(stepP);
        for (let s = 0; s < totalSteps; s++) {
          cp.setBindGroup(0, s === 0 ? simBgDrop[cur] : simBgStep[cur]);
          cp.dispatchWorkgroups(gx, gy);
          cur = 1 - cur;
        }
        cp.end();

        // Draw uniforms & palette
        const pal =
          (ins.palette as Palette | undefined)?.stops ??
          Array.from({ length: 6 }, (_, i) => oklch(0.32 + i * 0.11, 0.16, audio.pal + 0.52 + i * 0.11));

        df.fill(0);
        df.set([W, H, aspect, mode], 0);
        df.set([params.refract as number, params.caustic as number, params.dispersion as number, params.facets as number], 4);
        df.set([bass, mid, hi, audio.rms], 8);
        df.set([kick, beatEnv, time, reformEnv], 12);
        df.set([Math.min(8, pal.length), params.pal_mix as number, params.glow as number, react], 16);
        df.set([luma ? 1 : 0, edges ? 1 : 0, pitchNorm, (time * 0.06) % 1], 20);
        pal.slice(0, 8).forEach((st, i) => df.set(st, 24 + i * 4));
        device.queue.writeBuffer(drawU, 0, df);

        const rp = enc.beginRenderPass({
          label: 'agy-ripple-optics draw',
          colorAttachments: [{ view: out.out.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }],
        });
        rp.setPipeline(drawPipe);
        rp.setBindGroup(0, drawBg[cur]);
        rp.draw(3);
        rp.end();
      },
      dispose() {
        for (const b of bufs) b.destroy();
        simU0.destroy();
        simU1.destroy();
        drawU.destroy();
        dummy.destroy();
      },
    };
  },
});
