import { BAR_TICKS, definePiece, srgbToLinear } from '../../../api/index.ts';

const MAGNETS = 28 * 18;
const WELLS = 6 * 4;
const GRAINS = 112 * 64;

export default definePiece({
  gpu({ device, shader, formats }) {
    const module = shader('forces.wgsl');
    const compute = (entryPoint: string) => device.createComputePipeline({
      layout: 'auto', compute: { module, entryPoint },
    });
    const render = (vertex: string, fragment: string, blend?: GPUBlendState) => device.createRenderPipeline({
      layout: 'auto',
      vertex: { module, entryPoint: vertex },
      fragment: { module, entryPoint: fragment, targets: [{ format: formats.tex, blend }] },
    });
    const add: GPUBlendComponent = { srcFactor: 'one', dstFactor: 'one' };
    const peaks = compute('cs_peaks');
    const dust = compute('cs_dust');
    const surface = render('vs_full', 'fs_surface');
    const needles = render('vs_needle', 'fs_needle', {
      color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
      alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
    });
    const grains = render('vs_grain', 'fs_grain', { color: add, alpha: add });
    const sampler = device.createSampler({ minFilter: 'linear', magFilter: 'linear' });
    const data = new Float32Array(16);
    const uniform = device.createBuffer({ size: data.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const buffers = (bytes: number) => [0, 1].map(() => device.createBuffer({ size: bytes, usage: GPUBufferUsage.STORAGE }));
    const peakStates = buffers(MAGNETS * 32);
    const dustStates = buffers(GRAINS * 16);
    let current = 0;
    let lastTick = -Infinity;
    let lastMode = -1;
    let lastSize = '';
    let textures: GPUTexture[] = [];
    let peakGroups: GPUBindGroup[] = [];
    let dustGroups: GPUBindGroup[] = [];
    let needleGroups: GPUBindGroup[] = [];
    let grainGroups: GPUBindGroup[] = [];
    let surfaceGroups: GPUBindGroup[] = [];

    return {
      frame({ enc, in: ins, out, width, height, tick, time, params, audio, past }) {
        const nextTextures = [ins.in, ins.height, ins.flow] as GPUTexture[];
        if (nextTextures.some((texture, i) => texture !== textures[i])) {
          textures = nextTextures;
          const [photo, luma, edges] = textures.map((texture) => texture.createView());
          const u = { buffer: uniform };
          const b = (buffer: GPUBuffer) => ({ buffer });
          const group = (pipeline: GPUComputePipeline | GPURenderPipeline, resources: Record<number, GPUBindingResource>) =>
            device.createBindGroup({
              layout: pipeline.getBindGroupLayout(0),
              entries: Object.entries(resources).map(([binding, resource]) => ({ binding: Number(binding), resource })),
            });
          peakGroups = peakStates.map((state, i) => group(peaks, {
            0: u, 1: sampler, 2: luma, 5: b(state), 6: b(peakStates[1 - i]),
          }));
          dustGroups = dustStates.map((state, i) => group(dust, {
            0: u, 1: sampler, 3: edges, 5: b(peakStates[1 - i]), 7: b(state), 8: b(dustStates[1 - i]),
          }));
          needleGroups = peakStates.map((state) => group(needles, {
            0: u, 1: sampler, 4: photo, 5: b(state),
          }));
          grainGroups = dustStates.map((state) => group(grains, {
            0: u, 1: sampler, 4: photo, 7: b(state),
          }));
          surfaceGroups = peakStates.map((state) => group(surface, {
            0: u, 1: sampler, 3: edges, 4: photo, 5: b(state),
          }));
        }

        let bass = 0;
        let rms = 0;
        let age = 22;
        for (let ago = 0; ago < 22; ago++) {
          const a = past(ago);
          if (ago < 7) {
            bass += (a.bands[0] + a.bands[1] + a.bands[2]) / 21;
            rms += a.rms / 7;
          }
          if (age === 22 && a.onset && !past(ago + 1).onset) age = ago;
        }
        const mode = params.mode as number;
        const size = `${width}x${height}`;
        const elapsed = tick - lastTick;
        const reset = elapsed < 0 || elapsed > 24 || size !== lastSize || mode !== lastMode;
        const dt = Math.min(3, Math.max(1, elapsed)) / 60;
        const beat = Math.pow(1 - audio.phase, 4) * bass;
        const hit = Math.pow(1 - age / 22, 3);
        const phraseTick = tick % (4 * BAR_TICKS);
        const settle = 1 - Math.min(1, Math.min(phraseTick, 4 * BAR_TICKS - phraseTick) / 18);
        const rgb = Number.parseInt((params.tint as string).slice(1), 16);
        data.set([width / height, time, dt, Number(reset)]);
        data.set([bass, rms, Math.max(hit, beat), params.drive as number], 4);
        data.set([mode, settle, 0, 0], 8);
        data.set([srgbToLinear(rgb >>> 16), srgbToLinear((rgb >>> 8) & 255), srgbToLinear(rgb & 255), 0], 12);
        device.queue.writeBuffer(uniform, 0, data);

        const gravity = mode === 1;
        if (reset || elapsed > 0) {
          const pass = enc.beginComputePass({ label: 'Photo Forces bright peaks' });
          pass.setPipeline(peaks);
          pass.setBindGroup(0, peakGroups[current]);
          pass.dispatchWorkgroups(Math.ceil((gravity ? WELLS : MAGNETS) / 64));
          if (gravity) {
            pass.setPipeline(dust);
            pass.setBindGroup(0, dustGroups[current]);
            pass.dispatchWorkgroups(Math.ceil(GRAINS / 64));
          }
          pass.end();
          current = 1 - current;
        }
        lastTick = tick;
        lastSize = size;
        lastMode = mode;

        const pass = enc.beginRenderPass({
          colorAttachments: [{ view: out.out.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }],
          label: 'Photo Forces surface and relief',
        });
        pass.setPipeline(surface);
        pass.setBindGroup(0, surfaceGroups[current]);
        pass.draw(3);
        pass.setPipeline(gravity ? grains : needles);
        pass.setBindGroup(0, gravity ? grainGroups[current] : needleGroups[current]);
        pass.draw(6, gravity ? GRAINS : MAGNETS);
        pass.end();
      },
      dispose() {
        uniform.destroy();
        for (const state of [...peakStates, ...dustStates]) state.destroy();
      },
    };
  },
});
