import { definePiece } from '../../../api/index.ts';

// Each instance is one anti-aliased capsule along the pen path.
const segments = 512;
const additive: GPUBlendComponent = { srcFactor: 'one', dstFactor: 'one', operation: 'add' };

export default definePiece({
  gpu: ({ device, shader, formats }) => {
    const module = shader('pendulum.wgsl');
    const uniforms = device.createBuffer({
      size: 48,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    const values = new Float32Array(12);
    const bindings = device.createBindGroupLayout({
      entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: {} }],
    });
    const layout = device.createPipelineLayout({ bindGroupLayouts: [bindings] });
    const background = device.createRenderPipeline({
      layout,
      vertex: { module, entryPoint: 'vs_full' },
      fragment: { module, entryPoint: 'paper', targets: [{ format: formats.tex }] },
    });
    const drawing = device.createRenderPipeline({
      layout,
      vertex: { module, entryPoint: 'strokeVertex' },
      fragment: {
        module,
        entryPoint: 'strokeInk',
        targets: [{ format: formats.tex, blend: { color: additive, alpha: additive }, writeMask: GPUColorWrite.RED | GPUColorWrite.GREEN | GPUColorWrite.BLUE }],
      },
    });
    const group = device.createBindGroup({ layout: bindings, entries: [{ binding: 0, resource: { buffer: uniforms } }] });

    return {
      frame({ width, height, audio, past, time, params, enc, out }) {
        const { bpm, bar, phase } = audio;
        const progress = (bar + phase) / 4;
        const phraseStart = time - progress * 240 / bpm;
        const level = 0.55 * audio.rms + 0.3 * past(4).rms + 0.15 * past(10).rms;
        const strike = audio.onset ? 1 : past(2).onset ? 0.55 : 0;
        values[0] = width;
        values[1] = height;
        values[2] = Math.min(1, progress * 1.16);
        values[3] = bpm;
        values[4] = phraseStart;
        values[5] = 1 - progress;
        values[6] = level;
        values[7] = strike;
        values[8] = params.spread as number;
        values[9] = params.ink as number;
        values[10] = segments;
        values[11] = 240 / bpm;
        device.queue.writeBuffer(uniforms, 0, values);

        const pass = enc.beginRenderPass({
          colorAttachments: [{ view: out.out.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }],
        });
        pass.setPipeline(background);
        pass.setBindGroup(0, group);
        pass.draw(3);
        pass.setPipeline(drawing);
        pass.draw(6, segments * 2);
        pass.end();
      },
      dispose() { uniforms.destroy(); },
    };
  },
});
