import { definePiece } from '../../../api/index.ts';

const points = 129;
const layers = 5;
const trailStep = 5;

export default definePiece({
  gpu: ({ device, shader, formats }) => {
    const module = shader('ribbon.wgsl');
    const uniforms = device.createBuffer({ size: 48, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const waveBuffer = device.createBuffer({
      size: layers * points * 2 * Float32Array.BYTES_PER_ELEMENT,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    const values = new Float32Array(12);
    const samples = new Float32Array(layers * points * 2);
    const bindings = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: {} },
        { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
      ],
    });
    const layout = device.createPipelineLayout({ bindGroupLayouts: [bindings] });
    const backdrop = device.createRenderPipeline({
      layout,
      vertex: { module, entryPoint: 'vs_full' },
      fragment: { module, entryPoint: 'chamber', targets: [{ format: formats.tex }] },
    });
    const ribbon = device.createRenderPipeline({
      layout,
      primitive: { topology: 'triangle-strip' },
      vertex: { module, entryPoint: 'weave' },
      fragment: {
        module,
        entryPoint: 'silk',
        targets: [{
          format: formats.tex,
          blend: {
            color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
            alpha: { srcFactor: 'zero', dstFactor: 'one', operation: 'add' },
          },
        }],
      },
    });
    const group = device.createBindGroup({
      layout: bindings,
      entries: [
        { binding: 0, resource: { buffer: uniforms } },
        { binding: 1, resource: { buffer: waveBuffer } },
      ],
    });

    return {
      frame({ width, height, tick, time, audio, past, raw, params, enc, out }) {
        const low = (audio.bands[0] + audio.bands[1] + audio.bands[2]) / 3;
        const high = (audio.bands[10] + audio.bands[12] + audio.bands[14]) / 3;
        for (let age = 0; age < layers; age++) {
          const delay = age * trailStep;
          const stereo = raw.wave(Math.max(0, tick - delay));
          const bands = past(delay).bands;
          const bass = (bands[0] + bands[1] + bands[2]) / 3;
          const treble = (bands[10] + bands[12] + bands[14]) / 3;
          const sampleTime = time - delay / 60;
          for (let i = 0; i < points; i++) {
            const t = i / (points - 1);
            const offset = (age * points + i) * 2;
            if (stereo?.length) {
              const end = stereo.length / 2 - 1;
              const center = Math.round(t * end);
              // Suppress discontinuities between adjacent cross-sections on noisy tracks.
              for (let c = 0; c < 2; c++) {
                let total = 0;
                for (let k = -2; k <= 2; k++) total += stereo[2 * Math.max(0, Math.min(end, center + k)) + c];
                samples[offset + c] = total / (5 * 127);
              }
            } else {
              samples[offset] = bass * Math.sin(t * 6 * Math.PI - sampleTime * 1.3);
              samples[offset + 1] = treble * Math.sin(t * 10 * Math.PI + sampleTime * 1.2);
            }
          }
        }
        values[0] = width;
        values[1] = height;
        values[2] = time;
        values[3] = params.orbit as number;
        values[4] = params.width as number;
        values[5] = audio.rms * 0.64 + past(6).rms * 0.36;
        values[6] = low;
        values[7] = high;
        values[8] = audio.onset ? 1 : past(2).onset ? 0.5 : 0;
        values[9] = points;
        values[10] = layers;
        device.queue.writeBuffer(uniforms, 0, values);
        device.queue.writeBuffer(waveBuffer, 0, samples);

        const pass = enc.beginRenderPass({
          colorAttachments: [{ view: out.out.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }],
        });
        pass.setBindGroup(0, group);
        pass.setPipeline(backdrop);
        pass.draw(3);
        pass.setPipeline(ribbon);
        pass.draw(points * 2, layers);
        pass.end();
      },
      dispose() {
        uniforms.destroy();
        waveBuffer.destroy();
      },
    };
  },
});
