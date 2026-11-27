import { definePiece, oklch, type Palette } from '../../../api/index.ts';

// Picture slime. GPU state (not synced): an agent buffer, a ping-ponged trail map and an atomic
// deposit buffer. Per elapsed tick: `steps` x (agents sense trail + food, turn, move, deposit; then
// diffuse + decay). The food is the picture's luma, so the web grows over its bright parts and
// redraws the picture in veins. Mids widen the sensors, bass stretches their reach, loudness speeds
// the agents, the beat makes them hungrier (the web snaps to the picture on the beat and wanders
// between), onsets respawn a burst on a ring and flash the veins.

const SIM_BYTES = 80, DRAW_BYTES = 48 + 8 * 16, MAX_CATCHUP = 4, REF_H = 540;

export default definePiece({
  gpu: ({ device, shader, formats }) => {
    const simMod = shader('sim.wgsl'), drawMod = shader('draw.wgsl');
    const C = GPUShaderStage.COMPUTE, Fr = GPUShaderStage.FRAGMENT;
    const bgl = device.createBindGroupLayout({
      label: 'claude-picture-slime sim',
      entries: [
        { binding: 0, visibility: C, buffer: { type: 'uniform' } },
        { binding: 1, visibility: C, buffer: { type: 'storage' } },
        { binding: 2, visibility: C, buffer: { type: 'read-only-storage' } },
        { binding: 3, visibility: C, buffer: { type: 'storage' } },
        { binding: 4, visibility: C, buffer: { type: 'storage' } },
        { binding: 5, visibility: C, sampler: { type: 'filtering' } },
        { binding: 6, visibility: C, texture: { sampleType: 'float' } },
        { binding: 7, visibility: C, texture: { sampleType: 'float' } },
      ],
    });
    const dbgl = device.createBindGroupLayout({
      label: 'claude-picture-slime draw',
      entries: [
        { binding: 0, visibility: Fr, buffer: { type: 'uniform' } },
        { binding: 1, visibility: Fr, buffer: { type: 'read-only-storage' } },
        { binding: 2, visibility: Fr, sampler: { type: 'filtering' } },
        { binding: 3, visibility: Fr, texture: { sampleType: 'float' } },
      ],
    });
    const layout = device.createPipelineLayout({ bindGroupLayouts: [bgl] });
    const cp = (entryPoint: string) => device.createComputePipeline({ label: `claude-picture-slime ${entryPoint}`, layout, compute: { module: simMod, entryPoint } });
    const init = cp('cs_init'), burst = cp('cs_burst'), move = cp('cs_agents'), diffuse = cp('cs_diffuse');
    const draw = device.createRenderPipeline({
      label: 'claude-picture-slime draw', layout: device.createPipelineLayout({ bindGroupLayouts: [dbgl] }),
      vertex: { module: drawMod, entryPoint: 'vs_full' },
      fragment: { module: drawMod, entryPoint: 'fs_draw', targets: [{ format: formats.tex }] },
    });
    const smp = device.createSampler({ magFilter: 'linear', minFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' });
    const dummy = device.createTexture({ label: 'claude-picture-slime dummy', size: [1, 1], format: formats.tex, usage: GPUTextureUsage.TEXTURE_BINDING });
    const simU = device.createBuffer({ label: 'claude-picture-slime sim u', size: SIM_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const drawU = device.createBuffer({ label: 'claude-picture-slime draw u', size: DRAW_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const simData = new ArrayBuffer(SIM_BYTES), su = new Uint32Array(simData), sf = new Float32Array(simData);
    const df = new Float32Array(DRAW_BYTES / 4);

    let W = 0, H = 0, N = 0, cur = 0, lastTick = -Infinity;
    let agents: GPUBuffer | null = null, dep: GPUBuffer | null = null, trails: GPUBuffer[] = [];
    let simBg: GPUBindGroup[] = [], drawBg: GPUBindGroup[] = [];
    let lastPic: unknown = null, lastLuma: unknown = null;

    const alloc = (w: number, h: number, n: number) => {
      agents?.destroy(); dep?.destroy(); for (const b of trails) b.destroy();
      W = w; H = h; N = n; cur = 0; lastPic = lastLuma = null;
      const S = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST;
      agents = device.createBuffer({ label: 'claude-picture-slime agents', size: n * 16, usage: S });
      dep = device.createBuffer({ label: 'claude-picture-slime deposit', size: w * h * 4, usage: S });
      trails = [0, 1].map((i) => device.createBuffer({ label: `claude-picture-slime trail ${i}`, size: w * h * 4, usage: S }));
    };
    const groups = (pic: GPUTexture | undefined, luma: GPUTexture | undefined) => {
      const pv = (pic ?? dummy).createView(), lv = (luma ?? dummy).createView();
      simBg = [0, 1].map((i) => device.createBindGroup({
        layout: bgl,
        entries: [
          { binding: 0, resource: { buffer: simU } }, { binding: 1, resource: { buffer: agents! } },
          { binding: 2, resource: { buffer: trails[i] } }, { binding: 3, resource: { buffer: trails[1 - i] } },
          { binding: 4, resource: { buffer: dep! } }, { binding: 5, resource: smp },
          { binding: 6, resource: lv }, { binding: 7, resource: pv },
        ],
      }));
      drawBg = [0, 1].map((i) => device.createBindGroup({
        layout: dbgl,
        entries: [{ binding: 0, resource: { buffer: drawU } }, { binding: 1, resource: { buffer: trails[i] } }, { binding: 2, resource: smp }, { binding: 3, resource: pv }],
      }));
    };

    return {
      frame({ enc, out, in: ins, params, audio, time, tick, past, rand, width, height }) {
        const h = Math.round(Math.min(1080, Math.max(135, params.cells as number))), w = Math.max(16, Math.round((h * width) / height));
        const n = Math.round(Math.min(1000, Math.max(10, params.agents as number)) * 1000);
        let fresh = false;
        if (w !== W || h !== H || n !== N) { alloc(w, h, n); fresh = true; }
        const pic = ins.in as GPUTexture | undefined, luma = ins.luma as GPUTexture | undefined;
        if (pic !== lastPic || luma !== lastLuma) { groups(pic, luma); lastPic = pic; lastLuma = luma; }
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
        const beatEnv = Math.exp(-audio.phase * 4);

        const s = h / REF_H, react = params.react as number;
        const ang = ((params.angle as number) * Math.PI / 180) * (1 + 0.8 * react * (mid - 0.3));
        const reach = (params.reach as number) * s * (1 + 1.2 * react * bass);
        const speed = (params.speed as number) * s * (1 + 0.8 * react * audio.rms);
        const deposit = (params.deposit as number) * (0.6 + 0.8 * audio.rms + 0.6 * kick);
        const decay = params.decay as number;
        // the equilibrium trail per cell: food and crowding are scaled to it, so they mean the same at any size
        const perCell = N / (W * H), mean = Math.max(0.01, perCell * (params.deposit as number) / Math.max(0.01, 1 - decay));
        const hunger = (params.food as number) * mean * 3 * (1 + (params.hunger as number) * react * (beatEnv - 0.35));
        const fillSim = (seed: number, burstFrac: number, bx: number, by: number, br: number) => {
          su.set([W, H, N, seed >>> 0], 0);
          sf.set([Math.max(0.05, ang), Math.max(1, reach), (params.turn as number) * Math.PI / 180, speed], 4);
          sf.set([deposit, decay, params.diffuse as number, Math.max(0, hunger)], 8);
          sf.set([bx, by, br, burstFrac], 12);
          sf.set([params.contrast as number, 0.15, luma ? 1 : 0, (params.spread as number) / (4 * mean)], 16);
          device.queue.writeBuffer(simU, 0, simData);
        };

        const burstAmt = params.burst as number;
        const hit = onsetAgo >= 0 && onsetAgo < ticks && burstAmt > 0;
        const bt = tick - Math.max(0, onsetAgo);
        fillSim(Math.floor(rand(bt, 3) * 0xffffffff), hit ? burstAmt : 0,
          (0.2 + 0.6 * rand(bt, 4)) * W, (0.2 + 0.6 * rand(bt, 5)) * H, (0.06 + 0.1 * rand(bt, 6)) * H);

        const gx = Math.ceil(N / 256);
        if (fresh) {
          const p = enc.beginComputePass({ label: 'claude-picture-slime init' });
          p.setPipeline(init); p.setBindGroup(0, simBg[cur]); p.dispatchWorkgroups(gx); p.end();
        }
        const pass = enc.beginComputePass({ label: 'claude-picture-slime' });
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

        const pal = (ins.palette as Palette | undefined)?.stops ?? Array.from({ length: 6 }, (_, i) => oklch(0.25 + i * 0.13, 0.14, audio.pal + i / 10));
        const bps = (audio.bpm > 0 ? audio.bpm : 120) / 60;
        df.fill(0);
        df.set([W, H, Math.min(8, pal.length), params.glow as number, kick * (params.flash as number), audio.rms, (time * bps / 16) * (params.cycle as number), params.colour as number], 0);
        df.set([(0.6 / mean) * (params.exposure as number), params.under as number, params.saturation as number, 0], 8);
        pal.slice(0, 8).forEach((st, i) => df.set(st, 12 + i * 4));
        device.queue.writeBuffer(drawU, 0, df);
        const rp = enc.beginRenderPass({ colorAttachments: [{ view: out.out.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }] });
        rp.setPipeline(draw); rp.setBindGroup(0, drawBg[cur]); rp.draw(3); rp.end();
      },
      dispose: () => { agents?.destroy(); dep?.destroy(); for (const b of trails) b.destroy(); simU.destroy(); drawU.destroy(); dummy.destroy(); },
      status: () => `${N / 1000}k agents, ${W}x${H} trail`,
    };
  },
});
