import { definePiece, oklch, BAR_TICKS, TICKS_PER_BEAT, type Palette } from '../../../api/index.ts';

// Media dye. GPU state (not synced): a velocity grid (`cells` high), pressure + divergence at the same
// size, and the dye (the picture's colours, `res` high), all ping-ponged textures. Per elapsed tick
// (at most 2 per frame): velocity pass, divergence, `iters` Jacobi steps, projection, dye advection.
// The stirrers are closed-form in time; onsets kick, and the picture re-forms at every phrase start.

const U_BYTES = 72 * 4, MAX_CATCHUP = 2, PHRASE = 4 * BAR_TICKS;

export default definePiece({
  gpu: ({ device, shader }) => {
    const mod = shader('fluid.wgsl');
    const F = GPUShaderStage.FRAGMENT;
    const bgl0 = device.createBindGroupLayout({
      label: 'claude-media-dye own',
      entries: [
        { binding: 0, visibility: F, buffer: { type: 'uniform' } },
        { binding: 1, visibility: F, sampler: { type: 'filtering' } },
        { binding: 2, visibility: F, texture: { sampleType: 'float' } },
        { binding: 3, visibility: F, texture: { sampleType: 'float' } },
      ],
    });
    const bgl1 = device.createBindGroupLayout({
      label: 'claude-media-dye media',
      entries: [0, 1, 2].map((binding) => ({ binding, visibility: F, texture: { sampleType: 'float' as const } })),
    });
    const layout = device.createPipelineLayout({ bindGroupLayouts: [bgl0, bgl1] });
    const pipe = (entryPoint: string, format: GPUTextureFormat) => device.createRenderPipeline({
      label: `claude-media-dye ${entryPoint}`, layout,
      vertex: { module: mod, entryPoint: 'vs_full' },
      fragment: { module: mod, entryPoint, targets: [{ format }] },
    });
    const P = {
      vel: pipe('fs_vel', 'rgba16float'), div: pipe('fs_div', 'r16float'), jacobi: pipe('fs_jacobi', 'r16float'),
      project: pipe('fs_project', 'rgba16float'), dye: pipe('fs_dye', 'rgba16float'), draw: pipe('fs_draw', 'rgba16float'),
    };
    const samp = device.createSampler({ magFilter: 'linear', minFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' });
    const ubuf = device.createBuffer({ label: 'claude-media-dye u', size: U_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const uf = new Float32Array(U_BYTES / 4);

    let W = 0, H = 0, DW = 0, DH = 0, cur = 0, lastTick = -Infinity;
    let texs: GPUTexture[] = [];
    let vel: GPUTexture[] = [], prs: GPUTexture[] = [], div: GPUTexture | null = null, dye: GPUTexture[] = [];
    let bg: Record<string, GPUBindGroup> = {};

    const tex = (w: number, h: number, format: GPUTextureFormat, label: string) => {
      const t = device.createTexture({ label: `claude-media-dye ${label}`, size: [w, h], format, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING });
      texs.push(t);
      return t;
    };
    const group = (a: GPUTexture, b: GPUTexture) => device.createBindGroup({
      layout: bgl0,
      entries: [{ binding: 0, resource: { buffer: ubuf } }, { binding: 1, resource: samp }, { binding: 2, resource: a.createView() }, { binding: 3, resource: b.createView() }],
    });
    const alloc = (w: number, h: number, dw: number, dh: number) => {
      for (const t of texs) t.destroy();
      texs = [];
      W = w; H = h; DW = dw; DH = dh; cur = 0;
      vel = [tex(w, h, 'rgba16float', 'vel 0'), tex(w, h, 'rgba16float', 'vel 1')];
      prs = [tex(w, h, 'r16float', 'p 0'), tex(w, h, 'r16float', 'p 1')];
      div = tex(w, h, 'r16float', 'div');
      dye = [tex(dw, dh, 'rgba16float', 'dye 0'), tex(dw, dh, 'rgba16float', 'dye 1')];
      bg = {
        vel: group(vel[0], prs[0]), div: group(vel[1], prs[0]), jac0: group(prs[0], div), jac1: group(prs[1], div),
        project: group(vel[1], prs[0]), dye0: group(dye[0], vel[0]), dye1: group(dye[1], vel[0]),
      };
    };
    const pass = (enc: GPUCommandEncoder, target: GPUTexture, p: GPURenderPipeline, g0: GPUBindGroup, g1: GPUBindGroup) => {
      const rp = enc.beginRenderPass({ colorAttachments: [{ view: target.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }] });
      rp.setPipeline(p); rp.setBindGroup(0, g0); rp.setBindGroup(1, g1); rp.draw(3); rp.end();
    };
    const clear = (enc: GPUCommandEncoder, t: GPUTexture) =>
      enc.beginRenderPass({ colorAttachments: [{ view: t.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }] }).end();

    return {
      frame({ enc, out, in: ins, params, audio, time, tick, past, rand, width, height }) {
        const h = Math.round(Math.min(360, Math.max(64, params.cells as number))), w = Math.max(16, Math.round((h * width) / height));
        const dh = Math.round(Math.min(1080, Math.max(270, params.res as number))), dw = Math.max(16, Math.round((dh * width) / height));
        let fresh = false;
        if (w !== W || h !== H || dw !== DW || dh !== DH) { alloc(w, h, dw, dh); fresh = true; }
        let ticks = tick - lastTick;
        if (fresh || ticks < 0 || ticks > 120) { fresh = true; ticks = 1; for (const t of [...vel, ...prs]) clear(enc, t); }
        ticks = Math.min(ticks, MAX_CATCHUP);
        lastTick = tick;

        const media = device.createBindGroup({
          layout: bgl1,
          entries: [ins.in, ins.luma, ins.edges].map((t, binding) => ({ binding, resource: (t as GPUTexture).createView() })),
        });

        // a short smoothing keeps the stirrers from twitching on every hat
        let bass = 0;
        for (let ago = 0; ago < 5; ago++) { const f = past(ago); bass += (f.bands[0] + f.bands[1] + f.bands[2]) / 15; }
        let kickEnv = 0, onsetAgo = -1;
        for (let ago = 0; ago < 24; ago++) if (past(ago).onset) { kickEnv = Math.max(kickEnv, Math.exp(-ago / 6)); if (onsetAgo < 0) onsetAgo = ago; }
        const hit = onsetAgo >= 0 && onsetAgo < ticks;

        const aspect = width / height, react = params.react as number;
        const drive = (params.stir as number) * 0.06 * ((params.idle as number) + react * bass * bass * 1.6);
        uf.fill(0);
        uf.set([W, H, DW, DH], 0);
        for (let i = 0; i < 4; i++) {
          // four stirrers on slow Lissajous paths, alternating spin; the bass winds them up
          const ph = rand(i, 71) * 6.283, fx = 0.07 + 0.05 * rand(i, 72), fy = 0.06 + 0.05 * rand(i, 73);
          const x = 0.5 + 0.34 * Math.sin(time * fx * 6.283 / 4 + ph), y = 0.5 + 0.3 * Math.sin(time * fy * 6.283 / 4 + ph * 1.7);
          uf.set([x, y, 0.16 + 0.06 * rand(i, 74), drive * (i % 2 ? -1 : 1) * (0.7 + 0.6 * rand(i, 75))], 4 + i * 4);
        }
        const bt = tick - Math.max(0, onsetAgo);
        uf.set([0.15 + 0.7 * rand(bt, 81), 0.2 + 0.6 * rand(bt, 82), 0.12 + 0.08 * rand(bt, 83), hit ? 1.4 * (params.kick as number) : 0], 20);
        uf.set([(params.edge as number) * 0.03 * (0.35 + react * bass), params.along as number, (params.buoy as number) * 0.01, (params.vort as number) * 0.3], 24);
        const tp = ((tick % PHRASE) + PHRASE) % PHRASE;
        const env = Math.exp(-tp / TICKS_PER_BEAT);
        const relax = fresh ? 1 : Math.min(1, (params.resurface as number) * 0.03 + (params.reform as number) * env * 0.25 + (params.beat as number) * (hit ? 0.15 : 0.02 * kickEnv));
        uf.set([1 - (params.drag as number), relax, params.tint as number, params.gloss as number], 28);
        const bps = (audio.bpm > 0 ? audio.bpm : 120) / 60;
        const pal = (ins.palette as Palette | undefined)?.stops ?? Array.from({ length: 6 }, (_, i) => oklch(0.35 + i * 0.1, 0.13, audio.pal + i / 9));
        uf.set([kickEnv, audio.rms, (time * bps / 16) * (params.cycle as number), Math.min(8, pal.length)], 32);
        uf.set([aspect, 0.004 + 0.01 * (params.idle as number), time, params.glow as number], 36);
        pal.slice(0, 8).forEach((s, i) => uf.set(s, 40 + i * 4));
        device.queue.writeBuffer(ubuf, 0, uf);

        if (ticks > 0) {
          const iters = Math.max(2, Math.round((params.iters as number) / 2) * 2);
          for (let k = 0; k < ticks; k++) {
            pass(enc, vel[1], P.vel, bg.vel, media);
            pass(enc, div!, P.div, bg.div, media);
            for (let i = 0; i < iters; i++) pass(enc, prs[1 - (i & 1)], P.jacobi, i & 1 ? bg.jac1 : bg.jac0, media);
            pass(enc, vel[0], P.project, bg.project, media);
            pass(enc, dye[1 - cur], P.dye, cur ? bg.dye1 : bg.dye0, media);
            cur = 1 - cur;
          }
        }
        pass(enc, out.out, P.draw, cur ? bg.dye1 : bg.dye0, media);
      },
      dispose: () => { for (const t of texs) t.destroy(); ubuf.destroy(); },
      status: () => `${W}x${H} flow, ${DW}x${DH} dye`,
    };
  },
});
