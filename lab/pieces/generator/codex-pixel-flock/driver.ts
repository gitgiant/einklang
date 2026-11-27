import { definePiece } from '../../../api/index.ts';

const COLS = 168;
const ROWS = 94;
const COUNT = COLS * ROWS;

export default definePiece({
  gpu({ device, shader, formats }) {
    const module = shader('flock.wgsl');
    const C = GPUShaderStage.COMPUTE;
    const V = GPUShaderStage.VERTEX;
    const F = GPUShaderStage.FRAGMENT;
    const layout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: C | V | F, buffer: { type: 'uniform' } },
        { binding: 1, visibility: C | V, buffer: { type: 'read-only-storage' } },
        { binding: 2, visibility: C, buffer: { type: 'storage' } },
        { binding: 3, visibility: C | V | F, sampler: {} },
        { binding: 4, visibility: V | F, texture: {} },
        { binding: 5, visibility: C | V, texture: {} },
        { binding: 6, visibility: C | F, texture: {} },
      ],
    });
    const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [layout] });
    const step = device.createComputePipeline({ layout: pipelineLayout, compute: { module, entryPoint: 'cs_flock' } });
    const backdrop = device.createRenderPipeline({
      layout: pipelineLayout,
      vertex: { module, entryPoint: 'vs_full' },
      fragment: { module, entryPoint: 'fs_ground', targets: [{ format: formats.tex }] },
    });
    const add: GPUBlendComponent = { srcFactor: 'one', dstFactor: 'one' };
    const flock = device.createRenderPipeline({
      layout: pipelineLayout,
      vertex: { module, entryPoint: 'vs_grain' },
      fragment: { module, entryPoint: 'fs_grain', targets: [{ format: formats.tex, blend: { color: add, alpha: add } }] },
    });
    const sampler = device.createSampler({ minFilter: 'linear', magFilter: 'linear' });
    const data = new Float32Array(16);
    const uniform = device.createBuffer({ size: data.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const states = [0, 1].map(() => device.createBuffer({ size: COUNT * 32, usage: GPUBufferUsage.STORAGE }));
    let current = 0;
    let lastTick = -Infinity;
    let lastSize = '';
    let media: GPUTexture[] = [];
    let groups: GPUBindGroup[] = [];

    return {
      frame({ enc, in: ins, out, width, height, tick, time, params, past, rand }) {
        const source = ins.in as GPUTexture;
        const luma = ins.height as GPUTexture;
        const edges = ins.flow as GPUTexture;
        if (media[0] !== source || media[1] !== luma || media[2] !== edges) {
          media = [source, luma, edges];
          const views = media.map((texture) => texture.createView());
          groups = states.map((state, i) => device.createBindGroup({
            layout,
            entries: [
              { binding: 0, resource: { buffer: uniform } },
              { binding: 1, resource: { buffer: state } },
              { binding: 2, resource: { buffer: states[1 - i] } },
              { binding: 3, resource: sampler },
              ...views.map((resource, j) => ({ binding: 4 + j, resource })),
            ],
          }));
        }

        let level = 0;
        let bass = 0;
        let age = 48;
        for (let ago = 0; ago < 48; ago++) {
          const audio = past(ago);
          if (ago < 16) {
            level += audio.rms / 16;
            bass += (audio.bands[0] + audio.bands[1] + audio.bands[2]) / 48;
          }
          if (age === 48 && audio.onset && !past(ago + 1).onset) age = ago;
        }
        const size = `${width}x${height}`;
        const elapsed = tick - lastTick;
        const reset = elapsed < 0 || elapsed > 45 || size !== lastSize;
        const dt = Math.min(3, Math.max(0, elapsed)) / 60;
        const hit = tick - age;
        data.set([width / height, time, dt, Number(reset)]);
        data.set([Math.min(1, level * 2.8), Math.min(1, bass * 1.4), age, params.scatter as number], 4);
        data.set([0.26 + rand(hit, 47) * 0.48, 0.26 + rand(hit, 94) * 0.48, params.return as number, params.size as number], 8);
        data.set([params.ground as number, params.ink as number, 0, 0], 12);
        device.queue.writeBuffer(uniform, 0, data);

        if (reset || elapsed > 0) {
          const compute = enc.beginComputePass({ label: 'Pixel Flock springs' });
          compute.setPipeline(step);
          compute.setBindGroup(0, groups[current]);
          compute.dispatchWorkgroups(Math.ceil(COUNT / 128));
          compute.end();
          current = 1 - current;
        }
        lastTick = tick;
        lastSize = size;

        const pass = enc.beginRenderPass({
          colorAttachments: [{ view: out.out.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }],
          label: 'Pixel Flock picture and grains',
        });
        pass.setBindGroup(0, groups[current]);
        pass.setPipeline(backdrop);
        pass.draw(3);
        pass.setPipeline(flock);
        pass.draw(6, COUNT);
        pass.end();
      },
      dispose() {
        uniform.destroy();
        for (const state of states) state.destroy();
      },
    };
  },
});
