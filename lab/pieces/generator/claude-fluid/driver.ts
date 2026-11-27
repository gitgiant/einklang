import { definePiece, oklch, type Palette } from '../../../api/index.ts';

// Stable fluids. GPU state (not synced): ping-ponged velocity, dye and pressure grids plus an aux
// grid (divergence, curl). Per elapsed tick, one step: curl, forces (vorticity, buoyancy, nozzles),
// advect, divergence, Jacobi pressure, gradient subtract, copy back. Onsets puff in place first.
// Buffer roles: group A = (V0 -> V1, D0 -> D1, P0 -> P1), group B = (V1 -> V0, D1 -> D0, P1 -> P0).

const SIM_BYTES = 192, DRAW_BYTES = 48 + 8 * 16, MAX_CATCHUP = 4, REF_H = 256;

export default definePiece({
  gpu: ({ device, shader }) => {
    const simMod = shader('sim.wgsl'), drawMod = shader('draw.wgsl');
    const C = GPUShaderStage.COMPUTE;
    const ro = { type: 'read-only-storage' } as const, rw = { type: 'storage' } as const;
    const bgl = device.createBindGroupLayout({
      label: 'claude-fluid sim',
      entries: [
        { binding: 0, visibility: C, buffer: { type: 'uniform' } },
        { binding: 1, visibility: C, buffer: ro }, { binding: 2, visibility: C, buffer: rw },
        { binding: 3, visibility: C, buffer: ro }, { binding: 4, visibility: C, buffer: rw },
        { binding: 5, visibility: C, buffer: ro }, { binding: 6, visibility: C, buffer: rw },
        { binding: 7, visibility: C, buffer: rw },
      ],
    });
    const layout = device.createPipelineLayout({ bindGroupLayouts: [bgl] });
    const cp = (entryPoint: string) => device.createComputePipeline({ label: `claude-fluid ${entryPoint}`, layout, compute: { module: simMod, entryPoint } });
    const curl = cp('cs_curl'), force = cp('cs_force'), puff = cp('cs_puff'), advect = cp('cs_advect');
    const div = cp('cs_div'), jacobi = cp('cs_jacobi'), grad = cp('cs_grad'), copy = cp('cs_copy');
    const draw = device.createRenderPipeline({
      label: 'claude-fluid draw', layout: 'auto',
      vertex: { module: drawMod, entryPoint: 'vs_full' },
      fragment: { module: drawMod, entryPoint: 'fs_draw', targets: [{ format: 'rgba16float' }] },
    });
    const simU = device.createBuffer({ label: 'claude-fluid sim u', size: SIM_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const drawU = device.createBuffer({ label: 'claude-fluid draw u', size: DRAW_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const simData = new ArrayBuffer(SIM_BYTES), su = new Uint32Array(simData), sf = new Float32Array(simData);
    const df = new Float32Array(DRAW_BYTES / 4);

    let W = 0, H = 0, lastTick = -Infinity;
    let bufs: GPUBuffer[] = [];
    let A: GPUBindGroup | null = null, B: GPUBindGroup | null = null, drawBg: GPUBindGroup | null = null;

    const alloc = (w: number, h: number) => {
      for (const b of bufs) b.destroy();
      W = w; H = h;
      const S = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST, n = w * h;
      const mk = (label: string, bytes: number) => device.createBuffer({ label: `claude-fluid ${label}`, size: n * bytes, usage: S });
      const [V0, V1, D0, D1, P0, P1, X] = [mk('v0', 8), mk('v1', 8), mk('d0', 8), mk('d1', 8), mk('p0', 4), mk('p1', 4), mk('aux', 8)];
      bufs = [V0, V1, D0, D1, P0, P1, X];
      const group = (vi: GPUBuffer, vo: GPUBuffer, di: GPUBuffer, dO: GPUBuffer, pi: GPUBuffer, po: GPUBuffer) => device.createBindGroup({
        layout: bgl,
        entries: [simU, vi, vo, di, dO, pi, po, X].map((buffer, binding) => ({ binding, resource: { buffer } })),
      });
      A = group(V0, V1, D0, D1, P0, P1);
      B = group(V1, V0, D1, D0, P1, P0);
      drawBg = device.createBindGroup({
        layout: draw.getBindGroupLayout(0),
        entries: [{ binding: 0, resource: { buffer: drawU } }, { binding: 1, resource: { buffer: D0 } }],
      });
    };

    return {
      frame({ enc, out, in: ins, params, audio, time, tick, past, rand, width, height }) {
        const h = Math.round(Math.min(540, Math.max(96, params.cells as number))), w = Math.max(16, Math.round((h * width) / height));
        let fresh = false;
        if (w !== W || h !== H) { alloc(w, h); fresh = true; }
        let ticks = tick - lastTick;
        if (fresh || ticks < 0 || ticks > 120) {
          for (const b of bufs) enc.clearBuffer(b);
          ticks = 1; fresh = true;
        }
        ticks = Math.min(ticks, MAX_CATCHUP);
        lastTick = tick;

        const avg = (lo: number, hi: number, f = audio) => { let s = 0; for (let b = lo; b <= hi; b++) s += f.bands[b]; return s / (hi - lo + 1); };
        let bass = 0, mid = 0;
        for (let ago = 0; ago < 5; ago++) { const f = past(ago); bass += avg(0, 2, f) / 5; mid += avg(5, 10, f) / 5; }
        let kick = 0, onsetAgo = -1;
        for (let ago = 0; ago < 30; ago++) if (past(ago).onset) { kick = Math.max(kick, Math.exp(-ago / 8)); if (onsetAgo < 0) onsetAgo = ago; }

        const s = h / REF_H, speed = params.speed as number, dt = speed / 60;
        const lvl = (params.idle as number) + (params.react as number) * bass * 1.4;
        const n = Math.round(Math.min(4, Math.max(1, params.sources as number)));
        const sway = params.sway as number;
        su.set([W, H, n, 0], 0);
        sf.set([dt, Math.pow(0.5, dt / 4), Math.pow(0.5, dt / Math.max(0.1, params.fade as number)), (params.buoyancy as number) * 40 * s], 4);
        for (let k = 0; k < n; k++) {
          const x = W * ((k + 0.5) / n + (0.25 / n) * Math.sin(time * 0.21 + k * 2.3));
          // the nozzles lean with slow wander and push apart or together with the mids
          const lean = sway * (0.4 * Math.sin(time * 0.37 + k * 1.7) + 0.5 * (mid - 0.3) * (k % 2 ? -1 : 1));
          const f = (params.force as number) * 700 * s * lvl;
          const tag = n > 1 ? 0.1 + 0.6 * k / (n - 1) : 0.4;
          sf.set([x, H * 0.97, 7 * s, (params.rate as number) * 8 * lvl], 16 + k * 4);
          sf.set([Math.sin(lean) * f, -Math.cos(lean) * f, tag, 0], 32 + k * 4);
        }

        // an onset since the last frame: a puff at a seeded spot, in a seeded colour, with a seeded twist
        const puffAmt = params.puff as number;
        const hit = onsetAgo >= 0 && onsetAgo < ticks && puffAmt > 0;
        const pt = tick - Math.max(0, onsetAgo);
        sf.set([(params.vorticity as number) * 4 * s, (0.05 + 0.05 * rand(pt, 4)) * H, puffAmt * 260 * s, puffAmt * 1.6], 8);
        sf.set([(0.15 + 0.7 * rand(pt, 1)) * W, (0.25 + 0.45 * rand(pt, 2)) * H, rand(pt, 3), (rand(pt, 5) - 0.5) * 2], 12);
        device.queue.writeBuffer(simU, 0, simData);

        const gx = Math.ceil(W / 16), gy = Math.ceil(H / 16);
        const iters = Math.max(2, Math.round((params.iters as number) / 2) * 2);
        const pass = enc.beginComputePass({ label: 'claude-fluid' });
        const run = (p: GPUComputePipeline, g: GPUBindGroup) => { pass.setPipeline(p); pass.setBindGroup(0, g); pass.dispatchWorkgroups(gx, gy); };
        if (hit) run(puff, B!);
        for (let t = 0; t < ticks; t++) {
          run(curl, A!); run(force, A!); run(advect, B!); run(div, A!);
          for (let j = 0; j < iters; j += 2) { run(jacobi, A!); run(jacobi, B!); }
          run(grad, A!); run(copy, B!);
        }
        pass.end();

        const pal = (ins.palette as Palette | undefined)?.stops ?? Array.from({ length: 6 }, (_, i) => oklch(0.18 + i * 0.14, 0.13, audio.pal + 0.55 + i / 9));
        const bps = (audio.bpm > 0 ? audio.bpm : 120) / 60;
        df.fill(0);
        df.set([W, H, Math.min(8, pal.length), params.glow as number], 0);
        df.set([0.9 * (params.exposure as number), kick, (time * bps / 16) * (params.cycle as number), params.bg as number], 4);
        df.set([params.light as number, audio.rms, 0, 0], 8);
        pal.slice(0, 8).forEach((st, i) => df.set(st, 12 + i * 4));
        device.queue.writeBuffer(drawU, 0, df);
        const rp = enc.beginRenderPass({ colorAttachments: [{ view: out.out.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }] });
        rp.setPipeline(draw); rp.setBindGroup(0, drawBg!); rp.draw(3); rp.end();
      },
      dispose: () => { for (const b of bufs) b.destroy(); simU.destroy(); drawU.destroy(); },
      status: () => `${W}x${H} fluid`,
    };
  },
});
