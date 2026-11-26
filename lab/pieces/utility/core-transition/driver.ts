// Transition mix: one fullscreen draw over every registered transition. transition.wgsl is not a
// file here: the browser registry assembles it from prelude.wgsl and lab/transitions/*/mix.wgsl
// (src/core/transwgsl.ts). In the show graph the engine sets the params from core/transitions.ts
// (which also hashes them).
import { definePiece } from '../../../api/index.ts';
import { smooth } from '../../../../src/core/features.ts';
import { NB } from '../../../../src/core/constants.ts';

const UBYTES = 112;

export default definePiece({
  gpu: ({ device, shader }) => {
    const mod = shader('transition.wgsl');
    const pipes = new Map<GPUTextureFormat, GPURenderPipeline>();
    const pipe = (format: GPUTextureFormat) => {
      let p = pipes.get(format);
      if (!p) pipes.set(format, (p = device.createRenderPipeline({
        layout: 'auto', label: 'transition',
        vertex: { module: mod, entryPoint: 'vs_full' },
        fragment: { module: mod, entryPoint: 'fs_trans', targets: [{ format }] },
      })));
      return p;
    };
    const samp = device.createSampler({ magFilter: 'linear', minFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' });
    const ubuf = device.createBuffer({ size: UBYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    return {
      frame({ enc, in: ins, out: o, params: P, pads, raw, tick, time }) {
        const out = o.out, a = ins.a as GPUTexture, b = ins.b as GPUTexture, pl = pipe(out.format);
        const buf = new ArrayBuffer(UBYTES), u = new Uint32Array(buf), f = new Float32Array(buf);
        u[0] = P.type as number; u[1] = (P.seed as number) >>> 0; u[2] = P.roll as number;
        f[4] = P.p as number; f[5] = P.flash as number; f[6] = out.width / out.height; f[7] = time;
        f.set([P.pads ? pads.cx : 0.5, P.pads ? pads.cy : 0.5, out.width, out.height], 8);
        for (let k = 0; k < NB; k++) f[12 + k] = smooth(raw, tick, k, 8) / 255;
        device.queue.writeBuffer(ubuf, 0, buf);
        const bg = device.createBindGroup({
          layout: pl.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: { buffer: ubuf } },
            { binding: 1, resource: samp },
            { binding: 2, resource: a.createView() },
            { binding: 3, resource: b.createView() },
          ],
        });
        const rp = enc.beginRenderPass({ colorAttachments: [{ view: out.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }] });
        rp.setPipeline(pl); rp.setBindGroup(0, bg); rp.draw(3); rp.end();
      },
      dispose: () => ubuf.destroy(),
    };
  },
});
