import { definePiece } from '../../../api/index.ts';

const SORT_UBYTES = 32; // 8 x 4 bytes
const BLIT_UBYTES = 16; // 4 x 4 bytes

export default definePiece({
  gpu: ({ device, shader }) => {
    const sortMod = shader('sort.wgsl');
    const blitMod = shader('blit.wgsl');

    const sortBuf = device.createBuffer({
      label: 'pixelsort-sort-u',
      size: SORT_UBYTES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    const blitBuf = device.createBuffer({
      label: 'pixelsort-blit-u',
      size: BLIT_UBYTES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    const sampler = device.createSampler({
      magFilter: 'linear',
      minFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
    });

    const sortBgl = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'float' } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: 'write-only', format: 'rgba16float' } },
      ],
    });
    const sortPipe = device.createComputePipeline({
      label: 'pixelsort-cs',
      layout: device.createPipelineLayout({ bindGroupLayouts: [sortBgl] }),
      compute: { module: sortMod, entryPoint: 'cs_sort' },
    });

    const blitPipe = device.createRenderPipeline({
      label: 'pixelsort-blit',
      layout: 'auto',
      vertex: { module: blitMod, entryPoint: 'vs_full' },
      fragment: { module: blitMod, entryPoint: 'fs_blit', targets: [{ format: 'rgba16float' }] },
    });

    let scratch: GPUTexture | null = null;
    let scratchW = 0;
    let scratchH = 0;

    const sortRaw = new ArrayBuffer(SORT_UBYTES);
    const sortU32 = new Uint32Array(sortRaw);
    const sortF32 = new Float32Array(sortRaw);
    const blitF32 = new Float32Array(4);

    return {
      frame({ enc, out, in: ins, params, audio, past, width, height }) {
        const srcTex = ins.in as GPUTexture;
        if (!scratch || scratchW !== width || scratchH !== height) {
          scratch?.destroy();
          scratch = device.createTexture({
            label: 'pixelsort-scratch',
            size: [width, height],
            format: 'rgba16float',
            usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING,
          });
          scratchW = width;
          scratchH = height;
        }

        // Smooth energy and decaying onset envelope from recent audio history (pure & deterministic)
        let energyAcc = 0;
        let onsetEnv = 0;
        for (let a = 0; a < 20; a++) {
          const f = past(a);
          const b = (f.bands[0] + f.bands[1] + f.bands[2]) / 3;
          if (a < 8) {
            energyAcc += f.rms * 0.65 + b * 0.55;
          }
          if (f.onset) {
            const dec = Math.exp(-a * 0.16);
            if (dec > onsetEnv) onsetEnv = dec;
          }
        }
        const energy = Math.min(1.2, energyAcc / 8);
        const bassNow = (audio.bands[0] + audio.bands[1] + audio.bands[2]) / 3;
        const beatKick = Math.pow(Math.max(0, 1 - audio.phase * 2.5), 2) * Math.min(1, bassNow * 1.8);
        const surge = Math.min(1, Math.max(onsetEnv, beatKick * 0.65));

        const axis = Math.round(params.direction as number) > 0 ? 1 : 0;
        const reverse = (params.reverse as boolean) ? 1 : 0;
        const baseThresh = params.threshold as number;
        const ceiling = Math.max(baseThresh + 0.08, params.ceiling as number);
        const energyAmt = params.energy as number;
        const baseLen = Math.max(8, Math.min(256, Math.round(params.length as number)));
        const onsetBoost = params.onset_boost as number;
        const mixAmt = params.mix as number;

        // Threshold drops as energy rises so more of the frame enters sorted runs
        const loThresh = Math.max(0.02, Math.min(ceiling - 0.06, baseThresh - energy * energyAmt * 0.34 - surge * 0.06));
        const hiThresh = Math.min(1.0, ceiling + surge * 0.04);
        // Onsets extend sort runs up toward full 256px strips
        const maxRun = Math.max(8, Math.min(256, Math.round(baseLen + (256 - baseLen) * surge * onsetBoost)));

        // Re-seed strip stagger subtly on beat bars so boundaries never sit still
        const staggerSeed = (Math.floor(audio.bar) * 2654435761) >>> 0;

        sortU32[0] = width;
        sortU32[1] = height;
        sortU32[2] = axis;
        sortU32[3] = reverse;
        sortF32[4] = loThresh;
        sortF32[5] = hiThresh;
        sortU32[6] = maxRun;
        sortU32[7] = staggerSeed;
        device.queue.writeBuffer(sortBuf, 0, sortRaw);

        const sortBind = device.createBindGroup({
          layout: sortBgl,
          entries: [
            { binding: 0, resource: { buffer: sortBuf } },
            { binding: 1, resource: srcTex.createView() },
            { binding: 2, resource: scratch.createView() },
          ],
        });

        const axisLen = axis === 1 ? height : width;
        const lineCount = axis === 1 ? width : height;
        const groupsAxis = Math.ceil((axisLen + 128) / 256);

        const cp = enc.beginComputePass({ label: 'pixelsort-pass' });
        cp.setPipeline(sortPipe);
        cp.setBindGroup(0, sortBind);
        cp.dispatchWorkgroups(groupsAxis, lineCount, 1);
        cp.end();

        blitF32[0] = mixAmt;
        blitF32[1] = surge;
        blitF32[2] = 0;
        blitF32[3] = 0;
        device.queue.writeBuffer(blitBuf, 0, blitF32);

        const blitBind = device.createBindGroup({
          layout: blitPipe.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: { buffer: blitBuf } },
            { binding: 1, resource: sampler },
            { binding: 2, resource: srcTex.createView() },
            { binding: 3, resource: scratch.createView() },
          ],
        });

        const rp = enc.beginRenderPass({
          label: 'pixelsort-blit-pass',
          colorAttachments: [{ view: out.out.createView(), loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 1 } }],
        });
        rp.setPipeline(blitPipe);
        rp.setBindGroup(0, blitBind);
        rp.draw(3);
        rp.end();
      },
      destroy() {
        scratch?.destroy();
        sortBuf.destroy();
        blitBuf.destroy();
      },
    };
  },
});
