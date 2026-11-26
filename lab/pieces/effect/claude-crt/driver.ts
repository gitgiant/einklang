// One fullscreen pass. The tracking burst's envelope comes from the onset history, so it is
// closed-form: no state between frames.
import { definePiece } from '../../../api/index.ts';

/** Ticks an onset's noise burst stays visible. */
const TAIL = 30;

export default definePiece({
  gpu: ({ device, shader, formats }) => {
    const mod = shader('crt.wgsl');
    const pipe = device.createRenderPipeline({
      layout: 'auto', label: 'claude-crt',
      vertex: { module: mod, entryPoint: 'vs_full' },
      fragment: { module: mod, entryPoint: 'fs_crt', targets: [{ format: formats.tex }] },
    });
    const samp = device.createSampler({ magFilter: 'linear', minFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' });
    const data = new Float32Array(16);
    const ubuf = device.createBuffer({ size: data.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    return {
      frame({ enc, in: ins, out, params: P, tick, sub, past, rand }) {
        // the latest onset: how strong its burst is and where on the screen it hits
        let burst = 0, at = 0.5;
        for (let age = 0; age < TAIL; age++) {
          if (!past(age).onset) continue;
          const born = tick - age;
          burst = Math.exp(-(age + sub / 256) / 9) * (0.4 + 0.6 * rand(born, 1));
          at = 0.08 + 0.8 * rand(born, 2) + 0.004 * age;
          break;
        }
        data.set([
          out.out.width, out.out.height, tick % 4096, 0,
          P.scanlines as number, P.curve as number, P.vignette as number, P.chroma as number,
          P.tracking as number, P.jitter as number, burst, at,
        ]);
        device.queue.writeBuffer(ubuf, 0, data);
        const bg = device.createBindGroup({
          layout: pipe.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: { buffer: ubuf } },
            { binding: 1, resource: samp },
            { binding: 2, resource: (ins.in as GPUTexture).createView() },
          ],
        });
        const rp = enc.beginRenderPass({ colorAttachments: [{ view: out.out.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }] });
        rp.setPipeline(pipe); rp.setBindGroup(0, bg); rp.draw(3); rp.end();
      },
      dispose: () => ubuf.destroy(),
    };
  },
});
