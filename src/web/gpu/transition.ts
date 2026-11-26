// Transition pass: one fullscreen draw mixing two HDR scene targets into the scene target.
import src from './shaders/transition.wgsl?raw';
import { HDR, shader } from './gpu.ts';
import { NB } from '../../core/constants.ts';
import type { Transition } from '../../core/transitions.ts';

const UBYTES = 112;

export class TransitionPass {
  private pipe: GPURenderPipeline;
  private samp: GPUSampler;
  private ubuf: GPUBuffer;
  private device: GPUDevice;

  constructor(device: GPUDevice) {
    this.device = device;
    const mod = shader(device, src, 'transition');
    this.pipe = device.createRenderPipeline({
      layout: 'auto', label: 'transition',
      vertex: { module: mod, entryPoint: 'vs_full' },
      fragment: { module: mod, entryPoint: 'fs_trans', targets: [{ format: HDR }] },
    });
    this.samp = device.createSampler({ magFilter: 'linear', minFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' });
    this.ubuf = device.createBuffer({ size: UBYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  }

  /** Mix `from` and `to` into `out`. `center` (uv) is where iris, zoom and swirl centre. */
  run(enc: GPUCommandEncoder, out: GPUTexture, from: GPUTexture, to: GPUTexture, tr: Transition, center: [number, number]): void {
    const buf = new ArrayBuffer(UBYTES), u = new Uint32Array(buf), f = new Float32Array(buf);
    u[0] = tr.kind; u[1] = tr.seed; u[2] = tr.roll;
    f[4] = tr.p; f[5] = tr.flash16 / 65536; f[6] = out.width / out.height;
    f.set([center[0], center[1], out.width, out.height], 8);
    if (tr.bands) for (let b = 0; b < NB; b++) f[12 + b] = tr.bands[b] / 255;
    this.device.queue.writeBuffer(this.ubuf, 0, buf);
    const bg = this.device.createBindGroup({
      layout: this.pipe.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.ubuf } },
        { binding: 1, resource: this.samp },
        { binding: 2, resource: from.createView() },
        { binding: 3, resource: to.createView() },
      ],
    });
    const rp = enc.beginRenderPass({ colorAttachments: [{ view: out.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }] });
    rp.setPipeline(this.pipe); rp.setBindGroup(0, bg); rp.draw(3); rp.end();
  }
}
