import { definePiece, oklch, type Palette } from '../../../api/index.ts';

const SIM_W = 384;
const SIM_H = 216;
const CELLS = SIM_W * SIM_H;
const JACOBI_ITERS = 14;
const WARMUP = 18;
const UBYTES = 256;

export default definePiece({
  gpu: ({ device, shader }) => {
    const csMod = shader('sim.wgsl');
    const rdMod = shader('render.wgsl');

    const ubuf = device.createBuffer({ label: 'agy-fluid u', size: UBYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const velA = device.createBuffer({ label: 'agy-fluid velA', size: CELLS * 8, usage: GPUBufferUsage.STORAGE });
    const velB = device.createBuffer({ label: 'agy-fluid velB', size: CELLS * 8, usage: GPUBufferUsage.STORAGE });
    const dyeA = device.createBuffer({ label: 'agy-fluid dyeA', size: CELLS * 16, usage: GPUBufferUsage.STORAGE });
    const dyeB = device.createBuffer({ label: 'agy-fluid dyeB', size: CELLS * 16, usage: GPUBufferUsage.STORAGE });
    const presA = device.createBuffer({ label: 'agy-fluid presA', size: CELLS * 4, usage: GPUBufferUsage.STORAGE });
    const presB = device.createBuffer({ label: 'agy-fluid presB', size: CELLS * 4, usage: GPUBufferUsage.STORAGE });
    const auxBuf = device.createBuffer({ label: 'agy-fluid aux', size: CELLS * 4, usage: GPUBufferUsage.STORAGE });

    const csBgl = device.createBindGroupLayout({
      label: 'agy-fluid cs',
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
        { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
        { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
        { binding: 5, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
        { binding: 6, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
        { binding: 7, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
      ],
    });
    const csLayout = device.createPipelineLayout({ bindGroupLayouts: [csBgl] });
    const mkCp = (entryPoint: string) => device.createComputePipeline({ label: `agy-fluid ${entryPoint}`, layout: csLayout, compute: { module: csMod, entryPoint } });
    const pClear = mkCp('cs_clear');
    const pSplat = mkCp('cs_splat');
    const pCurl = mkCp('cs_curl');
    const pVort = mkCp('cs_vorticity');
    const pDiv = mkCp('cs_divergence');
    const pJac = mkCp('cs_jacobi');
    const pProj = mkCp('cs_project');
    const pAdv = mkCp('cs_advect');

    const mkBg = (vi: GPUBuffer, vo: GPUBuffer, di: GPUBuffer, d_o: GPUBuffer, pi: GPUBuffer, po: GPUBuffer) =>
      device.createBindGroup({
        layout: csBgl,
        entries: [
          { binding: 0, resource: { buffer: ubuf } },
          { binding: 1, resource: { buffer: vi } },
          { binding: 2, resource: { buffer: vo } },
          { binding: 3, resource: { buffer: di } },
          { binding: 4, resource: { buffer: d_o } },
          { binding: 5, resource: { buffer: pi } },
          { binding: 6, resource: { buffer: po } },
          { binding: 7, resource: { buffer: auxBuf } },
        ],
      });

    // All ping-pong combinations we need (even JACOBI_ITERS=14 => presA -> presA at end)
    // Start of step: state is in (velA, dyeA)
    // 1. splat:    velA -> velB, dyeA -> dyeB   (bgAB_AB_AB)
    // 2. curl:     reads velB -> aux            (bgBA_BA_AB)
    // 3. vort:     velB -> velA                 (bgBA_BA_AB)
    // 4. div:      reads velA -> aux, clears presA (bgAB_AB_BA: pres_out = presA!)
    // 5. jacobi:   alternates presA->presB (bgAB_AB_AB) and presB->presA (bgAB_AB_BA), 14 times => result in presA!
    // 6. project:  reads velA, presA -> velB    (bgAB_AB_AB)
    // 7. advect:   reads velB, dyeB -> velA, dyeA (bgBA_BA_AB)
    // End of step: latest state is ALWAYS cleanly back in (velA, dyeA)!
    const bgAB_AB_AB = mkBg(velA, velB, dyeA, dyeB, presA, presB);
    const bgAB_AB_BA = mkBg(velA, velB, dyeA, dyeB, presB, presA);
    const bgBA_BA_AB = mkBg(velB, velA, dyeB, dyeA, presA, presB);

    const fsBgl = device.createBindGroupLayout({
      label: 'agy-fluid fs',
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } },
      ],
    });
    const pRender = device.createRenderPipeline({
      label: 'agy-fluid render',
      layout: device.createPipelineLayout({ bindGroupLayouts: [fsBgl] }),
      vertex: { module: rdMod, entryPoint: 'vs_full' },
      fragment: { module: rdMod, entryPoint: 'fs_render', targets: [{ format: 'rgba16float' }] },
    });
    const rdBg = device.createBindGroup({
      layout: fsBgl,
      entries: [
        { binding: 0, resource: { buffer: ubuf } },
        { binding: 1, resource: { buffer: dyeA } },
        { binding: 2, resource: { buffer: velA } },
      ],
    });

    const udata = new Float32Array(UBYTES / 4);
    const gx = Math.ceil(SIM_W / 8), gy = Math.ceil(SIM_H / 8);
    let lastTick = -Infinity;
    let burstCount = 0;

    const runFluidStep = (cp: GPUComputePassEncoder, iters: number) => {
      // 1. splat: velA,dyeA -> velB,dyeB
      cp.setPipeline(pSplat); cp.setBindGroup(0, bgAB_AB_AB); cp.dispatchWorkgroups(gx, gy);
      // 2. curl: velB -> aux
      cp.setPipeline(pCurl); cp.setBindGroup(0, bgBA_BA_AB); cp.dispatchWorkgroups(gx, gy);
      // 3. vorticity: velB + aux -> velA
      cp.setPipeline(pVort); cp.setBindGroup(0, bgBA_BA_AB); cp.dispatchWorkgroups(gx, gy);
      // 4. divergence: velA -> aux, zero presA
      cp.setPipeline(pDiv); cp.setBindGroup(0, bgAB_AB_BA); cp.dispatchWorkgroups(gx, gy);
      // 5. jacobi (even count): presA <-> presB -> presA
      cp.setPipeline(pJac);
      for (let j = 0; j < iters; j++) {
        cp.setBindGroup(0, (j & 1) === 0 ? bgAB_AB_AB : bgAB_AB_BA);
        cp.dispatchWorkgroups(gx, gy);
      }
      // 6. project: velA - grad(presA) -> velB
      cp.setPipeline(pProj); cp.setBindGroup(0, bgAB_AB_AB); cp.dispatchWorkgroups(gx, gy);
      // 7. advect: velB,dyeB -> velA,dyeA
      cp.setPipeline(pAdv); cp.setBindGroup(0, bgBA_BA_AB); cp.dispatchWorkgroups(gx, gy);
    };

    return {
      frame({ enc, out, in: ins, params, audio, time, tick, past, width, height }) {
        const bass = (audio.bands[0] + audio.bands[1] + audio.bands[2]) / 3;
        const mid = (audio.bands[4] + audio.bands[5] + audio.bands[6] + audio.bands[7]) / 4;
        const high = (audio.bands[11] + audio.bands[12] + audio.bands[13] + audio.bands[14]) / 4;
        let kick = 0;
        for (let ago = 0; ago < 20; ago++) {
          if (past(ago).onset) { kick = Math.max(kick, Math.exp(-ago / 5.5)); break; }
        }

        const reset = lastTick === -Infinity || tick < lastTick || tick - lastTick > 120;
        const stepNow = reset || tick !== lastTick;
        if (reset) burstCount = 0;
        if (audio.onset && stepNow) burstCount++;

        const burstAng = burstCount * 1.18 + time * 0.35;
        const burstAmt = audio.onset ? 1.0 : (kick > 0.55 ? kick * 0.45 : 0);

        const pal = (ins.palette as Palette | undefined)?.stops ??
          Array.from({ length: 6 }, (_, i) => oklch(0.7, 0.19, audio.pal + i / 6));
        const palN = Math.min(8, Math.max(1, pal.length));

        udata.fill(0);
        udata.set([SIM_W, SIM_H, width, height], 0);
        udata.set([params.vorticity as number, params.force as number, params.decay as number, params.vel_decay as number], 4);
        udata.set([params.sheen as number, params.glow as number, reset ? 1 : 0, 0], 8);
        udata.set([time, audio.rms, bass, kick], 12);
        udata.set([mid, high, audio.phase, audio.onset ? 1 : 0], 16);
        udata.set([burstAng, reset ? 0.5 : burstAmt, audio.bar, 0], 20);
        for (let i = 0; i < palN; i++) udata.set([pal[i][0], pal[i][1], pal[i][2], 0], 24 + i * 4);
        udata.set([palN, 0, 0, 0], 56);
        device.queue.writeBuffer(ubuf, 0, udata);

        if (stepNow) {
          const cp = enc.beginComputePass();
          if (reset) {
            cp.setPipeline(pClear);
            cp.setBindGroup(0, bgAB_AB_AB); cp.dispatchWorkgroups(gx, gy);
            cp.setBindGroup(0, bgBA_BA_AB); cp.dispatchWorkgroups(gx, gy);
            for (let s = 0; s < WARMUP; s++) runFluidStep(cp, 8);
          } else {
            runFluidStep(cp, JACOBI_ITERS);
          }
          cp.end();
          lastTick = tick;
        }

        const rp = enc.beginRenderPass({
          colorAttachments: [{ view: out.out.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }],
        });
        rp.setPipeline(pRender); rp.setBindGroup(0, rdBg); rp.draw(3);
        rp.end();
      },
      dispose: () => {
        ubuf.destroy(); velA.destroy(); velB.destroy();
        dyeA.destroy(); dyeB.destroy();
        presA.destroy(); presB.destroy(); auxBuf.destroy();
      },
      status: () => `fluid ${SIM_W}x${SIM_H}`,
    };
  },
});
