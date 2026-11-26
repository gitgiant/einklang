// Post chain: input (HDR) -> feedback trails (ping-pong) -> bloom at 1/4 res -> composite with
// the pads' FX, view and ACES tonemap into the output (the canvas, in the show graph).
// Trails are GPU pixel state: after a join or stutter they converge within ~1 s (accepted by spec).
import { definePiece, type PadFx } from '../../../api/index.ts';

/** One uniform slot per pass; the Post struct in post.wgsl is 496 bytes. */
const SLOT = 512, POST_FLOATS = 124, MAX_MARKS = 12;
const HDR: GPUTextureFormat = 'rgba16float';

export default definePiece({
  gpu: ({ device, shader }) => {
    const mod = shader('post.wgsl');
    const bgl = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform', hasDynamicOffset: true } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: {} },
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: {} },
      ],
    });
    const layout = device.createPipelineLayout({ bindGroupLayouts: [bgl] });
    const pipes = new Map<string, GPURenderPipeline>();
    const pipe = (entry: string, format: GPUTextureFormat) => {
      const k = `${entry}:${format}`;
      let p = pipes.get(k);
      if (!p) pipes.set(k, (p = device.createRenderPipeline({
        layout, label: entry,
        vertex: { module: mod, entryPoint: 'vs_full' },
        fragment: { module: mod, entryPoint: entry, targets: [{ format }] },
      })));
      return p;
    };
    const samp = device.createSampler({ magFilter: 'linear', minFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' });
    const ubuf = device.createBuffer({ size: SLOT * 5, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const tex = (w: number, h: number, label: string) => device.createTexture({
      size: [Math.max(1, w), Math.max(1, h)], format: HDR, label, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    let t: { w: number; h: number; trail: [GPUTexture, GPUTexture]; bloomA: GPUTexture; bloomB: GPUTexture } | null = null;
    let cur = 0;
    const free = () => { t?.trail.forEach((x) => x.destroy()); t?.bloomA.destroy(); t?.bloomB.destroy(); t = null; };

    return {
      frame({ enc, in: ins, out: o, params: P, pads: fx, tick }) {
        const src = ins.in as GPUTexture, out = o.out, w = src.width, h = src.height;
        if (!t || t.w !== w || t.h !== h) {
          free();
          const qw = Math.ceil(w / 4), qh = Math.ceil(h / 4);
          t = { w, h, trail: [tex(w, h, 'trailA'), tex(w, h, 'trailB')], bloomA: tex(qw, qh, 'bloomA'), bloomB: tex(qw, qh, 'bloomB') };
        }
        const T = t, prev = T.trail[cur], next = T.trail[cur ^ 1];
        cur ^= 1;
        // the pads ride on top of the scene's settings
        const p = {
          decay: Math.max(P.decay as number, fx.trails * 0.96),
          zoom: (P.zoom as number) + fx.zoom * 0.025,
          rotate: (P.rotate as number) + fx.rotate * 0.03,
          bloom: (P.bloom as number) + fx.bloom * 1.6,
          threshold: P.threshold as number, exposure: P.exposure as number,
        };
        const qw = T.bloomA.width, qh = T.bloomA.height;
        const slots = new ArrayBuffer(SLOT * 5);
        const marks = (fx as PadFx).marks.slice(0, MAX_MARKS);
        const put = (slot: number, texel: [number, number], dir: [number, number]) => {
          const f = new Float32Array(slots, slot * SLOT, POST_FLOATS);
          f.set([p.decay, p.zoom, p.rotate, p.bloom, p.threshold, p.exposure, T.w / T.h, P.view as number, ...texel, ...dir,
            fx.cx, fx.cy, fx.kaleido, fx.invert, fx.strobe, fx.blackout, fx.glitch, marks.length,
            ...fx.strobeCol, 1, fx.kx, fx.ky, tick % 4096, 0]);
          marks.forEach((m, i) => { f.set([m.x, m.y, m.r, m.a], 28 + i * 4); f.set([...m.col, 1], 28 + MAX_MARKS * 4 + i * 4); });
        };
        put(0, [1 / T.w, 1 / T.h], [0, 0]);
        put(1, [1 / T.w, 1 / T.h], [0, 0]);
        put(2, [1 / qw, 1 / qh], [1, 0]);
        put(3, [1 / qw, 1 / qh], [0, 1]);
        put(4, [1 / T.w, 1 / T.h], [0, 0]);
        device.queue.writeBuffer(ubuf, 0, slots);

        const pass = (entry: string, slot: number, target: GPUTexture, a: GPUTexture, b: GPUTexture) => {
          const bg = device.createBindGroup({
            layout: bgl,
            entries: [
              { binding: 0, resource: { buffer: ubuf, size: POST_FLOATS * 4 } },
              { binding: 1, resource: samp },
              { binding: 2, resource: a.createView() },
              { binding: 3, resource: b.createView() },
            ],
          });
          const rp = enc.beginRenderPass({ colorAttachments: [{ view: target.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }] });
          rp.setPipeline(pipe(entry, target.format)); rp.setBindGroup(0, bg, [slot * SLOT]); rp.draw(3); rp.end();
        };
        pass('fs_feedback', 0, next, src, prev);
        pass('fs_bright', 1, T.bloomA, next, next);
        pass('fs_blur', 2, T.bloomB, T.bloomA, T.bloomA);
        pass('fs_blur', 3, T.bloomA, T.bloomB, T.bloomB);
        pass('fs_composite', 4, out, next, T.bloomA);
      },
      dispose: () => { free(); ubuf.destroy(); },
    };
  },
});
