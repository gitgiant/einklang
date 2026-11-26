import { definePiece } from '../../../api/index.ts';
import { tunnel } from '../../../../src/core/scenes/tunnel.ts';
import { v1Cpu } from '../../../../src/core/graph/v1.ts';

export default definePiece({
  cpu: v1Cpu(tunnel),
  gpu: ({ device, shader }) => {
    const mod = shader('tunnel.wgsl');
    const pipe = device.createRenderPipeline({
      layout: 'auto', label: 'tunnel',
      vertex: { module: mod, entryPoint: 'vs_full' },
      fragment: { module: mod, entryPoint: 'fs_tunnel', targets: [{ format: 'rgba16float' }] },
    });
    const ubuf = device.createBuffer({ size: 16 + 96, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const bg = device.createBindGroup({ layout: pipe.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: ubuf } }] });
    return {
      frame({ enc, out, cpu }) {
        const target = out.out, buf = new ArrayBuffer(16 + 96);
        new Float32Array(buf, 0, 2).set([target.width, target.height]);
        new Int32Array(buf, 16, 24).set(cpu.u as Int32Array);
        device.queue.writeBuffer(ubuf, 0, buf);
        const rp = enc.beginRenderPass({ colorAttachments: [{ view: target.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }] });
        rp.setPipeline(pipe); rp.setBindGroup(0, bg); rp.draw(3); rp.end();
      },
      dispose: () => ubuf.destroy(),
    };
  },
});
