import { definePiece, oklch, oklabToLinear, type Palette } from '../../../api/index.ts';

// Stable fluids over the picture. GPU state (not synced): ping-ponged velocity, dye (rgb + smear)
// and pressure grids plus an aux grid (divergence, curl). Per elapsed tick, one step: curl, forces
// (vorticity, the picture's contour flow, buoyancy, stirrers, dye restore), advect, divergence,
// Jacobi pressure, gradient subtract, copy back. Onsets puff in place first.
// Buffer roles: group A = (V0 -> V1, D0 -> D1, P0 -> P1), group B = (V1 -> V0, D1 -> D0, P1 -> P0).

const SIM_BYTES = 96 + 64, DRAW_BYTES = 48 + 8 * 16, MAX_CATCHUP = 4, REF_H = 240;

export default definePiece({
  gpu: ({ device, shader }) => {
    const simMod = shader('sim.wgsl'), drawMod = shader('draw.wgsl');
    const C = GPUShaderStage.COMPUTE;
    const ro = { type: 'read-only-storage' } as const, rw = { type: 'storage' } as const;
    const bgl = device.createBindGroupLayout({
      label: 'claude-paint-smoke sim',
      entries: [
        { binding: 0, visibility: C, buffer: { type: 'uniform' } },
        { binding: 1, visibility: C, buffer: ro }, { binding: 2, visibility: C, buffer: rw },
        { binding: 3, visibility: C, buffer: ro }, { binding: 4, visibility: C, buffer: rw },
        { binding: 5, visibility: C, buffer: ro }, { binding: 6, visibility: C, buffer: rw },
        { binding: 7, visibility: C, buffer: rw },
        { binding: 8, visibility: C, sampler: {} },
        { binding: 9, visibility: C, texture: {} },
        { binding: 10, visibility: C, texture: {} },
      ],
    });
    const layout = device.createPipelineLayout({ bindGroupLayouts: [bgl] });
    const cp = (entryPoint: string) => device.createComputePipeline({ label: `claude-paint-smoke ${entryPoint}`, layout, compute: { module: simMod, entryPoint } });
    const init = cp('cs_init'), curl = cp('cs_curl'), force = cp('cs_force'), puff = cp('cs_puff'), advect = cp('cs_advect');
    const div = cp('cs_div'), jacobi = cp('cs_jacobi'), grad = cp('cs_grad'), copy = cp('cs_copy');
    const draw = device.createRenderPipeline({
      label: 'claude-paint-smoke draw', layout: 'auto',
      vertex: { module: drawMod, entryPoint: 'vs_full' },
      fragment: { module: drawMod, entryPoint: 'fs_draw', targets: [{ format: 'rgba16float' }] },
    });
    const smp = device.createSampler({ magFilter: 'linear', minFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' });
    const dummy = device.createTexture({ label: 'claude-paint-smoke no luma', size: [1, 1], format: 'r16float', usage: GPUTextureUsage.TEXTURE_BINDING });
    const simU = device.createBuffer({ label: 'claude-paint-smoke sim u', size: SIM_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const drawU = device.createBuffer({ label: 'claude-paint-smoke draw u', size: DRAW_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const simData = new ArrayBuffer(SIM_BYTES), su = new Uint32Array(simData), sf = new Float32Array(simData);
    const df = new Float32Array(DRAW_BYTES / 4);

    let W = 0, H = 0, lastTick = -Infinity;
    let bufs: GPUBuffer[] = [];
    let A: GPUBindGroup | null = null, B: GPUBindGroup | null = null, drawBg: GPUBindGroup | null = null;
    let boundMedia: GPUTexture | null = null, boundLuma: GPUTexture | null = null;

    const alloc = (w: number, h: number) => {
      for (const b of bufs) b.destroy();
      W = w; H = h; boundMedia = null;
      const S = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST, n = w * h;
      const mk = (label: string, bytes: number) => device.createBuffer({ label: `claude-paint-smoke ${label}`, size: n * bytes, usage: S });
      bufs = [mk('v0', 8), mk('v1', 8), mk('d0', 16), mk('d1', 16), mk('p0', 4), mk('p1', 4), mk('aux', 8)];
    };
    const bind = (media: GPUTexture, luma: GPUTexture) => {
      if (media === boundMedia && luma === boundLuma && A) return;
      boundMedia = media; boundLuma = luma;
      const [V0, V1, D0, D1, P0, P1, X] = bufs;
      const mv = media.createView(), lv = luma.createView();
      const group = (vi: GPUBuffer, vo: GPUBuffer, di: GPUBuffer, dO: GPUBuffer, pi: GPUBuffer, po: GPUBuffer) => device.createBindGroup({
        layout: bgl,
        entries: [
          ...[simU, vi, vo, di, dO, pi, po, X].map((buffer, binding) => ({ binding, resource: { buffer } })),
          { binding: 8, resource: smp }, { binding: 9, resource: mv }, { binding: 10, resource: lv },
        ],
      });
      A = group(V0, V1, D0, D1, P0, P1);
      B = group(V1, V0, D1, D0, P1, P0);
      drawBg = device.createBindGroup({
        layout: draw.getBindGroupLayout(0),
        entries: [{ binding: 0, resource: { buffer: drawU } }, { binding: 1, resource: { buffer: D0 } }, { binding: 2, resource: smp }, { binding: 3, resource: mv }],
      });
    };

    return {
      frame({ enc, out, in: ins, params, audio, time, tick, past, rand, width, height }) {
        const media = ins.in as GPUTexture, luma = ins.luma as GPUTexture | undefined;
        const h = Math.round(Math.min(540, Math.max(96, params.cells as number))), w = Math.max(16, Math.round((h * width) / height));
        let fresh = false;
        if (w !== W || h !== H) { alloc(w, h); fresh = true; }
        bind(media, luma ?? dummy);
        let ticks = tick - lastTick;
        if (fresh || ticks < 0 || ticks > 120) {
          for (const b of bufs) enc.clearBuffer(b);
          ticks = 1; fresh = true;
        }
        ticks = Math.min(ticks, MAX_CATCHUP);
        lastTick = tick;

        const avg = (lo: number, hi: number, f = audio) => { let s = 0; for (let b = lo; b <= hi; b++) s += f.bands[b]; return s / (hi - lo + 1); };
        let bass = 0, mid = 0, loud = 0;
        for (let ago = 0; ago < 6; ago++) { const f = past(ago); bass += avg(0, 2, f) / 6; mid += avg(5, 10, f) / 6; loud += f.rms / 6; }
        let kick = 0, onsetAgo = -1;
        for (let ago = 0; ago < 30; ago++) if (past(ago).onset) { kick = Math.max(kick, Math.exp(-ago / 8)); if (onsetAgo < 0) onsetAgo = ago; }

        const s = h / REF_H, dt = (params.speed as number) / 60, react = params.react as number, idle = params.idle as number;
        const lvl = idle + react * (bass * 1.3 + kick * 0.5);
        const bps = (audio.bpm > 0 ? audio.bpm : 120) / 60, beats = time * bps;
        const n = Math.round(Math.min(4, Math.max(0, params.stirrers as number)));
        // the contour flow reverses every 4 bars, so the picture sloshes back and forth around its shapes
        const swirl = (params.swirl as number) * 22 * s * (idle + react * loud * 1.4) * Math.cos((beats / 16) * Math.PI);
        const restore = (params.restore as number) * Math.max(0.25, 1.25 - 0.9 * Math.min(1, bass + 0.5 * kick));
        su.set([W, H, luma ? 1 : 0, n], 0);
        sf.set([dt, Math.pow(0.5, dt / 0.8), restore, (params.smear as number) * 3], 4);
        sf.set([(params.vorticity as number) * 4 * s, swirl, (params.buoyancy as number) * 100 * s * (0.4 + lvl), 0], 8);
        for (let k = 0; k < n; k++) {
          const a = time * 0.18 * (1 + 1.5 * mid) * (k % 2 ? -1 : 1) + (k / Math.max(1, n)) * Math.PI * 2;
          const rr = H * (0.22 + 0.08 * Math.sin(time * 0.13 + k * 1.9));
          const x = W * 0.5 + Math.cos(a) * rr * 1.5, y = H * 0.5 + Math.sin(a) * rr;
          sf.set([x, y, H * 0.17, (params.stir as number) * 220 * s * lvl * (k % 2 ? -1 : 1)], 24 + k * 4);
        }

        // an onset since the last frame: a puff of palette-tinted paint at a seeded spot, with a seeded twist
        const pal = (ins.palette as Palette | undefined)?.stops ?? Array.from({ length: 6 }, (_, i) => oklch(0.35 + i * 0.1, 0.16, audio.pal + i / 7));
        const puffAmt = params.puff as number;
        const hit = onsetAgo >= 0 && onsetAgo < ticks && puffAmt > 0;
        const pt = tick - Math.max(0, onsetAgo);
        const pc = oklabToLinear(pal[Math.floor(rand(pt, 6) * pal.length) % pal.length]);
        sf.set([(0.15 + 0.7 * rand(pt, 1)) * W, (0.2 + 0.6 * rand(pt, 2)) * H, (0.06 + 0.05 * rand(pt, 4)) * H, puffAmt * 300 * s], 12);
        sf.set([pc[0], pc[1], pc[2], (rand(pt, 5) - 0.5) * 2.4], 16);
        sf.set([puffAmt * 0.6, 0, 0, 0], 20);
        device.queue.writeBuffer(simU, 0, simData);

        const gx = Math.ceil(W / 16), gy = Math.ceil(H / 16);
        const iters = Math.max(2, Math.round((params.iters as number) / 2) * 2);
        const pass = enc.beginComputePass({ label: 'claude-paint-smoke' });
        const run = (p: GPUComputePipeline, g: GPUBindGroup) => { pass.setPipeline(p); pass.setBindGroup(0, g); pass.dispatchWorkgroups(gx, gy); };
        if (fresh) run(init, B!);
        if (hit) run(puff, B!);
        for (let t = 0; t < ticks; t++) {
          run(curl, A!); run(force, A!); run(advect, B!); run(div, A!);
          for (let j = 0; j < iters; j += 2) { run(jacobi, A!); run(jacobi, B!); }
          run(grad, A!); run(copy, B!);
        }
        pass.end();

        df.fill(0);
        df.set([W, H, Math.min(8, pal.length), params.glow as number], 0);
        df.set([params.paint as number, 1, params.light as number, kick], 4);
        df.set([audio.rms, (beats / 16) * (params.cycle as number), 0, 0], 8);
        pal.slice(0, 8).forEach((st, i) => df.set(st, 12 + i * 4));
        device.queue.writeBuffer(drawU, 0, df);
        const rp = enc.beginRenderPass({ colorAttachments: [{ view: out.out.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }] });
        rp.setPipeline(draw); rp.setBindGroup(0, drawBg!); rp.draw(3); rp.end();
      },
      dispose: () => { for (const b of bufs) b.destroy(); simU.destroy(); drawU.destroy(); dummy.destroy(); },
      status: () => `${W}x${H} paint fluid`,
    };
  },
});
