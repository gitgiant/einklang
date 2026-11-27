import { definePiece, oklch, type Palette } from '../../../api/index.ts';

// Light motes over the picture. GPU state (not synced): one particle buffer (32 B each) stepped once
// per elapsed tick, and an accumulation target the motes are added into each frame before the resolve.

const SIM_BYTES = 80, DRAW_BYTES = 48 + 8 * 16, MAX_CATCHUP = 4;

export default definePiece({
  gpu: ({ device, shader }) => {
    const simMod = shader('sim.wgsl'), drawMod = shader('draw.wgsl');
    const C = GPUShaderStage.COMPUTE;
    const bgl = device.createBindGroupLayout({
      label: 'claude-light-swarm sim',
      entries: [
        { binding: 0, visibility: C, buffer: { type: 'uniform' } },
        { binding: 1, visibility: C, buffer: { type: 'storage' } },
        { binding: 2, visibility: C, sampler: {} },
        { binding: 3, visibility: C, texture: {} },
        { binding: 4, visibility: C, texture: {} },
      ],
    });
    const layout = device.createPipelineLayout({ bindGroupLayouts: [bgl] });
    const cp = (entryPoint: string) => device.createComputePipeline({ label: `claude-light-swarm ${entryPoint}`, layout, compute: { module: simMod, entryPoint } });
    const init = cp('cs_init'), step = cp('cs_step');
    const add: GPUBlendComponent = { operation: 'add', srcFactor: 'one', dstFactor: 'one' };
    const motes = device.createRenderPipeline({
      label: 'claude-light-swarm motes', layout: 'auto',
      vertex: { module: drawMod, entryPoint: 'vs_mote' },
      fragment: { module: drawMod, entryPoint: 'fs_mote', targets: [{ format: 'rgba16float', blend: { color: add, alpha: add } }] },
    });
    const resolve = device.createRenderPipeline({
      label: 'claude-light-swarm resolve', layout: 'auto',
      vertex: { module: drawMod, entryPoint: 'vs_full' },
      fragment: { module: drawMod, entryPoint: 'fs_resolve', targets: [{ format: 'rgba16float' }] },
    });
    const smp = device.createSampler({ magFilter: 'linear', minFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' });
    const dummy = device.createTexture({ label: 'claude-light-swarm no luma', size: [1, 1], format: 'r16float', usage: GPUTextureUsage.TEXTURE_BINDING });
    const simU = device.createBuffer({ label: 'claude-light-swarm sim u', size: SIM_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const drawU = device.createBuffer({ label: 'claude-light-swarm draw u', size: DRAW_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const simData = new ArrayBuffer(SIM_BYTES), su = new Uint32Array(simData), sf = new Float32Array(simData);
    const df = new Float32Array(DRAW_BYTES / 4);

    let N = 0, AW = 0, AH = 0, lastTick = -Infinity;
    let parts: GPUBuffer | null = null, acc: GPUTexture | null = null;
    let simBg: GPUBindGroup | null = null, moteBg: GPUBindGroup | null = null, resBg: GPUBindGroup | null = null;
    let boundMedia: GPUTexture | null = null, boundLuma: GPUTexture | null = null;

    const bind = (media: GPUTexture, luma: GPUTexture) => {
      if (media === boundMedia && luma === boundLuma && simBg) return;
      boundMedia = media; boundLuma = luma;
      const mv = media.createView();
      simBg = device.createBindGroup({
        layout: bgl,
        entries: [
          { binding: 0, resource: { buffer: simU } }, { binding: 1, resource: { buffer: parts! } },
          { binding: 2, resource: smp }, { binding: 3, resource: mv }, { binding: 4, resource: luma.createView() },
        ],
      });
      moteBg = device.createBindGroup({
        layout: motes.getBindGroupLayout(0),
        entries: [{ binding: 0, resource: { buffer: drawU } }, { binding: 1, resource: { buffer: parts! } }],
      });
      resBg = device.createBindGroup({
        layout: resolve.getBindGroupLayout(0),
        entries: [{ binding: 0, resource: { buffer: drawU } }, { binding: 2, resource: smp }, { binding: 3, resource: acc!.createView() }, { binding: 4, resource: mv }],
      });
    };

    return {
      frame({ enc, out, in: ins, params, audio, time, tick, past, rand, width, height }) {
        const media = ins.in as GPUTexture, luma = ins.luma as GPUTexture | undefined;
        const n = Math.round(Math.min(1000, Math.max(4, params.count as number)) * 1000);
        let fresh = false;
        if (n !== N) {
          parts?.destroy(); N = n; boundMedia = null; fresh = true;
          parts = device.createBuffer({ label: 'claude-light-swarm motes', size: n * 32, usage: GPUBufferUsage.STORAGE });
        }
        if (width !== AW || height !== AH) {
          acc?.destroy(); AW = width; AH = height; boundMedia = null;
          acc = device.createTexture({ label: 'claude-light-swarm accum', size: [width, height], format: 'rgba16float', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING });
        }
        bind(media, luma ?? dummy);
        let ticks = tick - lastTick;
        if (fresh || ticks < 0 || ticks > 120) { ticks = 1; fresh = true; }
        ticks = Math.min(ticks, MAX_CATCHUP);
        lastTick = tick;

        const avg = (lo: number, hi: number, f = audio) => { let s = 0; for (let b = lo; b <= hi; b++) s += f.bands[b]; return s / (hi - lo + 1); };
        let bass = 0, mid = 0, loud = 0;
        for (let ago = 0; ago < 6; ago++) { const f = past(ago); bass += avg(0, 2, f) / 6; mid += avg(5, 10, f) / 6; loud += f.rms / 6; }
        let kick = 0, onsetAgo = -1;
        for (let ago = 0; ago < 30; ago++) if (past(ago).onset) { kick = Math.max(kick, Math.exp(-ago / 8)); if (onsetAgo < 0) onsetAgo = ago; }

        const aspect = width / height, react = params.react as number;
        const speed = (params.speed as number) * (0.6 + react * (0.9 * loud + 0.4 * kick));
        const dt = speed / 60;
        const burstAmt = params.burst as number;
        const hit = onsetAgo >= 0 && onsetAgo < ticks && burstAmt > 0;
        const bt = tick - Math.max(0, onsetAgo);
        const bps = (audio.bpm > 0 ? audio.bpm : 120) / 60, beats = time * bps;
        su.set([N, (tick * 2654435761) >>> 0, luma ? 1 : 0, Math.round(params.tries as number)], 0);
        sf.set([aspect, dt, Math.pow(0.5, dt / 0.6), (params.climb as number) * 0.25 * (0.5 + react * bass * 1.2)], 4);
        sf.set([(params.flow as number) * 0.25 * (0.5 + react * mid * 1.5), beats * 0.05, params.scale as number, params.life as number], 8);
        sf.set([(0.15 + 0.7 * rand(bt, 1)) * aspect, 0.15 + 0.7 * rand(bt, 2), 0.18 + 0.12 * rand(bt, 3), hit ? burstAmt * 0.9 : 0], 12);
        sf.set([params.tint as number, 0, 0, 0], 16);
        device.queue.writeBuffer(simU, 0, simData);

        const gx = Math.ceil(N / 256);
        const pass = enc.beginComputePass({ label: 'claude-light-swarm' });
        pass.setBindGroup(0, simBg!);
        if (fresh) { pass.setPipeline(init); pass.dispatchWorkgroups(gx); }
        // catch-up steps share this tick's uniforms
        pass.setPipeline(step);
        for (let t = 0; t < ticks; t++) pass.dispatchWorkgroups(gx);
        pass.end();

        const pal = (ins.palette as Palette | undefined)?.stops ?? Array.from({ length: 6 }, (_, i) => oklch(0.35 + i * 0.11, 0.16, audio.pal + i / 8));
        const size = (params.size as number) * (1 + 0.5 * kick);
        // tone-map gain: expected weight per pixel from the count and the mote area (a soft quad covers ~0.6 of its box)
        const px = size * height, area = 4 * px * px * 0.35 * (1 + (params.streak as number) * 0.3);
        const expected = Math.max(1e-3, (N * area) / (width * height));
        df.fill(0);
        df.set([aspect, size, params.streak as number, (1.2 / expected) * (params.exposure as number)], 0);
        df.set([params.bg as number, kick * (params.flash as number), (beats / 16) * (params.cycle as number), Math.min(8, pal.length)], 4);
        df.set([params.saturation as number, params.glow as number, 0, 0], 8);
        pal.slice(0, 8).forEach((st, i) => df.set(st, 12 + i * 4));
        device.queue.writeBuffer(drawU, 0, df);

        const mp = enc.beginRenderPass({ colorAttachments: [{ view: acc!.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 0] }] });
        mp.setPipeline(motes); mp.setBindGroup(0, moteBg!); mp.draw(6, N); mp.end();
        const rp = enc.beginRenderPass({ colorAttachments: [{ view: out.out.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }] });
        rp.setPipeline(resolve); rp.setBindGroup(0, resBg!); rp.draw(3); rp.end();
      },
      dispose: () => { parts?.destroy(); acc?.destroy(); simU.destroy(); drawU.destroy(); dummy.destroy(); },
      status: () => `${N / 1000}k light motes`,
    };
  },
});
