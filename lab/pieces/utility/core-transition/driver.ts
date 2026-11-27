// Transition mix: one fullscreen draw. The shaders are not files here: the browser registry assembles
// them from prelude.wgsl and lab/transitions/*/mix.wgsl (src/core/transwgsl.ts): `transition/<id>.wgsl`
// holds one transition each, `transition.wgsl` all of them behind a switch on T.kind (the fallback
// for a kind without its own file). One pipeline per transition keeps each shader small (no
// registers sized for the heaviest branch), and they compile in the background when the engine
// starts (createRenderPipelineAsync), so the first switch with a transition doesn't stall on it.
// In the show graph the engine sets the params from core/transitions.ts (which also hashes them).
import { definePiece } from '../../../api/index.ts';
import { smooth } from '../../../../src/core/features.ts';
import { NB } from '../../../../src/core/constants.ts';
import { CUT_ID, transitions } from '../../../../src/core/transitions.ts';

const UBYTES = 112;

export default definePiece({
  gpu: ({ device, shader, wgsl, formats }) => {
    const F = GPUShaderStage.FRAGMENT;
    const bgl = device.createBindGroupLayout({
      label: 'transition',
      entries: [
        { binding: 0, visibility: F, buffer: { type: 'uniform' } },
        { binding: 1, visibility: F, sampler: {} },
        { binding: 2, visibility: F, texture: {} },
        { binding: 3, visibility: F, texture: {} },
      ],
    });
    const layout = device.createPipelineLayout({ label: 'transition', bindGroupLayouts: [bgl] });
    const files = new Map<number, string>();
    for (const e of transitions()) if (wgsl(`transition/${e.id}.wgsl`)) files.set(e.kind, `transition/${e.id}.wgsl`);
    const mods = new Map<string, GPUShaderModule>();
    const modOf = (file: string) => { let m = mods.get(file); if (!m) mods.set(file, (m = shader(file))); return m; };
    const desc = (file: string, format: GPUTextureFormat): GPURenderPipelineDescriptor => ({
      layout, label: file,
      vertex: { module: modOf(file), entryPoint: 'vs_full' },
      fragment: { module: modOf(file), entryPoint: 'fs_trans', targets: [{ format }] },
    });
    const ready = new Map<string, GPURenderPipeline>(), pending = new Set<string>();
    const fileOf = (kind: number) => files.get(kind) ?? 'transition.wgsl';
    const warm = (file: string, format: GPUTextureFormat) => {
      const key = `${file}|${format}`;
      if (ready.has(key) || pending.has(key)) return;
      pending.add(key);
      device.createRenderPipelineAsync(desc(file, format))
        .then((p) => { if (!ready.has(key)) ready.set(key, p); })
        .catch((e: Error) => console.error(`[core-transition] ${file}: ${e.message}`))
        .finally(() => pending.delete(key));
    };
    // every transition, in kind order, for the scene target's format
    for (const e of transitions()) if (e.id !== CUT_ID && files.has(e.kind)) warm(files.get(e.kind)!, formats.tex);
    /** The pipeline for `kind`; created on the spot (a stall) only if its background compile hasn't finished. */
    const pipe = (kind: number, format: GPUTextureFormat) => {
      const file = fileOf(kind), key = `${file}|${format}`;
      let p = ready.get(key);
      if (!p) ready.set(key, (p = device.createRenderPipeline(desc(file, format))));
      return p;
    };
    const samp = device.createSampler({ magFilter: 'linear', minFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' });
    const ubuf = device.createBuffer({ size: UBYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const buf = new ArrayBuffer(UBYTES), u = new Uint32Array(buf), f = new Float32Array(buf);
    // the engine's transition targets only change on a resize: keep the bind group until then
    let bg: GPUBindGroup | null = null, bgA: GPUTexture | null = null, bgB: GPUTexture | null = null;
    return {
      frame({ enc, in: ins, out: o, params: P, pads, raw, tick, time }) {
        const out = o.out, a = ins.a as GPUTexture, b = ins.b as GPUTexture, pl = pipe(P.type as number, out.format);
        u[0] = P.type as number; u[1] = (P.seed as number) >>> 0; u[2] = P.roll as number; u[3] = 0;
        f[4] = P.p as number; f[5] = P.flash as number; f[6] = out.width / out.height; f[7] = time;
        f.set([P.pads ? pads.cx : 0.5, P.pads ? pads.cy : 0.5, out.width, out.height], 8);
        for (let k = 0; k < NB; k++) f[12 + k] = smooth(raw, tick, k, 8) / 255;
        device.queue.writeBuffer(ubuf, 0, buf);
        if (!bg || a !== bgA || b !== bgB) {
          bgA = a; bgB = b;
          bg = device.createBindGroup({
            layout: bgl,
            entries: [
              { binding: 0, resource: { buffer: ubuf } },
              { binding: 1, resource: samp },
              { binding: 2, resource: a.createView() },
              { binding: 3, resource: b.createView() },
            ],
          });
        }
        const rp = enc.beginRenderPass({ colorAttachments: [{ view: out.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }] });
        rp.setPipeline(pl); rp.setBindGroup(0, bg); rp.draw(3); rp.end();
      },
      dispose: () => ubuf.destroy(),
    };
  },
});
