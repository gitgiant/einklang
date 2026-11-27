import { definePiece, type GpuCtx } from '../../../api/index.ts';

const GRAINS = 12500;
const HOLD = 64;
const MODES = [[3, 1], [4, 2], [5, 1], [5, 3], [6, 2], [7, 3], [7, 5], [8, 4]] as const;

function modeAt(past: GpuCtx['past'], age: number) {
  // Keep note-ons through short gaps. Sample the spectrum at the start of each
  // hold interval so a transient cannot change the pattern every frame.
  for (let i = 0; i < 120; i++) {
    const note = past(age + i).note;
    if (note >= 0) return (note + Math.floor(note / 12)) % MODES.length;
  }

  const bands = new Float32Array(16);
  for (let lag = 0; lag < 24; lag += 3) {
    const frame = past(age + lag);
    for (let i = 0; i < bands.length; i++) bands[i] += frame.bands[i];
  }
  let peak = 0;
  for (let i = 1; i < bands.length; i++) {
    if (bands[i] > bands[peak]) peak = i;
  }
  return bands[peak] > 0.14 ? (peak * 3 + 1) % MODES.length : 0;
}

export default definePiece({
  gpu({ device, shader }) {
    const module = shader('plate.wgsl');
    const uniform = device.createBuffer({ size: 64, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const layout = device.createBindGroupLayout({
      entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } }],
    });
    const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [layout] });
    const plate = device.createRenderPipeline({
      layout: pipelineLayout,
      vertex: { module, entryPoint: 'vs_full' },
      fragment: { module, entryPoint: 'fs_plate', targets: [{ format: 'rgba16float' }] },
    });
    const add: GPUBlendComponent = { srcFactor: 'one', dstFactor: 'one' };
    const grains = device.createRenderPipeline({
      layout: pipelineLayout,
      vertex: { module, entryPoint: 'vs_grain' },
      primitive: { topology: 'triangle-strip' },
      fragment: { module, entryPoint: 'fs_grain', targets: [{ format: 'rgba16float', blend: { color: add, alpha: add } }] },
    });
    const group = device.createBindGroup({ layout, entries: [{ binding: 0, resource: { buffer: uniform } }] });
    const data = new Float32Array(16);

    return {
      frame({ enc, out, width, height, tick, time, audio, past, params }) {
        const age = tick % HOLD;
        const current = modeAt(past, age);
        const previous = modeAt(past, age + HOLD);
        let hit = 0;
        for (let lag = 0; lag < 24; lag++) {
          if (past(lag).onset) {
            hit = Math.exp(-lag / 7);
            break;
          }
        }
        const drive = params.drive as number;
        const energy = Math.min(1, audio.rms * 2.8) * drive;
        const scale = Math.min(width, height) * 0.420;
        data.set([scale / width, scale / height, time, params.grain as number]);
        data.set([...MODES[current], ...MODES[previous]], 4);
        data.set([current === previous ? 1 : age / HOLD, hit * drive, energy, scale], 8);
        data.set([audio.bands[0], audio.bands[1], audio.bands[2], 0], 12);
        device.queue.writeBuffer(uniform, 0, data);

        const pass = enc.beginRenderPass({
          colorAttachments: [{ view: out.out.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }],
          label: 'Chladni plate and grains',
        });
        pass.setBindGroup(0, group);
        pass.setPipeline(plate);
        pass.draw(3);
        pass.setPipeline(grains);
        pass.draw(4, GRAINS);
        pass.end();
      },
      dispose() { uniform.destroy(); },
    };
  },
});
