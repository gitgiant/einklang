import { definePiece, oklch, oklabToLinear, BAR_TICKS, TICKS_PER_BEAT, type Palette } from '../../../api/index.ts';

const mixStops = (stops: [number, number, number][], x: number): [number, number, number] => {
  if (stops.length < 2) return stops[0] ?? [0.6, 0, 0];
  const f = x * (stops.length - 1), i = Math.min(stops.length - 2, Math.floor(f)), t = f - i;
  return [0, 1, 2].map((j) => stops[i][j] + (stops[i + 1][j] - stops[i][j]) * t) as [number, number, number];
};

// Media erosion. GPU state (not synced): the ground / water / sediment state and the pipe flux
// (rgba32f, `cells` high), velocity and a filterable copy of the state for drawing (rgba16f), and the
// pigment (the picture's colours or its ink, `res` high). Per elapsed tick (at most 2 per frame):
// `steps` substeps of flux -> water balance + erosion -> sediment transport, then one pigment pass.
// Each substep has its own uniform block (dynamic offset) so rain drops and the onset flood vary.

const U_FLOATS = 72, STRIDE = 512, MAX_CATCHUP = 2, MAX_STEPS = 8, PHRASE = 4 * BAR_TICKS;
const BLOCKS = MAX_CATCHUP * MAX_STEPS + 1;

export default definePiece({
  gpu: ({ device, shader }) => {
    const mod = shader('erode.wgsl');
    const F = GPUShaderStage.FRAGMENT;
    const bgl0 = device.createBindGroupLayout({
      label: 'claude-media-erode own',
      entries: [
        { binding: 0, visibility: F, buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: U_FLOATS * 4 } },
        { binding: 1, visibility: F, sampler: { type: 'filtering' } },
        { binding: 2, visibility: F, texture: { sampleType: 'unfilterable-float' } },
        { binding: 3, visibility: F, texture: { sampleType: 'unfilterable-float' } },
        { binding: 4, visibility: F, texture: { sampleType: 'float' } },
        { binding: 5, visibility: F, texture: { sampleType: 'float' } },
      ],
    });
    const bgl1 = device.createBindGroupLayout({
      label: 'claude-media-erode media',
      entries: [0, 1, 2].map((binding) => ({ binding, visibility: F, texture: { sampleType: 'float' as const } })),
    });
    const layout = device.createPipelineLayout({ bindGroupLayouts: [bgl0, bgl1] });
    const pipe = (entryPoint: string, formats: GPUTextureFormat[]) => device.createRenderPipeline({
      label: `claude-media-erode ${entryPoint}`, layout,
      vertex: { module: mod, entryPoint: 'vs_full' },
      fragment: { module: mod, entryPoint, targets: formats.map((format) => ({ format })) },
    });
    const P = {
      flux: pipe('fs_flux', ['rgba32float']),
      update: pipe('fs_update', ['rgba32float', 'rgba16float']),
      move: pipe('fs_move', ['rgba32float', 'rgba16float']),
      pig: pipe('fs_pig', ['rgba16float']),
      draw: pipe('fs_draw', ['rgba16float']),
    };
    const samp = device.createSampler({ magFilter: 'linear', minFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' });
    const ubuf = device.createBuffer({ label: 'claude-media-erode u', size: STRIDE * BLOCKS, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const uf = new Float32Array((STRIDE * BLOCKS) / 4);
    const usage = GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING;
    const d32 = device.createTexture({ label: 'claude-media-erode dummy32', size: [1, 1], format: 'rgba32float', usage });
    const d16 = device.createTexture({ label: 'claude-media-erode dummy16', size: [1, 1], format: 'rgba16float', usage });

    let W = 0, H = 0, PW = 0, PH = 0, fcur = 0, pcur = 0, lastTick = -Infinity;
    let texs: GPUTexture[] = [];
    let S: GPUTexture, Stmp: GPUTexture, Fx: GPUTexture[] = [], V: GPUTexture, view: GPUTexture, pig: GPUTexture[] = [];
    let bg: Record<string, GPUBindGroup> = {};

    const tex = (w: number, h: number, format: GPUTextureFormat, label: string) => {
      const t = device.createTexture({ label: `claude-media-erode ${label}`, size: [w, h], format, usage });
      texs.push(t);
      return t;
    };
    const group = (a: GPUTexture, b: GPUTexture, c: GPUTexture, d: GPUTexture) => device.createBindGroup({
      layout: bgl0,
      entries: [
        { binding: 0, resource: { buffer: ubuf, size: U_FLOATS * 4 } }, { binding: 1, resource: samp },
        { binding: 2, resource: a.createView() }, { binding: 3, resource: b.createView() },
        { binding: 4, resource: c.createView() }, { binding: 5, resource: d.createView() },
      ],
    });
    const alloc = (w: number, h: number, pw: number, ph: number) => {
      for (const t of texs) t.destroy();
      texs = [];
      W = w; H = h; PW = pw; PH = ph; fcur = 0; pcur = 0;
      S = tex(w, h, 'rgba32float', 'state'); Stmp = tex(w, h, 'rgba32float', 'state tmp');
      Fx = [tex(w, h, 'rgba32float', 'flux 0'), tex(w, h, 'rgba32float', 'flux 1')];
      V = tex(w, h, 'rgba16float', 'vel'); view = tex(w, h, 'rgba16float', 'view');
      pig = [tex(pw, ph, 'rgba16float', 'pig 0'), tex(pw, ph, 'rgba16float', 'pig 1')];
      bg = {
        flux0: group(S, Fx[0], d16, d16), flux1: group(S, Fx[1], d16, d16),
        upd0: group(S, Fx[0], d16, d16), upd1: group(S, Fx[1], d16, d16),
        move: group(Stmp, d32, V, d16),
        pig0: group(d32, d32, pig[0], V), pig1: group(d32, d32, pig[1], V),
        draw0: group(d32, d32, view, pig[0]), draw1: group(d32, d32, view, pig[1]),
      };
    };
    const pass = (enc: GPUCommandEncoder, targets: GPUTexture[], p: GPURenderPipeline, g0: GPUBindGroup, block: number, g1: GPUBindGroup) => {
      const rp = enc.beginRenderPass({ colorAttachments: targets.map((t) => ({ view: t.createView(), loadOp: 'clear' as const, storeOp: 'store' as const, clearValue: [0, 0, 0, 0] })) });
      rp.setPipeline(p); rp.setBindGroup(0, g0, [block * STRIDE]); rp.setBindGroup(1, g1); rp.draw(3); rp.end();
    };
    const clear = (enc: GPUCommandEncoder, t: GPUTexture) =>
      enc.beginRenderPass({ colorAttachments: [{ view: t.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 0] }] }).end();

    return {
      frame({ enc, out, in: ins, params, audio, time, tick, past, rand, width, height }) {
        const h = Math.round(Math.min(540, Math.max(135, params.cells as number))), w = Math.max(16, Math.round((h * width) / height));
        const ph = Math.round(Math.min(1080, Math.max(270, params.res as number))), pw = Math.max(16, Math.round((ph * width) / height));
        let fresh = false;
        if (w !== W || h !== H || pw !== PW || ph !== PH) { alloc(w, h, pw, ph); fresh = true; }
        let ticks = tick - lastTick;
        if (fresh || ticks < 0 || ticks > 120) { fresh = true; ticks = 1; for (const t of [S, Stmp, ...Fx, V, view]) clear(enc, t); }
        ticks = Math.min(ticks, MAX_CATCHUP);
        lastTick = tick;

        const media = device.createBindGroup({
          layout: bgl1,
          entries: [ins.in, ins.luma, ins.edges].map((t, binding) => ({ binding, resource: (t as GPUTexture).createView() })),
        });

        let bass = 0;
        for (let ago = 0; ago < 5; ago++) { const f = past(ago); bass += (f.bands[0] + f.bands[1] + f.bands[2]) / 15; }
        let kickEnv = 0, onsetAgo = -1;
        for (let ago = 0; ago < 24; ago++) if (past(ago).onset) { kickEnv = Math.max(kickEnv, Math.exp(-ago / 6)); if (onsetAgo < 0) onsetAgo = ago; }

        const look = params.look as number, react = params.react as number, idle = params.idle as number;
        const steps = Math.round(Math.min(MAX_STEPS, Math.max(1, params.steps as number)));
        const drive = idle + react * bass * bass * 2;
        const bps = (audio.bpm > 0 ? audio.bpm : 120) / 60;
        const phrase = Math.floor(tick / PHRASE);
        const tp = ((tick % PHRASE) + PHRASE) % PHRASE;
        const env = Math.exp(-tp / TICKS_PER_BEAT);
        // the bass tips the picture: a direction per phrase that sways every two bars
        const ang = rand(phrase, 91) * 6.283 + 0.8 * Math.sin((time * bps / 8) * 6.283);
        const tmag = 0.012 * (params.tilt as number) * drive;
        const pal = (ins.palette as Palette | undefined)?.stops ?? Array.from({ length: 6 }, (_, i) => oklch(0.35 + i * 0.1, 0.13, audio.pal + i / 9));
        const aspect = width / height;
        const relax = fresh ? 1 : (params.resurface as number) * 0.0015 + (params.reform as number) * env * 0.03;

        const fill = (block: number, k: number, tk: number, hit: boolean) => {
          const o = block * (STRIDE / 4);
          uf.fill(0, o, o + U_FLOATS);
          uf.set([W, H, PW, PH], o);
          uf.set([Math.cos(ang) * tmag, Math.sin(ang) * tmag, 0.001 * (params.rain as number) * drive, params.relief as number], o + 4);
          uf.set([0.15 + 0.7 * rand(tk, 81), 0.15 + 0.7 * rand(tk, 82), (0.08 + 0.08 * rand(tk, 83)) * (look ? 1.25 : 1), hit && k === 0 ? 2.5 * (params.flood as number) : 0], o + 8);
          uf.set([0.2, 0.98, 0.001 + 0.006 * (params.evap as number), 0.06 * (params.carve as number)], o + 12);
          uf.set([0.12, 0.05, relax, 0.06], o + 16);
          uf.set([look, params.gloss as number, params.tint as number, params.glow as number], o + 20);
          uf.set([kickEnv, audio.rms, (time * bps / 16) * (params.cycle as number), Math.min(8, pal.length)], o + 24);
          const prelax = fresh ? 1 : Math.min(1, (params.resurface as number) * 0.04 + (params.reform as number) * env * 0.2);
          uf.set([aspect, time, prelax, (tk * 16 + k) % 16777216], o + 28);
          uf.set([steps, params.ink as number, 0.00006 * (params.rain as number) * (idle + react * (bass + kickEnv)), params.water as number], o + 32);
          if (hit && look) {
            const [r, g, b] = oklabToLinear(mixStops(pal, 0.35 + 0.5 * rand(tk, 84)));
            uf.set([Math.min(1, 0.9 * (params.flood as number)), r, g, b], o + 36);
          }
          pal.slice(0, 8).forEach((s, i) => uf.set(s, o + 40 + i * 4));
        };
        let block = 0;
        const plan: { block: number; k: number }[] = [];
        for (let j = 0; j < ticks; j++) {
          const tk = tick - (ticks - 1 - j);
          const hit = onsetAgo >= 0 && onsetAgo === ticks - 1 - j;
          for (let k = 0; k < steps; k++) { fill(block, k, tk, hit); plan.push({ block, k }); block++; }
        }
        if (block === 0) { fill(0, 0, tick, false); block = 1; }
        const drawBlock = block - 1;
        device.queue.writeBuffer(ubuf, 0, uf, 0, (block * STRIDE) / 4);

        for (let i = 0; i < plan.length; i++) {
          const b = plan[i].block;
          pass(enc, [Fx[1 - fcur]], P.flux, fcur ? bg.flux1 : bg.flux0, b, media);
          pass(enc, [Stmp, V], P.update, fcur ? bg.upd0 : bg.upd1, b, media);
          fcur = 1 - fcur;
          pass(enc, [S, view], P.move, bg.move, b, media);
          if (plan[i].k === steps - 1) {
            pass(enc, [pig[1 - pcur]], P.pig, pcur ? bg.pig1 : bg.pig0, b, media);
            pcur = 1 - pcur;
          }
        }
        pass(enc, [out.out], P.draw, pcur ? bg.draw1 : bg.draw0, drawBlock, media);
      },
      dispose: () => { for (const t of texs) t.destroy(); d32.destroy(); d16.destroy(); ubuf.destroy(); },
      status: () => `${W}x${H} water, ${PW}x${PH} pigment`,
    };
  },
});
