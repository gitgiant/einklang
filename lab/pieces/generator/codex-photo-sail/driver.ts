import { BAR_TICKS, definePiece, srgbToLinear } from '../../../api/index.ts';

const COLS = 48;
const ROWS = 30;
const COUNT = COLS * ROWS;

export default definePiece({
  gpu({ device, shader, formats }) {
    const module = shader('sail.wgsl');
    const spring = device.createComputePipeline({
      layout: 'auto', compute: { module, entryPoint: 'cs_spring' },
    });
    const stage = device.createRenderPipeline({
      layout: 'auto',
      vertex: { module, entryPoint: 'vs_full' },
      fragment: { module, entryPoint: 'fs_stage', targets: [{ format: formats.tex }] },
    });
    const sail = device.createRenderPipeline({
      layout: 'auto',
      vertex: { module, entryPoint: 'vs_sail' },
      fragment: { module, entryPoint: 'fs_sail', targets: [{ format: formats.tex }] },
      depthStencil: { format: 'depth24plus', depthWriteEnabled: true, depthCompare: 'less' },
    });
    const sampler = device.createSampler({ minFilter: 'linear', magFilter: 'linear' });
    const data = new Float32Array(16);
    const uniform = device.createBuffer({ size: data.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const states = [0, 1].map(() => device.createBuffer({ size: COUNT * 32, usage: GPUBufferUsage.STORAGE }));
    let current = 0;
    let lastTick = -Infinity;
    let depth: GPUTexture | undefined;
    let depthView: GPUTextureView;
    let media: GPUTextureView[] = [];
    let textures: GPUTexture[] = [];
    let springGroups: GPUBindGroup[] = [];
    let sailGroups: GPUBindGroup[] = [];
    let stageGroup: GPUBindGroup;
    const common = [
      { binding: 0, resource: { buffer: uniform } },
      { binding: 1, resource: sampler },
    ];

    return {
      frame({ enc, in: ins, out, width, height, tick, time, params, audio, past, rand }) {
        const resized = !depth || depth.width !== width || depth.height !== height;
        if (resized) {
          depth?.destroy();
          depth = device.createTexture({ size: [width, height], format: 'depth24plus', usage: GPUTextureUsage.RENDER_ATTACHMENT });
          depthView = depth.createView();
        }
        const nextTextures = [ins.in, ins.height, ins.flow] as GPUTexture[];
        if (nextTextures.some((texture, i) => texture !== textures[i])) {
          textures = nextTextures;
          media = textures.map((texture) => texture.createView());
          springGroups = states.map((state, i) => device.createBindGroup({
            layout: spring.getBindGroupLayout(0),
            entries: [
              ...common,
              { binding: 2, resource: { buffer: state } },
              { binding: 3, resource: { buffer: states[1 - i] } },
              { binding: 4, resource: media[1] },
              { binding: 5, resource: media[2] },
            ],
          }));
          stageGroup = device.createBindGroup({
            layout: stage.getBindGroupLayout(0),
            entries: [...common, { binding: 6, resource: media[0] }],
          });
          sailGroups = states.map((state) => device.createBindGroup({
            layout: sail.getBindGroupLayout(0),
            entries: [...common, { binding: 2, resource: { buffer: state } }, { binding: 6, resource: media[0] }],
          }));
        }

        let bass = 0;
        let rms = 0;
        let age = 24;
        for (let ago = 0; ago < 24; ago++) {
          const a = past(ago);
          if (ago < 8) {
            bass += (a.bands[0] + a.bands[1] + a.bands[2]) / 24;
            rms += a.rms / 8;
          }
          if (age === 24 && a.onset && !past(ago + 1).onset) age = ago;
        }
        const elapsed = tick - lastTick;
        const reset = resized || elapsed < 0 || elapsed > 24;
        const dt = Math.min(3, Math.max(1, elapsed)) / 60;
        const beat = Math.pow(1 - audio.phase, 4) * bass;
        const impact = Math.pow(1 - age / 24, 3);
        const phraseTick = tick % (4 * BAR_TICKS);
        const settle = 1 - Math.min(1, Math.min(phraseTick, 4 * BAR_TICKS - phraseTick) / 18);
        const rgb = Number.parseInt((params.tint as string).slice(1), 16);
        data.set([width / height, time, dt, Number(reset)]);
        data.set([bass, rms, Math.max(impact, beat), params.drive as number], 4);
        data.set([0.22 + 0.56 * rand(tick - age, 68), settle, 0, 0], 8);
        data.set([srgbToLinear(rgb >>> 16), srgbToLinear((rgb >>> 8) & 255), srgbToLinear(rgb & 255), 0], 12);
        device.queue.writeBuffer(uniform, 0, data);

        if (reset || elapsed > 0) {
          const pass = enc.beginComputePass({ label: 'Photo Sail springs' });
          pass.setPipeline(spring);
          pass.setBindGroup(0, springGroups[current]);
          pass.dispatchWorkgroups(Math.ceil(COUNT / 64));
          pass.end();
          current = 1 - current;
        }
        lastTick = tick;

        const target = out.out.createView();
        const backing = enc.beginRenderPass({
          colorAttachments: [{ view: target, loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }],
          label: 'Photo Sail rail and backdrop',
        });
        backing.setPipeline(stage);
        backing.setBindGroup(0, stageGroup);
        backing.draw(3);
        backing.end();

        const mesh = enc.beginRenderPass({
          colorAttachments: [{ view: target, loadOp: 'load', storeOp: 'store' }],
          depthStencilAttachment: { view: depthView, depthLoadOp: 'clear', depthStoreOp: 'discard', depthClearValue: 1 },
          label: 'Photo Sail fabric',
        });
        mesh.setPipeline(sail);
        mesh.setBindGroup(0, sailGroups[current]);
        mesh.draw((COLS - 1) * (ROWS - 1) * 6);
        mesh.end();
      },
      dispose() {
        uniform.destroy();
        depth?.destroy();
        for (const state of states) state.destroy();
      },
    };
  },
});
