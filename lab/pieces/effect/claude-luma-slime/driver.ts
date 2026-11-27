import { definePiece, oklch, type Palette } from '../../../api/index.ts';

// Physarum feeding on the picture. GPU state (not synced): an agent buffer, a ping-ponged trail map
// and an atomic deposit buffer. Per elapsed tick: `steps` x (agents sense trail + food, turn, move,
// deposit, sometimes respawn on the light; then diffuse + decay). Onsets respawn a share of the
// agents on bright spots near a seeded point and flash the veins.

const SIM_BYTES = 80, DRAW_BYTES = 48 + 8 * 16, MAX_CATCHUP = 4, REF_H = 540;

export default definePiece({
  gpu: ({ device, shader }) => {
    const simMod = shader('sim.wgsl'), drawMod = shader('draw.wgsl');
    const C = GPUShaderStage.COMPUTE;
    const bgl = device.createBindGroupLayout({
      label: 'claude-luma-slime sim',
      entries: [
        { binding: 0, visibility: C, buffer: { type: 'uniform' } },
        { binding: 1, visibility: C, buffer: { type: 'storage' } },
        { binding: 2, visibility: C, buffer: { type: 'read-only-storage' } },
        { binding: 3, visibility: C, buffer: { type: 'storage' } },
        { binding: 4, visibility: C, buffer: { type: 'storage' } },
        { binding: 5, visibility: C, sampler: {} },
        { binding: 6, visibility: C, texture: {} },
        { binding: 7, visibility: C, texture: {} },
      ],
    });
    const layout = device.createPipelineLayout({ bindGroupLayouts: [bgl] });
    const cp = (entryPoint: string) => device.createComputePipeline({ label: `claude-luma-slime ${entryPoint}`, layout, compute: { module: simMod, entryPoint } });
    const init = cp('cs_init'), burst = cp('cs_burst'), move = cp('cs_agents'), diffuse = cp('cs_diffuse');
    const draw = device.createRenderPipeline({
      label: 'claude-luma-slime draw', layout: 'auto',
      vertex: { module: drawMod, entryPoint: 'vs_full' },
      fragment: { module: drawMod, entryPoint: 'fs_draw', targets: [{ format: 'rgba16float' }] },
    });
    const smp = device.createSampler({ magFilter: 'linear', minFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' });
    const dummy = device.createTexture({ label: 'claude-luma-slime no luma', size: [1, 1], format: 'r16float', usage: GPUTextureUsage.TEXTURE_BINDING });
    const simU = device.createBuffer({ label: 'claude-luma-slime sim u', size: SIM_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const drawU = device.createBuffer({ label: 'claude-luma-slime draw u', size: DRAW_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const simData = new ArrayBuffer(SIM_BYTES), su = new Uint32Array(simData), sf = new Float32Array(simData);
    const df = new Float32Array(DRAW_BYTES / 4);

    let W = 0, H = 0, N = 0, cur = 0, lastTick = -Infinity;
    let agents: GPUBuffer | null = null, dep: GPUBuffer | null = null, trails: GPUBuffer[] = [];
    let simBg: GPUBindGroup[] = [], drawBg: GPUBindGroup[] = [];
    let boundMedia: GPUTexture | null = null, boundLuma: GPUTexture | null = null;

    const alloc = (w: number, h: number, n: number) => {
      agents?.destroy(); dep?.destroy(); for (const b of trails) b.destroy();
      W = w; H = h; N = n; cur = 0; boundMedia = null;
      const S = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST;
      agents = device.createBuffer({ label: 'claude-luma-slime agents', size: n * 16, usage: S });
      dep = device.createBuffer({ label: 'claude-luma-slime deposit', size: w * h * 4, usage: S });
      trails = [0, 1].map((i) => device.createBuffer({ label: `claude-luma-slime trail ${i}`, size: w * h * 4, usage: S }));
    };
    const bind = (media: GPUTexture, luma: GPUTexture) => {
      if (media === boundMedia && luma === boundLuma && simBg.length) return;
      boundMedia = media; boundLuma = luma;
      const mv = media.createView(), lv = luma.createView();
      simBg = [0, 1].map((i) => device.createBindGroup({
        layout: bgl,
        entries: [
          { binding: 0, resource: { buffer: simU } }, { binding: 1, resource: { buffer: agents! } },
          { binding: 2, resource: { buffer: trails[i] } }, { binding: 3, resource: { buffer: trails[1 - i] } },
          { binding: 4, resource: { buffer: dep! } }, { binding: 5, resource: smp },
          { binding: 6, resource: mv }, { binding: 7, resource: lv },
        ],
      }));
      drawBg = [0, 1].map((i) => device.createBindGroup({
        layout: draw.getBindGroupLayout(0),
        entries: [{ binding: 0, resource: { buffer: drawU } }, { binding: 1, resource: { buffer: trails[i] } }, { binding: 2, resource: smp }, { binding: 3, resource: mv }],
      }));
    };

    return {
      frame({ enc, out, in: ins, params, audio, time, tick, past, rand, width, height }) {
        const media = ins.in as GPUTexture, luma = ins.luma as GPUTexture | undefined;
        const h = Math.round(Math.min(1080, Math.max(135, params.cells as number))), w = Math.max(16, Math.round((h * width) / height));
        const n = Math.round(Math.min(1000, Math.max(10, params.agents as number)) * 1000);
        let fresh = false;
        if (w !== W || h !== H || n !== N) { alloc(w, h, n); fresh = true; }
        bind(media, luma ?? dummy);
        let ticks = tick - lastTick;
        if (fresh || ticks < 0 || ticks > 120) {
          enc.clearBuffer(trails[0]); enc.clearBuffer(trails[1]); enc.clearBuffer(dep!);
          cur = 0; ticks = 1; fresh = true;
        }
        ticks = Math.min(ticks, MAX_CATCHUP);
        lastTick = tick;

        const avg = (lo: number, hi: number, f = audio) => { let s = 0; for (let b = lo; b <= hi; b++) s += f.bands[b]; return s / (hi - lo + 1); };
        let bass = 0, mid = 0;
        for (let ago = 0; ago < 6; ago++) { const f = past(ago); bass += avg(0, 2, f) / 6; mid += avg(5, 10, f) / 6; }
        let kick = 0, onsetAgo = -1;
        for (let ago = 0; ago < 30; ago++) if (past(ago).onset) { kick = Math.max(kick, Math.exp(-ago / 8)); if (onsetAgo < 0) onsetAgo = ago; }

        const s = h / REF_H, react = params.react as number;
        const perCell = N / (W * H), dep0 = params.deposit as number, decay = params.decay as number;
        // equilibrium trail density: the food's weight is set against it, so `food` means the same at any density
        const mean = perCell * dep0 / Math.max(0.01, 1 - decay);
        const ang = ((params.angle as number) * Math.PI / 180) * (1 + 0.8 * react * (mid - 0.3));
        const reach = (params.reach as number) * s * (1 + 1.2 * react * bass);
        const speed = (params.speed as number) * s * (1 + 0.8 * react * audio.rms + 0.6 * kick);
        const deposit = dep0 * (0.6 + 0.8 * audio.rms + 0.6 * kick);
        const burstAmt = params.burst as number;
        const hit = onsetAgo >= 0 && onsetAgo < ticks && burstAmt > 0;
        const bt = tick - Math.max(0, onsetAgo);
        su.set([W, H, N, Math.floor(rand(bt, 3) * 0xffffffff) >>> 0], 0);
        sf.set([Math.max(0.05, ang), Math.max(1, reach), (params.turn as number) * Math.PI / 180, speed], 4);
        sf.set([deposit, decay, params.diffuse as number, (params.food as number) * mean * 2], 8);
        sf.set([hit ? burstAmt : 0, (params.respawn as number) * 0.01], 12);
        su[14] = luma ? 1 : 0;
        sf[15] = Math.min(0.95, params.linger as number);
        sf.set([(0.15 + 0.7 * rand(bt, 4)) * W, (0.15 + 0.7 * rand(bt, 5)) * H, (0.12 + 0.12 * rand(bt, 6)) * H, 0.15], 16);
        device.queue.writeBuffer(simU, 0, simData);

        const gx = Math.ceil(N / 256);
        if (fresh) {
          const p = enc.beginComputePass({ label: 'claude-luma-slime init' });
          p.setPipeline(init); p.setBindGroup(0, simBg[cur]); p.dispatchWorkgroups(gx); p.end();
        }
        const pass = enc.beginComputePass({ label: 'claude-luma-slime' });
        if (hit) { pass.setPipeline(burst); pass.setBindGroup(0, simBg[cur]); pass.dispatchWorkgroups(gx); }
        const steps = Math.max(1, Math.round(params.steps as number)) * ticks;
        const cx = Math.ceil(W / 16), cy = Math.ceil(H / 16);
        for (let i = 0; i < steps; i++) {
          pass.setBindGroup(0, simBg[cur]);
          pass.setPipeline(move); pass.dispatchWorkgroups(gx);
          pass.setPipeline(diffuse); pass.dispatchWorkgroups(cx, cy);
          cur = 1 - cur;
        }
        pass.end();

        const pal = (ins.palette as Palette | undefined)?.stops ?? Array.from({ length: 6 }, (_, i) => oklch(0.3 + i * 0.12, 0.15, audio.pal + i / 9));
        const bps = (audio.bpm > 0 ? audio.bpm : 120) / 60;
        df.fill(0);
        df.set([W, H, Math.min(8, pal.length), params.glow as number], 0);
        df.set([(0.6 / Math.max(0.01, mean)) * (params.exposure as number), params.bg as number, kick * (params.flash as number), audio.rms], 4);
        df.set([(time * bps / 16) * (params.cycle as number), params.saturation as number, 0, 0], 8);
        pal.slice(0, 8).forEach((st, i) => df.set(st, 12 + i * 4));
        device.queue.writeBuffer(drawU, 0, df);
        const rp = enc.beginRenderPass({ colorAttachments: [{ view: out.out.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }] });
        rp.setPipeline(draw); rp.setBindGroup(0, drawBg[cur]); rp.draw(3); rp.end();
      },
      dispose: () => { agents?.destroy(); dep?.destroy(); for (const b of trails) b.destroy(); simU.destroy(); drawU.destroy(); dummy.destroy(); },
      status: () => `${N / 1000}k slime agents, ${W}x${H} trail`,
    };
  },
});
