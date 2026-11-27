import { definePiece, type Audio } from '../../../api/index.ts';

const DROPS = 4;
const LIFETIME = 122;

function waveNumber(bands: Audio['bands']) {
  let energy = 0;
  let weighted = 0;
  for (let i = 0; i < bands.length; i++) {
    energy += bands[i];
    weighted += i * bands[i];
  }
  return 20 + 2.6 * weighted / Math.max(0.8, energy);
}

export default definePiece({
  gpu({ device, shader }) {
    const module = shader('tank.wgsl');
    const data = new Float32Array(8 + DROPS * 4);
    const uniform = device.createBuffer({ size: data.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const pipeline = device.createRenderPipeline({
      layout: 'auto',
      vertex: { module, entryPoint: 'vs_full' },
      fragment: { module, entryPoint: 'fs_tank', targets: [{ format: 'rgba16float' }] },
    });
    const group = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: uniform } }],
    });
    return {
      frame({ enc, out, width, height, tick, time, audio, past, rand, params }) {
        const scale = Math.min(width, height);
        const spacing = params.spacing as number;
        const swell = params.swell as number;
        data.set([width / scale, height / scale, time, 1 / scale]);
        data.set([waveNumber(audio.bands) / spacing, Math.min(1, audio.rms * 3.1), swell, 0], 4);
        data.fill(0, 8);
        let drops = 0;
        for (let ago = 0; ago < LIFETIME && drops < DROPS; ago++) {
          const frame = past(ago);
          const prior = past(ago + 1);
          const beat = frame.phase < prior.phase && frame.rms > 0.13;
          if ((!frame.onset || prior.onset) && !beat) continue;
          const at = tick - ago;
          data.set([
            (rand(at, 39) - 0.5) * (width / scale) * 0.52,
            (rand(at, 75) - 0.5) * (height / scale) * 0.48,
            (ago + 1) / 60,
            waveNumber(frame.bands) / spacing,
          ], 8 + drops * 4);
          drops++;
          ago += 8;
        }
        device.queue.writeBuffer(uniform, 0, data);
        const pass = enc.beginRenderPass({
          colorAttachments: [{ view: out.out.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }],
          label: 'Cymatics wave surface',
        });
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, group);
        pass.draw(3);
        pass.end();
      },
      dispose() { uniform.destroy(); },
    };
  },
});
