import { definePiece, hexToOklab, type Palette } from '../../../api/index.ts';

// Cellular fire. GPU state (not synced): two heat buffers, ping-ponged. Every step has its own uniform slot
// (dynamic offset), so each tick's fuel, flare and fireballs come from that tick's audio.

const SLOT = 256, STEP_BYTES = 32 + 4 * 16, DRAW_BYTES = 16 + 8 * 16, MAX_CATCHUP = 4, MAX_STEPS = 4, BALLS = 4;
const FALLBACK = ['#000000', '#3b0000', '#b01400', '#ff6a00', '#ffc021', '#fff6c8'].map((h) => hexToOklab(h)!);

export default definePiece({
  gpu: ({ device, shader }) => {
    const drawMod = shader('draw.wgsl');
    const bgl = device.createBindGroupLayout({
      label: 'claude-fire sim',
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: STEP_BYTES } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
      ],
    });
    const step = device.createComputePipeline({
      label: 'claude-fire step', layout: device.createPipelineLayout({ bindGroupLayouts: [bgl] }),
      compute: { module: shader('sim.wgsl'), entryPoint: 'cs_step' },
    });
    const draw = device.createRenderPipeline({
      label: 'claude-fire draw', layout: 'auto',
      vertex: { module: drawMod, entryPoint: 'vs_full' },
      fragment: { module: drawMod, entryPoint: 'fs_draw', targets: [{ format: 'rgba16float' }] },
    });
    const simData = new ArrayBuffer(SLOT * MAX_CATCHUP * MAX_STEPS), su = new Uint32Array(simData), sf = new Float32Array(simData);
    const simU = device.createBuffer({ label: 'claude-fire step u', size: simData.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const drawU = device.createBuffer({ label: 'claude-fire draw u', size: DRAW_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const df = new Float32Array(DRAW_BYTES / 4);

    let W = 0, H = 0, cur = 0, lastTick = -Infinity;
    let bufs: GPUBuffer[] = [], simBg: GPUBindGroup[] = [], drawBg: GPUBindGroup[] = [];

    const alloc = (w: number, h: number) => {
      for (const b of bufs) b.destroy();
      W = w; H = h; cur = 0;
      bufs = [0, 1].map((i) => device.createBuffer({ label: `claude-fire heat ${i}`, size: w * h * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST }));
      simBg = [0, 1].map((i) => device.createBindGroup({
        layout: bgl,
        entries: [{ binding: 0, resource: { buffer: simU, size: STEP_BYTES } }, { binding: 1, resource: { buffer: bufs[i] } }, { binding: 2, resource: { buffer: bufs[1 - i] } }],
      }));
      drawBg = [0, 1].map((i) => device.createBindGroup({
        layout: draw.getBindGroupLayout(0),
        entries: [{ binding: 0, resource: { buffer: drawU } }, { binding: 1, resource: { buffer: bufs[i] } }],
      }));
    };

    return {
      frame({ enc, out, in: ins, params, tick, past, rand, width, height }) {
        const h = Math.round(Math.min(540, Math.max(90, params.cells as number))), w = Math.max(16, Math.round((h * width) / height));
        let fresh = false;
        if (w !== W || h !== H) { alloc(w, h); fresh = true; }
        let ticks = tick - lastTick;
        if (fresh || ticks < 0 || ticks > 120) {
          for (const b of bufs) device.queue.writeBuffer(b, 0, new Float32Array(W * H));
          ticks = MAX_CATCHUP;
        }
        ticks = Math.min(ticks, MAX_CATCHUP);
        lastTick = tick;

        const per = Math.min(MAX_STEPS, Math.max(1, Math.round(params.steps as number)));
        let n = 0;
        for (let ago = ticks - 1; ago >= 0; ago--) {
          const t = tick - ago, a = past(ago);
          // bass averaged over a few ticks so the fuel swells instead of strobing
          let bass = 0;
          for (let k = 0; k < 6; k++) { const b = past(ago + k).bands; bass += (b[0] + b[1] + b[2]) / 18; }
          let flare = 0;
          for (let k = 0; k < 24; k++) if (past(ago + k).onset) { flare = Math.exp(-k / 7); break; }
          const drive = params.bass as number, fl = flare * (params.flare as number);
          const fuel = (params.fuel as number) * (0.7 + 0.4 * drive * bass);
          // cooling per step, scaled to the grid so flame height is a fraction of the screen
          const cool = ((params.cooling as number) / H) * Math.max(0.5, 1.15 - 0.35 * drive * bass - 0.18 * fl) / 1.6;
          for (let k = 0; k < per; k++, n++) {
            const o = (n * SLOT) / 4;
            const balls = k === 0 && a.onset && fl > 0 ? BALLS : 0;
            su.set([W, H, (t * per + k) >>> 0, balls], o);
            sf.set([fuel, fl, cool, ((params.wind as number) - 0.5) * 1.6], o + 4);
            for (let b = 0; b < BALLS; b++)
              sf.set([rand(t, b * 3) * W, H - 6 - rand(t, b * 3 + 1) * H * 0.22, H * (0.02 + 0.035 * rand(t, b * 3 + 2)) * Math.min(1.5, params.flare as number), 1.6], o + 8 + b * 4);
          }
        }

        if (n > 0) {
          device.queue.writeBuffer(simU, 0, simData, 0, n * SLOT);
          const cp = enc.beginComputePass({ label: 'claude-fire' });
          cp.setPipeline(step);
          const gx = Math.ceil(W / 8), gy = Math.ceil(H / 8);
          for (let i = 0; i < n; i++) { cp.setBindGroup(0, simBg[cur], [i * SLOT]); cp.dispatchWorkgroups(gx, gy); cur = 1 - cur; }
          cp.end();
        }

        const pal = (ins.palette as Palette | undefined)?.stops ?? FALLBACK;
        df.fill(0);
        df.set([W, H, Math.min(8, pal.length), params.glow as number], 0);
        pal.slice(0, 8).forEach((s, i) => df.set(s, 4 + i * 4));
        device.queue.writeBuffer(drawU, 0, df);
        const rp = enc.beginRenderPass({ colorAttachments: [{ view: out.out.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }] });
        rp.setPipeline(draw); rp.setBindGroup(0, drawBg[cur]); rp.draw(3); rp.end();
      },
      dispose: () => { for (const b of bufs) b.destroy(); simU.destroy(); drawU.destroy(); },
      status: () => `${W}x${H} cells`,
    };
  },
});
