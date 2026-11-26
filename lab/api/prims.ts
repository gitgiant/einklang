// Display lists: draw SDF primitives (circles, rings, lines, quads; 8 ints each, see
// src/core/prims.ts) into a texture. The v1 radial and scope scenes draw this way, and any piece
// whose cpu() builds a list can too: `const d = new PrimDrawer(init, 'add', 1.5)`, then
// `d.draw(ctx.enc, ctx.out.out, prims)` in frame().
import type { GpuInit } from './index.ts';
import { PRIM_INTS } from '../../src/core/prims.ts';
import { W, H } from '../../src/core/constants.ts';

const BLEND: Record<'add' | 'over', GPUBlendState> = {
  add: { color: { srcFactor: 'one', dstFactor: 'one' }, alpha: { srcFactor: 'one', dstFactor: 'one' } },
  over: { color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' }, alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' } },
};

/** Letterbox from the virtual W x H canvas (1280x720) that display-list coordinates live in. */
export function letterbox(tw: number, th: number): { scale: number; ox: number; oy: number } {
  const scale = Math.min(tw / W, th / H);
  return { scale, ox: (tw - W * scale) / 2, oy: (th - H * scale) / 2 };
}

export class PrimDrawer {
  private pipes = new Map<GPUTextureFormat, GPURenderPipeline>();
  private ubuf: GPUBuffer;
  private lbuf: GPUBuffer | null = null;
  private mod: GPUShaderModule;
  private device: GPUDevice;
  private blend: GPUBlendState;
  private gain: number;
  constructor(init: GpuInit, blend: 'add' | 'over', gain: number) {
    this.device = init.device; this.blend = BLEND[blend]; this.gain = gain;
    this.mod = init.compile(init.lib('prims.wgsl'), 'prims');
    this.ubuf = init.device.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  }
  private pipe(format: GPUTextureFormat): GPURenderPipeline {
    let p = this.pipes.get(format);
    if (!p) {
      p = this.device.createRenderPipeline({
        layout: 'auto', label: 'prims',
        vertex: { module: this.mod, entryPoint: 'vs_prim' },
        fragment: { module: this.mod, entryPoint: 'fs_prim', targets: [{ format, blend: this.blend }] },
      });
      this.pipes.set(format, p);
    }
    return p;
  }
  /** Clear `target` and draw the list into it. */
  draw(enc: GPUCommandEncoder, target: GPUTexture, prims: Int32Array): void {
    const d = this.device, bytes = Math.max(prims.byteLength, 32), pipe = this.pipe(target.format);
    if (!this.lbuf || this.lbuf.size < bytes) {
      this.lbuf?.destroy();
      this.lbuf = d.createBuffer({ size: Math.max(bytes * 2, 64 * 1024), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    }
    d.queue.writeBuffer(this.lbuf, 0, prims);
    const lb = letterbox(target.width, target.height);
    d.queue.writeBuffer(this.ubuf, 0, new Float32Array([target.width, target.height, lb.ox, lb.oy, lb.scale, this.gain, 0, 0]));
    const bg = d.createBindGroup({ layout: pipe.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: this.ubuf } }, { binding: 1, resource: { buffer: this.lbuf } }] });
    const rp = enc.beginRenderPass({ colorAttachments: [{ view: target.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }] });
    rp.setPipeline(pipe); rp.setBindGroup(0, bg); rp.draw(6, prims.length / PRIM_INTS); rp.end();
  }
}
