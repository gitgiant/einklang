import { definePiece, oklch, type Palette } from '../../../api/index.ts';

// Picture smoke. GPU state (not synced): ping-ponged velocity, pressure and dye textures plus curl
// and divergence. Per elapsed tick, one fluid step (see smoke.wgsl); the dye is advected and relaxed
// back toward the input picture, fastest just after each beat, so the image re-forms on the beat and
// smears into smoke between them. The bass spins the swirls, onsets blow a burst out of a seeded spot,
// the mids lift the bright parts like hot air, the highs sharpen the eddies.

const U_FLOATS = 92, MAX_CATCHUP = 4;
const SWIRLS = 4;

export default definePiece({
  gpu: ({ device, shader, formats }) => {
    const mod = shader('smoke.wgsl');
    const F = GPUShaderStage.FRAGMENT;
    const tex = { sampleType: 'float' } as const;
    const bgl = device.createBindGroupLayout({
      label: 'claude-picture-smoke',
      entries: [
        { binding: 0, visibility: F, buffer: { type: 'uniform' } },
        { binding: 1, visibility: F, sampler: { type: 'filtering' } },
        { binding: 2, visibility: F, texture: tex }, { binding: 3, visibility: F, texture: tex },
        { binding: 4, visibility: F, texture: tex }, { binding: 5, visibility: F, texture: tex },
      ],
    });
    const layout = device.createPipelineLayout({ bindGroupLayouts: [bgl] });
    const rp = (entryPoint: string) => device.createRenderPipeline({
      label: `claude-picture-smoke ${entryPoint}`, layout,
      vertex: { module: mod, entryPoint: 'vs_full' },
      fragment: { module: mod, entryPoint, targets: [{ format: formats.tex }] },
    });
    const P = { curl: rp('fs_curl'), vel: rp('fs_vel'), div: rp('fs_div'), jac: rp('fs_jacobi'), grad: rp('fs_grad'), dye: rp('fs_dye'), draw: rp('fs_draw') };
    const smp = device.createSampler({ magFilter: 'linear', minFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' });
    const ubuf = device.createBuffer({ label: 'claude-picture-smoke u', size: U_FLOATS * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const uf = new Float32Array(U_FLOATS);
    const usage = GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT;
    const dummy = device.createTexture({ label: 'claude-picture-smoke dummy', size: [1, 1], format: formats.tex, usage });

    let W = 0, H = 0, DW = 0, DH = 0, lastTick = -Infinity, cur = 0;
    let T: Record<string, GPUTexture> = {};
    let V: Record<string, GPUTextureView> = {};
    let lastIn: unknown = null, lastLuma: unknown = null;
    let BG: Record<string, GPUBindGroup> = {};

    const alloc = (w: number, h: number, dw: number, dh: number) => {
      for (const t of Object.values(T)) t.destroy();
      W = w; H = h; DW = dw; DH = dh; cur = 0;
      const mk = (label: string, x: number, y: number) => device.createTexture({ label: `claude-picture-smoke ${label}`, size: [x, y], format: formats.tex, usage });
      T = { v0: mk('v0', w, h), v1: mk('v1', w, h), p0: mk('p0', w, h), p1: mk('p1', w, h), curl: mk('curl', w, h), div: mk('div', w, h), d0: mk('d0', dw, dh), d1: mk('d1', dw, dh) };
      V = Object.fromEntries(Object.entries(T).map(([k, t]) => [k, t.createView()]));
      lastIn = null;
    };
    const group = (a: GPUTextureView, b: GPUTextureView, m: GPUTextureView, l: GPUTextureView) => device.createBindGroup({
      layout: bgl,
      entries: [{ binding: 0, resource: { buffer: ubuf } }, { binding: 1, resource: smp }, { binding: 2, resource: a }, { binding: 3, resource: b }, { binding: 4, resource: m }, { binding: 5, resource: l }],
    });

    return {
      frame({ enc, out, in: ins, params, audio, time, tick, past, rand, width, height }) {
        const h = Math.round(Math.min(360, Math.max(64, params.cells as number))), w = Math.max(16, Math.round((h * width) / height));
        const dh = Math.round(Math.min(1080, Math.max(180, params.res as number))), dw = Math.max(16, Math.round((dh * width) / height));
        let fresh = false;
        if (w !== W || h !== H || dw !== DW || dh !== DH) { alloc(w, h, dw, dh); fresh = true; }
        let ticks = tick - lastTick;
        if (fresh || ticks < 0 || ticks > 120) { ticks = 1; fresh = true; }
        ticks = Math.min(ticks, MAX_CATCHUP);
        lastTick = tick;

        const pic = ins.in as GPUTexture, lumaT = ins.luma as GPUTexture | undefined;
        if (pic !== lastIn || lumaT !== lastLuma) {
          lastIn = pic; lastLuma = lumaT;
          const m = pic.createView(), l = (lumaT ?? dummy).createView(), z = dummy.createView();
          BG = {
            curl: group(V.v0, z, m, l), vel: group(V.v0, V.curl, m, l), div: group(V.v1, z, m, l),
            jac0: group(V.p0, V.div, m, l), jac1: group(V.p1, V.div, m, l), grad: group(V.v1, V.p0, m, l),
            dye0: group(V.d0, V.v0, m, l), dye1: group(V.d1, V.v0, m, l),
            draw0: group(V.d0, V.v0, m, l), draw1: group(V.d1, V.v0, m, l),
          };
        }

        // the music, smoothed a little so the swirls don't twitch on every hat
        const avg = (lo: number, hi: number, f = audio) => { let s = 0; for (let b = lo; b <= hi; b++) s += f.bands[b]; return s / (hi - lo + 1); };
        let bass = 0, mid = 0, high = 0;
        for (let ago = 0; ago < 6; ago++) { const f = past(ago); bass += avg(0, 2, f) / 6; mid += avg(4, 9, f) / 6; high += avg(10, 15, f) / 6; }
        let kick = 0, onsetAgo = -1;
        for (let ago = 0; ago < 30; ago++) if (past(ago).onset) { kick = Math.max(kick, Math.exp(-ago / 8)); if (onsetAgo < 0) onsetAgo = ago; }
        // the beat envelope: 1 on the beat, falling over the beat
        const beatEnv = Math.exp(-audio.phase * 5);

        const react = params.react as number, s = h / 192, aspect = width / height, dt = 1 / 60;
        const swirls = Math.max(0, Math.min(SWIRLS, Math.round(params.swirls as number)));
        const spin = (params.spin as number) * 120 * s * ((params.idle as number) + react * bass * 1.6);
        const breath = (params.breath as number) * 90 * s * react * (0.3 * bass + beatEnv * (0.4 + audio.rms));
        uf.fill(0);
        uf.set([W, H, DW, DH], 0);
        const keep = Math.pow(0.5, dt / Math.max(0.05, params.memory as number));
        uf.set([dt, keep, (params.vorticity as number) * 12 * (1 + react * 1.5 * high), (params.buoyancy as number) * 70 * s * (0.4 + react * 1.2 * mid)], 4);
        // relax rate per second: the base, plus a surge right after each beat
        const rate = (params.restore as number) * (0.5 + 2.5 * (params.snap as number) * beatEnv * (0.5 + react * 0.5));
        uf.set([1 - Math.exp(-rate * dt), 1 - (params.fade as number) * dt, lumaT ? 1 : 0, fresh ? 1 : 0], 8);
        // onset burst since the last frame, at a seeded spot
        const burstAmt = params.burst as number;
        const hit = onsetAgo >= 0 && onsetAgo < ticks && burstAmt > 0;
        const bt = tick - Math.max(0, onsetAgo);
        if (hit) {
          uf.set([0.2 + 0.6 * rand(bt, 1), 0.2 + 0.6 * rand(bt, 2), 0.08 + 0.1 * rand(bt, 3), burstAmt * 400 * s], 12);
          uf.set([burstAmt * 300 * s * (rand(bt, 4) - 0.5) * 2, 0, 0, 0], 16);
        }
        for (let k = 0; k < swirls; k++) {
          // slow Lissajous paths, alternate spin directions
          const x = 0.5 + 0.32 * Math.sin(time * (0.11 + 0.03 * k) + k * 2.1), y = 0.5 + 0.3 * Math.sin(time * (0.15 + 0.02 * k) + k * 1.3 + 0.7);
          uf.set([x, y, (params.size as number) * (0.8 + 0.3 * Math.sin(k * 1.7 + time * 0.2)), spin * (k % 2 ? -1 : 1)], 20 + k * 4);
          uf.set([breath, 0, 0, 0], 36 + k * 4);
        }
        const bps = (audio.bpm > 0 ? audio.bpm : 120) / 60;
        const pal = (ins.palette as Palette | undefined)?.stops ?? Array.from({ length: 6 }, (_, i) => oklch(0.3 + i * 0.12, 0.15, audio.pal + i / 8));
        uf.set([params.exposure as number, kick * (params.flash as number), params.sheen as number, params.saturation as number], 52);
        uf.set([Math.min(8, pal.length), (time * bps / 16) * (params.cycle as number), aspect, swirls], 56);
        pal.slice(0, 8).forEach((st, i) => uf.set(st, 60 + i * 4));
        device.queue.writeBuffer(ubuf, 0, uf);

        const pass = (target: GPUTextureView, pipe: GPURenderPipeline, bg: GPUBindGroup | null) => {
          const r = enc.beginRenderPass({ colorAttachments: [{ view: target, loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }] });
          if (bg) { r.setPipeline(pipe); r.setBindGroup(0, bg); r.draw(3); }
          r.end();
        };
        if (fresh) { pass(V.v0, P.curl, null); pass(V.p0, P.curl, null); }
        const iters = Math.max(2, Math.round((params.iters as number) / 2) * 2);
        for (let t = 0; t < ticks; t++) {
          pass(V.curl, P.curl, BG.curl);
          pass(V.v1, P.vel, BG.vel);
          pass(V.div, P.div, BG.div);
          for (let j = 0; j < iters; j += 2) { pass(V.p1, P.jac, BG.jac0); pass(V.p0, P.jac, BG.jac1); }
          pass(V.v0, P.grad, BG.grad);
          pass(cur ? V.d0 : V.d1, P.dye, cur ? BG.dye1 : BG.dye0);
          cur = 1 - cur;
        }
        pass(out.out.createView(), P.draw, cur ? BG.draw1 : BG.draw0);
      },
      dispose: () => { for (const t of Object.values(T)) t.destroy(); dummy.destroy(); ubuf.destroy(); },
      status: () => `${W}x${H} fluid, ${DW}x${DH} dye`,
    };
  },
});
