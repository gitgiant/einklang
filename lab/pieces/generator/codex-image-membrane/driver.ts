import { definePiece } from '../../../api/index.ts';

const COLS = 288;
const ROWS = 162;

export default definePiece({
  gpu({ device, shader, formats }) {
    const module = shader('membrane.wgsl');
    const step = device.createComputePipeline({ layout: 'auto', compute: { module, entryPoint: 'cs_wave' } });
    const image = device.createRenderPipeline({
      layout: 'auto',
      vertex: { module, entryPoint: 'vs_full' },
      fragment: { module, entryPoint: 'fs_wave', targets: [{ format: formats.tex }] },
    });
    const sampler = device.createSampler({ minFilter: 'linear', magFilter: 'linear' });
    const data = new Float32Array(16);
    const uniform = device.createBuffer({ size: data.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const tank = [0, 1].map(() => device.createTexture({
      size: [COLS, ROWS],
      format: 'rgba16float',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING,
    }));
    const surfaces = tank.map((texture) => texture.createView());
    let current = 0;
    let lastTick = -Infinity;
    let lastSize = '';
    let media: GPUTexture[] = [];
    let stepGroups: GPUBindGroup[] = [];
    let imageGroups: GPUBindGroup[] = [];

    return {
      frame({ enc, in: ins, out, width, height, tick, time, params, past, rand }) {
        const source = ins.in as GPUTexture;
        const luma = ins.height as GPUTexture;
        const edges = ins.flow as GPUTexture;
        if (media[0] !== source || media[1] !== luma || media[2] !== edges) {
          media = [source, luma, edges];
          const views = media.map((texture) => texture.createView());
          stepGroups = surfaces.map((surface, i) => device.createBindGroup({
            layout: step.getBindGroupLayout(0),
            entries: [
              { binding: 0, resource: { buffer: uniform } },
              { binding: 1, resource: sampler },
              { binding: 2, resource: surface },
              { binding: 3, resource: surfaces[1 - i] },
              { binding: 4, resource: views[1] },
              { binding: 5, resource: views[2] },
            ],
          }));
          imageGroups = surfaces.map((surface) => device.createBindGroup({
            layout: image.getBindGroupLayout(0),
            entries: [
              { binding: 0, resource: { buffer: uniform } },
              { binding: 1, resource: sampler },
              { binding: 2, resource: surface },
              { binding: 5, resource: views[2] },
              { binding: 6, resource: views[0] },
            ],
          }));
        }

        let level = 0;
        let bass = 0;
        let age = 32;
        for (let ago = 0; ago < 32; ago++) {
          const audio = past(ago);
          if (ago < 16) {
            level += audio.rms / 16;
            bass += (audio.bands[0] + audio.bands[1] + audio.bands[2]) / 48;
          }
          if (age === 32 && audio.onset && !past(ago + 1).onset) age = ago;
        }
        const size = `${width}x${height}`;
        const elapsed = tick - lastTick;
        const reset = elapsed < 0 || elapsed > 45 || size !== lastSize;
        const hit = tick - age;
        data.set([width / height, time, Number(reset), params.plate as number]);
        data.set([Math.min(1, level * 2.8), Math.min(1, bass * 1.4), age, params.drive as number], 4);
        data.set([0.19 + rand(hit, 22) * 0.62, 0.19 + rand(hit, 33) * 0.62, params.bend as number, params.ground as number], 8);
        device.queue.writeBuffer(uniform, 0, data);

        const steps = reset ? 1 : Math.min(3, elapsed);
        if (steps > 0) {
          const pass = enc.beginComputePass({ label: 'Image Membrane propagation' });
          pass.setPipeline(step);
          for (let i = 0; i < steps; i++) {
            pass.setBindGroup(0, stepGroups[current]);
            pass.dispatchWorkgroups(Math.ceil(COLS / 8), Math.ceil(ROWS / 8));
            current = 1 - current;
          }
          pass.end();
        }
        lastTick = tick;
        lastSize = size;

        const pass = enc.beginRenderPass({
          colorAttachments: [{ view: out.out.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }],
          label: 'Image Membrane refraction',
        });
        pass.setBindGroup(0, imageGroups[current]);
        pass.setPipeline(image);
        pass.draw(3);
        pass.end();
      },
      dispose() {
        uniform.destroy();
        for (const texture of tank) texture.destroy();
      },
    };
  },
});
