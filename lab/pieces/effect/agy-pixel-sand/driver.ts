import { definePiece, oklch, type Palette } from '../../../api/index.ts';

// Falling-sand pixel physics on a 2D cellular grid using race-free Margolus 2x2 block updates.
// Each cell stores:
//   state: vec4f(kind [0=empty, 1=pinned picture, 2=falling sand], age, trail, spark)
//   color: vec4f(r, g, b, edge)
// Per frame: cs_fracture fractures pinned patches on drops/beats/erosion and re-crystallizes
// empty voids & aged sand back into live media; then `steps` Margolus 2x2 substeps cascade
// loose grains downward, diagonally into dunes, sideways with media edge-wind, and upward on quakes.

// Sim uniform: 24 u32/f32 = 96 bytes
const SIM_BYTES = 96;
// Draw uniform: 16 floats (64 B) + 8 * vec4f palette (128 B) = 192 bytes
const DRAW_BYTES = 192;

export default definePiece({
  gpu: ({ device, shader, formats }) => {
    const simMod = shader('sim.wgsl');
    const drawMod = shader('draw.wgsl');
    const C = GPUShaderStage.COMPUTE;
    const F = GPUShaderStage.FRAGMENT;

    const simBgl = device.createBindGroupLayout({
      label: 'agy-pixel-sand sim bgl',
      entries: [
        { binding: 0, visibility: C, buffer: { type: 'uniform' } },
        { binding: 1, visibility: C, buffer: { type: 'storage' } },
        { binding: 2, visibility: C, sampler: { type: 'filtering' } },
        { binding: 3, visibility: C, texture: { sampleType: 'float' } }, // in (pic)
        { binding: 4, visibility: C, texture: { sampleType: 'float' } }, // luma
        { binding: 5, visibility: C, texture: { sampleType: 'float' } }, // edges
      ],
    });

    const drawBgl = device.createBindGroupLayout({
      label: 'agy-pixel-sand draw bgl',
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
        label: `agy-pixel-sand ${entryPoint}`,
        layout: simLayout,
        compute: { module: simMod, entryPoint },
      });

    const initP = cp('cs_init');
    const fracP = cp('cs_fracture');
    const fallPs = [cp('cs_fall_0'), cp('cs_fall_1'), cp('cs_fall_2'), cp('cs_fall_3')];
    const quakePs = [cp('cs_quake_0'), cp('cs_quake_1')];

    const drawPipe = device.createRenderPipeline({
      label: 'agy-pixel-sand draw',
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
      label: 'agy-pixel-sand dummy',
      size: [1, 1],
      format: formats.tex,
      usage: GPUTextureUsage.TEXTURE_BINDING,
    });

    const simU = device.createBuffer({
      label: 'agy-pixel-sand sim u',
      size: SIM_BYTES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    const drawU = device.createBuffer({
      label: 'agy-pixel-sand draw u',
      size: DRAW_BYTES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    const simData = new ArrayBuffer(SIM_BYTES);
    const su = new Uint32Array(simData);
    const sf = new Float32Array(simData);
    const df = new Float32Array(DRAW_BYTES / 4);

    let W = 0, H = 0, lastTick = -Infinity, phaseRot = 0;
    let cellBuf: GPUBuffer | null = null;
    let simBg: GPUBindGroup | null = null;
    let drawBg: GPUBindGroup | null = null;
    let lastPic: unknown = null, lastLuma: unknown = null, lastEdges: unknown = null;

    const alloc = (w: number, h: number) => {
      cellBuf?.destroy();
      W = w; H = h;
      lastPic = lastLuma = lastEdges = null;
      cellBuf = device.createBuffer({
        label: 'agy-pixel-sand cells',
        size: w * h * 32,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      });
    };

    const rebuildGroups = (pic: GPUTexture, luma?: GPUTexture, edges?: GPUTexture) => {
      const pv = pic.createView();
      const lv = (luma ?? dummy).createView();
      const ev = (edges ?? dummy).createView();
      simBg = device.createBindGroup({
        layout: simBgl,
        entries: [
          { binding: 0, resource: { buffer: simU } },
          { binding: 1, resource: { buffer: cellBuf! } },
          { binding: 2, resource: smp },
          { binding: 3, resource: pv },
          { binding: 4, resource: lv },
          { binding: 5, resource: ev },
        ],
      });
      drawBg = device.createBindGroup({
        layout: drawBgl,
        entries: [
          { binding: 0, resource: { buffer: drawU } },
          { binding: 1, resource: { buffer: cellBuf! } },
          { binding: 2, resource: smp },
          { binding: 3, resource: pv },
        ],
      });
    };

    return {
      frame({ enc, out, in: ins, params, audio, time, tick, past, width, height }) {
        const pic = (ins.in as GPUTexture | undefined) ?? dummy;
        const luma = ins.luma as GPUTexture | undefined;
        const edges = ins.edges as GPUTexture | undefined;

        // Even grid dimensions so Margolus phase (0,0) covers every border cell cleanly
        const hRaw = Math.round(Math.min(360, Math.max(80, params.cells as number)));
        const h = Math.max(80, hRaw & ~1);
        const w = Math.max(32, Math.round(((h * width) / height) / 2) * 2);

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
        ticks = Math.min(ticks, 4);
        lastTick = tick;

        const react = params.react as number;
        const bass = (audio.bands[0] + audio.bands[1] + audio.bands[2]) / 3;
        const mids = (audio.bands[5] + audio.bands[6] + audio.bands[7] + audio.bands[8]) / 4;
        const highs = (audio.bands[10] + audio.bands[11] + audio.bands[12] + audio.bands[13]) / 4;
        let kick = 0;
        let freshOnset = false;
        for (let ago = 0; ago < 22; ago++) {
          if (past(ago).onset) {
            kick = Math.exp(-ago / 5.5);
            if (ago < ticks) freshOnset = true;
            break;
          }
        }
        const beatEnv = Math.exp(-audio.phase * 4.5);
        const floorMode = Math.round(params.floor as number);

        const crumbleP = params.crumble as number;
        const erosionP = params.erosion as number;
        const crumbleBurst = crumbleP * react * (kick * 0.72 + bass * 0.42 + beatEnv * 0.24);
        const resurfaceRate = (params.resurface as number) * (0.55 + 0.85 * beatEnv + 0.35 * audio.rms);
        const windAmt = (params.wind as number) * (0.45 + 1.15 * react * (highs + mids * 0.5));
        const fluidity = Math.min(0.95, (params.fluidity as number) * (0.6 + 0.75 * react * (audio.rms + bass * 0.5)));
        const quakeParam = params.quake as number;
        const doQuake = floorMode !== 1 && quakeParam > 0.05 && (freshOnset || (floorMode === 2 && bass * react > 0.42 && beatEnv > 0.65));

        su.fill(0);
        su.set([W, H, floorMode, Math.imul(tick, 2654435761) >>> 0], 0);
        sf.set([
          crumbleBurst, erosionP, resurfaceRate, params.edge_wall as number,
          windAmt, fluidity, quakeParam * (0.4 + 0.6 * Math.max(kick, bass)), time,
          luma ? 1 : 0, edges ? 1 : 0, beatEnv, kick,
          bass, highs, audio.rms, Math.sin(time * 0.9) * 0.35,
          120.0 + 180.0 / Math.max(0.25, params.resurface as number), 0, 0, 0,
        ], 4);
        device.queue.writeBuffer(simU, 0, simData);

        const gx = Math.ceil(W / 16);
        const gy = Math.ceil(H / 16);
        const bx = Math.ceil(W / 32);
        const by = Math.ceil(H / 32);

        const pass = enc.beginComputePass({ label: 'agy-pixel-sand sim' });
        pass.setBindGroup(0, simBg!);

        if (fresh) {
          pass.setPipeline(initP);
          pass.dispatchWorkgroups(gx, gy);
        }

        // Media fracture + live resurfacing
        pass.setPipeline(fracP);
        pass.dispatchWorkgroups(gx, gy);

        // Optional upward quake pulse on big drops / kicks
        if (doQuake) {
          const qSteps = floorMode === 2 ? 2 : 1;
          for (let q = 0; q < qSteps; q++) {
            pass.setPipeline(quakePs[(phaseRot + q) & 1]);
            pass.dispatchWorkgroups(bx, by);
          }
        }

        // Falling-sand Margolus 2x2 substeps
        const steps = Math.max(2, Math.min(8, Math.round((params.steps as number) * (0.8 + 0.45 * audio.rms * react))));
        for (let s = 0; s < steps; s++) {
          pass.setPipeline(fallPs[(phaseRot + s) & 3]);
          pass.dispatchWorkgroups(bx, by);
        }
        phaseRot = (phaseRot + 1) & 3;
        pass.end();

        const pal = (ins.palette as Palette | undefined)?.stops ??
          Array.from({ length: 6 }, (_, i) => oklch(0.25 + i * 0.13, 0.16, audio.pal + i / 8));
        const bps = (audio.bpm > 0 ? audio.bpm : 120) / 60;
        df.fill(0);
        df.set([
          W, H, Math.min(8, pal.length), params.glow as number,
          kick * (params.flash as number), audio.rms, (time * bps) / 16, params.under as number,
          params.trail as number, params.pal_mix as number, params.dither as number, beatEnv,
          bass * react, highs * react, 0, 0,
        ], 0);
        pal.slice(0, 8).forEach((st, i) => df.set(st, 16 + i * 4));
        device.queue.writeBuffer(drawU, 0, df);

        const rp = enc.beginRenderPass({
          colorAttachments: [{ view: out.out.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }],
        });
        rp.setPipeline(drawPipe);
        rp.setBindGroup(0, drawBg!);
        rp.draw(3);
        rp.end();
      },
      dispose: () => {
        cellBuf?.destroy();
        simU.destroy(); drawU.destroy(); dummy.destroy();
      },
      status: () => `${W}x${H} sand`,
    };
  },
});
