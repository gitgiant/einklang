import { definePiece, oklch, type Palette } from '../../../api/index.ts';

// Gray-Scott reaction-diffusion. GPU state (not synced): two storage buffers of (A, B) per cell, ping-ponged.
// Per frame: one advect pass (drift + seeds from every tick since the last frame), then `steps` sim steps
// per elapsed tick, then the colour pass into the output.

const SIM_BYTES = 48 + 8 * 16, DRAW_BYTES = 32 + 8 * 16, MAX_SEEDS = 8, MAX_CATCHUP = 4;

export default definePiece({
  gpu: ({ device, shader }) => {
    const simMod = shader('sim.wgsl'), drawMod = shader('draw.wgsl');
    const bgl = device.createBindGroupLayout({
      label: 'claude-reaction sim',
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
      ],
    });
    const layout = device.createPipelineLayout({ bindGroupLayouts: [bgl] });
    const advect = device.createComputePipeline({ label: 'claude-reaction advect', layout, compute: { module: simMod, entryPoint: 'cs_advect' } });
    const step = device.createComputePipeline({ label: 'claude-reaction step', layout, compute: { module: simMod, entryPoint: 'cs_step' } });
    const draw = device.createRenderPipeline({
      label: 'claude-reaction draw', layout: 'auto',
      vertex: { module: drawMod, entryPoint: 'vs_full' },
      fragment: { module: drawMod, entryPoint: 'fs_draw', targets: [{ format: 'rgba16float' }] },
    });
    const simU = device.createBuffer({ label: 'claude-reaction sim u', size: SIM_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const drawU = device.createBuffer({ label: 'claude-reaction draw u', size: DRAW_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const simData = new ArrayBuffer(SIM_BYTES), su = new Uint32Array(simData), sf = new Float32Array(simData);
    const df = new Float32Array(DRAW_BYTES / 4);

    let W = 0, H = 0, cur = 0, lastTick = -Infinity;
    let bufs: GPUBuffer[] = [], simBg: GPUBindGroup[] = [], drawBg: GPUBindGroup[] = [];

    const alloc = (w: number, h: number) => {
      for (const b of bufs) b.destroy();
      W = w; H = h; cur = 0;
      bufs = [0, 1].map((i) => device.createBuffer({ label: `claude-reaction cells ${i}`, size: w * h * 8, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST }));
      simBg = [0, 1].map((i) => device.createBindGroup({
        layout: bgl,
        entries: [{ binding: 0, resource: { buffer: simU } }, { binding: 1, resource: { buffer: bufs[i] } }, { binding: 2, resource: { buffer: bufs[1 - i] } }],
      }));
      drawBg = [0, 1].map((i) => device.createBindGroup({
        layout: draw.getBindGroupLayout(0),
        entries: [{ binding: 0, resource: { buffer: drawU } }, { binding: 1, resource: { buffer: bufs[i] } }],
      }));
    };

    /** Fresh field: A = 1 everywhere, a scatter of B spots (seeded noise, the same on every host). */
    const reset = (rand: (a: number, b?: number) => number, seed: number) => {
      const cells = new Float32Array(W * H * 2);
      for (let i = 0; i < W * H; i++) cells[i * 2] = 1;
      for (let s = 0; s < 48; s++) {
        const cx = rand(seed, s * 3) * W, cy = rand(seed, s * 3 + 1) * H, r = 2 + rand(seed, s * 3 + 2) * 5;
        for (let y = Math.max(0, Math.floor(cy - r)); y < Math.min(H, cy + r); y++)
          for (let x = Math.max(0, Math.floor(cx - r)); x < Math.min(W, cx + r); x++)
            if (Math.hypot(x - cx, y - cy) < r) cells.set([0.5, 0.25], (y * W + x) * 2);
      }
      device.queue.writeBuffer(bufs[0], 0, cells);
      cur = 0;
    };

    return {
      frame({ enc, out, in: ins, params, audio, time, tick, past, rand, width, height }) {
        const h = Math.round(Math.min(720, Math.max(90, params.cells as number))), w = Math.max(16, Math.round((h * width) / height));
        let fresh = false;
        if (w !== W || h !== H) { alloc(w, h); fresh = true; }
        let ticks = tick - lastTick;
        if (fresh || ticks < 0 || ticks > 120) { reset(rand, tick); ticks = 1; }
        ticks = Math.min(ticks, MAX_CATCHUP);
        lastTick = tick;

        const bass = (audio.bands[0] + audio.bands[1] + audio.bands[2]) / 3;
        let kick = 0;
        for (let ago = 0; ago < 24; ago++) if (past(ago).onset) kick = Math.max(kick, Math.exp(-ago / 7));

        if (ticks > 0) {
          // seeds: each onset in the ticks since the last frame drops two spots; a small one every 1.5 s keeps quiet music alive
          const seeds: number[] = [];
          const amt = params.seeds as number;
          for (let ago = ticks - 1; ago >= 0 && seeds.length < MAX_SEEDS * 4; ago--) {
            const t = tick - ago;
            if (amt > 0 && past(ago).onset)
              for (let k = 0; k < 2; k++) seeds.push(rand(t, k * 4) * W, rand(t, k * 4 + 1) * H, 3 + rand(t, k * 4 + 2) * 6 * amt, Math.min(1, amt));
            if (t % 90 === 0) seeds.push(rand(t, 9) * W, rand(t, 10) * H, 3, 1);
          }
          const nseed = Math.min(MAX_SEEDS, seeds.length / 4);
          su.set([W, H, nseed, 0], 0);
          sf.set([params.regime as number, params.spread as number, params.drive as number, bass], 4);
          sf.set([(params.drift as number) * (0.5 + 1.5 * bass) * ticks, (params.swirl as number) * ticks, time, 0], 8);
          sf.fill(0, 12);
          sf.set(seeds.slice(0, nseed * 4), 12);
          device.queue.writeBuffer(simU, 0, simData);

          const gx = Math.ceil(W / 16), gy = Math.ceil(H / 16);
          const cp = enc.beginComputePass({ label: 'claude-reaction' });
          cp.setPipeline(advect); cp.setBindGroup(0, simBg[cur]); cp.dispatchWorkgroups(gx, gy); cur = 1 - cur;
          cp.setPipeline(step);
          const n = Math.max(1, Math.round(params.steps as number)) * ticks;
          for (let i = 0; i < n; i++) { cp.setBindGroup(0, simBg[cur]); cp.dispatchWorkgroups(gx, gy); cur = 1 - cur; }
          cp.end();
        }

        const pal = (ins.palette as Palette | undefined)?.stops ?? Array.from({ length: 6 }, (_, i) => oklch(0.35 + i * 0.1, 0.13, audio.pal + i / 9));
        const bps = (audio.bpm > 0 ? audio.bpm : 120) / 60;
        df.fill(0);
        df.set([W, H, Math.min(8, pal.length), params.glow as number, kick, audio.rms, (time * bps / 16) * (params.cycle as number), params.relief as number], 0);
        pal.slice(0, 8).forEach((s, i) => df.set(s, 8 + i * 4));
        device.queue.writeBuffer(drawU, 0, df);
        const rp = enc.beginRenderPass({ colorAttachments: [{ view: out.out.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }] });
        rp.setPipeline(draw); rp.setBindGroup(0, drawBg[cur]); rp.draw(3); rp.end();
      },
      dispose: () => { for (const b of bufs) b.destroy(); simU.destroy(); drawU.destroy(); },
      status: () => `${W}x${H} cells`,
    };
  },
});
