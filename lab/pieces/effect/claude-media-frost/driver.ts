import { definePiece, oklch, BAR_TICKS, TICKS_PER_BEAT, type Palette } from '../../../api/index.ts';

// Media frost. GPU state (not synced): the crystal state (tips, headings) and the ice colour (rgba16f, `cells` high),
// ping-ponged. Per elapsed tick (at most 2 per frame) `steps` growth substeps, each with its own
// uniform block (dynamic offset) so the random draws differ. Onsets seed nuclei on the picture's
// edges, the bass and onsets speed the tips up, the phrase start melts the frost so the picture re-forms.

const U_FLOATS = 60, STRIDE = 256, MAX_CATCHUP = 2, MAX_STEPS = 6, PHRASE = 4 * BAR_TICKS;
const BLOCKS = MAX_CATCHUP * MAX_STEPS + 1;

export default definePiece({
  gpu: ({ device, shader }) => {
    const mod = shader('frost.wgsl');
    const F = GPUShaderStage.FRAGMENT;
    const bgl0 = device.createBindGroupLayout({
      label: 'claude-media-frost own',
      entries: [
        { binding: 0, visibility: F, buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: U_FLOATS * 4 } },
        { binding: 1, visibility: F, sampler: { type: 'filtering' } },
        { binding: 2, visibility: F, texture: { sampleType: 'float' } },
        { binding: 3, visibility: F, texture: { sampleType: 'float' } },
      ],
    });
    const bgl1 = device.createBindGroupLayout({
      label: 'claude-media-frost media',
      entries: [0, 1, 2].map((binding) => ({ binding, visibility: F, texture: { sampleType: 'float' as const } })),
    });
    const layout = device.createPipelineLayout({ bindGroupLayouts: [bgl0, bgl1] });
    const pipe = (entryPoint: string, n: number) => device.createRenderPipeline({
      label: `claude-media-frost ${entryPoint}`, layout,
      vertex: { module: mod, entryPoint: 'vs_full' },
      fragment: { module: mod, entryPoint, targets: Array.from({ length: n }, () => ({ format: 'rgba16float' as const })) },
    });
    const P = { grow: pipe('fs_grow', 2), draw: pipe('fs_draw', 1) };
    const samp = device.createSampler({ magFilter: 'linear', minFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' });
    const ubuf = device.createBuffer({ label: 'claude-media-frost u', size: STRIDE * BLOCKS, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const uf = new Float32Array((STRIDE * BLOCKS) / 4);
    const usage = GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING;

    let W = 0, H = 0, cur = 0, lastTick = -Infinity;
    let texs: GPUTexture[] = [], st: GPUTexture[] = [], ice: GPUTexture[] = [];
    let bg: GPUBindGroup[] = [];

    const alloc = (w: number, h: number) => {
      for (const t of texs) t.destroy();
      const tex = (label: string) => device.createTexture({ label: `claude-media-frost ${label}`, size: [w, h], format: 'rgba16float', usage });
      st = [tex('state 0'), tex('state 1')];
      ice = [tex('ice 0'), tex('ice 1')];
      texs = [...st, ...ice];
      W = w; H = h; cur = 0;
      bg = [0, 1].map((i) => device.createBindGroup({
        layout: bgl0,
        entries: [
          { binding: 0, resource: { buffer: ubuf, size: U_FLOATS * 4 } }, { binding: 1, resource: samp },
          { binding: 2, resource: st[i].createView() }, { binding: 3, resource: ice[i].createView() },
        ],
      }));
    };
    const pass = (enc: GPUCommandEncoder, targets: GPUTexture[], p: GPURenderPipeline, g0: GPUBindGroup, block: number, g1: GPUBindGroup) => {
      const rp = enc.beginRenderPass({ colorAttachments: targets.map((t) => ({ view: t.createView(), loadOp: 'clear' as const, storeOp: 'store' as const, clearValue: [0, 0, 0, 0] })) });
      rp.setPipeline(p); rp.setBindGroup(0, g0, [block * STRIDE]); rp.setBindGroup(1, g1); rp.draw(3); rp.end();
    };
    const clear = (enc: GPUCommandEncoder, t: GPUTexture) =>
      enc.beginRenderPass({ colorAttachments: [{ view: t.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 0] }] }).end();

    return {
      frame({ enc, out, in: ins, params, audio, time, tick, past, width, height }) {
        const h = Math.round(Math.min(720, Math.max(180, params.cells as number))), w = Math.max(16, Math.round((h * width) / height));
        let fresh = false;
        if (w !== W || h !== H) { alloc(w, h); fresh = true; }
        let ticks = tick - lastTick;
        if (fresh || ticks < 0 || ticks > 120) {
          fresh = true; ticks = 1; cur = 0;
          clear(enc, st[0]); clear(enc, ice[0]);
        }
        ticks = Math.min(ticks, MAX_CATCHUP);
        lastTick = tick;

        const media = device.createBindGroup({
          layout: bgl1,
          entries: [ins.in, ins.luma, ins.edges].map((t, binding) => ({ binding, resource: (t as GPUTexture).createView() })),
        });

        let bass = 0, hi = 0;
        for (let ago = 0; ago < 5; ago++) {
          const f = past(ago);
          bass += (f.bands[0] + f.bands[1] + f.bands[2]) / 15;
          hi += (f.bands[10] + f.bands[11] + f.bands[12] + f.bands[13]) / 20;
        }
        let kickEnv = 0, onsetAgo = -1;
        for (let ago = 0; ago < 24; ago++) if (past(ago).onset) { kickEnv = Math.max(kickEnv, Math.exp(-ago / 6)); if (onsetAgo < 0) onsetAgo = ago; }

        const react = params.react as number, idle = params.idle as number;
        const steps = Math.round(Math.min(MAX_STEPS, Math.max(1, params.steps as number)));
        const drive = idle * 0.5 + react * (bass * bass * 1.2 + kickEnv);
        const rate = Math.min(1, (params.grow as number) * 0.28 * drive);
        const tp = ((tick % PHRASE) + PHRASE) % PHRASE;
        const env = Math.exp(-tp / (TICKS_PER_BEAT * 0.75));
        const bps = (audio.bpm > 0 ? audio.bpm : 120) / 60;
        const pal = (ins.palette as Palette | undefined)?.stops ?? Array.from({ length: 6 }, (_, i) => oklch(0.45 + i * 0.09, 0.11, 0.55 + audio.pal + i / 12));
        const seedAmt = params.seed as number;

        const fill = (block: number, k: number, tk: number, hit: boolean) => {
          const o = block * (STRIDE / 4);
          uf.fill(0, o, o + U_FLOATS);
          uf.set([W, H, width / height, (tk / TICKS_PER_BEAT) % 64], o);
          uf.set([rate, 0.02 + 0.2 * (params.branch as number), params.along as number, params.wiggle as number], o + 4);
          const seedp = (fresh && k === 0 ? 0.004 : 0) + (hit && k === 0 ? seedAmt * 0.006 * (0.5 + react * bass) : 0);
          const melt = (params.melt as number) * 0.004 + (params.reform as number) * env * 0.12;
          uf.set([seedp, params.edge as number, melt, (tk * 8 + k) % 16777216], o + 8);
          uf.set([params.show as number, params.tint as number, params.sparkle as number, params.glow as number], o + 12);
          uf.set([kickEnv, audio.rms, (time * bps / 16) * (params.cycle as number), Math.min(8, pal.length)], o + 16);
          uf.set([hi, time, seedAmt * 0.00001 * (0.3 + idle), params.mist as number], o + 20);
          pal.slice(0, 8).forEach((s, i) => uf.set(s, o + 24 + i * 4));
        };
        let block = 0;
        for (let j = 0; j < ticks; j++) {
          const tk = tick - (ticks - 1 - j);
          const hit = onsetAgo >= 0 && onsetAgo === ticks - 1 - j;
          for (let k = 0; k < steps; k++) fill(block++, k, tk, hit);
        }
        if (block === 0) { fill(0, 0, tick, false); block = 1; }
        device.queue.writeBuffer(ubuf, 0, uf, 0, (block * STRIDE) / 4);
        const n = ticks > 0 ? ticks * steps : 0;
        for (let b = 0; b < n; b++) {
          pass(enc, [st[1 - cur], ice[1 - cur]], P.grow, bg[cur], b, media);
          cur = 1 - cur;
        }
        pass(enc, [out.out], P.draw, bg[cur], block - 1, media);
      },
      dispose: () => { for (const t of texs) t.destroy(); ubuf.destroy(); },
      status: () => `${W}x${H} frost`,
    };
  },
});
