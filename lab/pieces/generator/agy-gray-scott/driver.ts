import { definePiece, oklch, type Palette } from '../../../api/index.ts';

const SIM_W = 512;
const SIM_H = 288;
const CELLS = SIM_W * SIM_H;
const SUBSTEPS = 6;
const WARMUP = 30;
const UBYTES = 256; // 64 floats (16 vec4f)

export default definePiece({
  gpu: ({ device, shader }) => {
    const mod = shader('sim.wgsl');
    const ubuf = device.createBuffer({ label: 'agy-gray-scott u', size: UBYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const bufA = device.createBuffer({ label: 'agy-gray-scott A', size: CELLS * 8, usage: GPUBufferUsage.STORAGE });
    const bufB = device.createBuffer({ label: 'agy-gray-scott B', size: CELLS * 8, usage: GPUBufferUsage.STORAGE });

    const csBgl = device.createBindGroupLayout({
      label: 'agy-gray-scott cs',
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
      ],
    });
    const csLayout = device.createPipelineLayout({ bindGroupLayouts: [csBgl] });
    const pInit = device.createComputePipeline({ label: 'agy-gray-scott init', layout: csLayout, compute: { module: mod, entryPoint: 'cs_init' } });
    const pStep = device.createComputePipeline({ label: 'agy-gray-scott step', layout: csLayout, compute: { module: mod, entryPoint: 'cs_step' } });

    const fsBgl = device.createBindGroupLayout({
      label: 'agy-gray-scott fs',
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } },
      ],
    });
    const pRender = device.createRenderPipeline({
      label: 'agy-gray-scott render',
      layout: device.createPipelineLayout({ bindGroupLayouts: [fsBgl] }),
      vertex: { module: mod, entryPoint: 'vs_full' },
      fragment: { module: mod, entryPoint: 'fs_render', targets: [{ format: 'rgba16float' }] },
    });

    const bgAB = device.createBindGroup({ layout: csBgl, entries: [{ binding: 0, resource: { buffer: ubuf } }, { binding: 1, resource: { buffer: bufA } }, { binding: 2, resource: { buffer: bufB } }] });
    const bgBA = device.createBindGroup({ layout: csBgl, entries: [{ binding: 0, resource: { buffer: ubuf } }, { binding: 1, resource: { buffer: bufB } }, { binding: 2, resource: { buffer: bufA } }] });
    const rdA = device.createBindGroup({ layout: fsBgl, entries: [{ binding: 0, resource: { buffer: ubuf } }, { binding: 1, resource: { buffer: bufA } }] });
    const rdB = device.createBindGroup({ layout: fsBgl, entries: [{ binding: 0, resource: { buffer: ubuf } }, { binding: 1, resource: { buffer: bufB } }] });

    const udata = new Float32Array(UBYTES / 4);
    const gx = Math.ceil(SIM_W / 8), gy = Math.ceil(SIM_H / 8);
    let cur = 0; // 0 => latest state is in bufA, 1 => bufB
    let lastTick = -Infinity;
    let seedCount = 0;

    return {
      frame({ enc, out, in: ins, params, audio, time, tick, past, width, height }) {
        const bass = (audio.bands[0] + audio.bands[1] + audio.bands[2]) / 3;
        const mid = (audio.bands[4] + audio.bands[5] + audio.bands[6] + audio.bands[7]) / 4;
        const high = (audio.bands[11] + audio.bands[12] + audio.bands[13] + audio.bands[14]) / 4;
        let kick = 0;
        for (let ago = 0; ago < 20; ago++) {
          if (past(ago).onset) { kick = Math.max(kick, Math.exp(-ago / 5.5)); break; }
        }

        const feed = params.feed as number;
        const kill = params.kill as number;
        const pulse = params.pulse as number;
        const relief = params.relief as number;
        const glow = params.glow as number;
        const swirl = params.swirl as number;

        const reset = lastTick === -Infinity || tick < lastTick || tick - lastTick > 120;
        const stepNow = reset || tick !== lastTick;

        if (audio.onset && stepNow) seedCount++;
        const sAng = seedCount * 2.3999632 + time * 0.4;
        const sRad = 0.14 + 0.28 * ((seedCount * 0.6180339) % 1);
        const seedX = Math.cos(sAng) * sRad * 1.25;
        const seedY = Math.sin(sAng) * sRad * 0.85;
        const seedR = 0.04 + 0.06 * bass;
        const seedAmt = audio.onset ? (0.12 * pulse) / SUBSTEPS : (bass > 0.62 ? (0.025 * pulse) / SUBSTEPS : 0);

        const pal = (ins.palette as Palette | undefined)?.stops ??
          Array.from({ length: 6 }, (_, i) => oklch(0.68, 0.18, audio.pal + i / 6));
        const palN = Math.min(8, Math.max(1, pal.length));

        udata.fill(0);
        udata.set([SIM_W, SIM_H, width, height], 0);
        udata.set([feed, kill, pulse, swirl], 4);
        udata.set([time, audio.rms, bass, kick], 8);
        udata.set([mid, high, audio.phase, audio.bar], 12);
        udata.set([relief, glow, audio.onset ? 1 : 0, reset ? 1 : 0], 16);
        udata.set([seedX, seedY, seedR, reset ? 0 : seedAmt], 20);
        for (let i = 0; i < palN; i++) udata.set([pal[i][0], pal[i][1], pal[i][2], 0], 24 + i * 4);
        udata.set([palN, 0, 0, 0], 56);
        device.queue.writeBuffer(ubuf, 0, udata);

        if (stepNow) {
          const cp = enc.beginComputePass();
          if (reset) {
            seedCount = 0;
            cur = 0;
            cp.setPipeline(pInit);
            cp.setBindGroup(0, bgBA); // writes to bufA
            cp.dispatchWorkgroups(gx, gy);
            cp.setPipeline(pStep);
            for (let s = 0; s < WARMUP; s++) {
              cp.setBindGroup(0, cur === 0 ? bgAB : bgBA);
              cp.dispatchWorkgroups(gx, gy);
              cur ^= 1;
            }
          } else {
            cp.setPipeline(pStep);
            for (let s = 0; s < SUBSTEPS; s++) {
              cp.setBindGroup(0, cur === 0 ? bgAB : bgBA);
              cp.dispatchWorkgroups(gx, gy);
              cur ^= 1;
            }
          }
          cp.end();
          lastTick = tick;
        }

        const rp = enc.beginRenderPass({
          colorAttachments: [{ view: out.out.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }],
        });
        rp.setPipeline(pRender);
        rp.setBindGroup(0, cur === 0 ? rdA : rdB);
        rp.draw(3);
        rp.end();
      },
      dispose: () => { ubuf.destroy(); bufA.destroy(); bufB.destroy(); },
      status: () => `gray-scott ${SIM_W}x${SIM_H}`,
    };
  },
});
