import { definePiece, oklch, type Palette } from '../../../api/index.ts';

const MAP_W = 640;
const MAP_H = 360;
const CELLS = MAP_W * MAP_H;
const AGENTS = 32768;
const WARMUP = 22;
const UBYTES = 256;

export default definePiece({
  gpu: ({ device, shader }) => {
    const mod = shader('physarum.wgsl');
    const ubuf = device.createBuffer({ label: 'agy-physarum u', size: UBYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const agentBuf = device.createBuffer({ label: 'agy-physarum agents', size: AGENTS * 16, usage: GPUBufferUsage.STORAGE });
    const trailA = device.createBuffer({ label: 'agy-physarum trailA', size: CELLS * 8, usage: GPUBufferUsage.STORAGE });
    const trailB = device.createBuffer({ label: 'agy-physarum trailB', size: CELLS * 8, usage: GPUBufferUsage.STORAGE });
    const depBuf = device.createBuffer({ label: 'agy-physarum dep', size: CELLS * 8, usage: GPUBufferUsage.STORAGE });

    const csBgl = device.createBindGroupLayout({
      label: 'agy-physarum cs',
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
        { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
        { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
      ],
    });
    const csLayout = device.createPipelineLayout({ bindGroupLayouts: [csBgl] });
    const pClear = device.createComputePipeline({ label: 'agy-physarum clear', layout: csLayout, compute: { module: mod, entryPoint: 'cs_clear' } });
    const pInit = device.createComputePipeline({ label: 'agy-physarum init', layout: csLayout, compute: { module: mod, entryPoint: 'cs_init' } });
    const pAgents = device.createComputePipeline({ label: 'agy-physarum agents', layout: csLayout, compute: { module: mod, entryPoint: 'cs_agents' } });
    const pDiffuse = device.createComputePipeline({ label: 'agy-physarum diffuse', layout: csLayout, compute: { module: mod, entryPoint: 'cs_diffuse' } });

    const fsBgl = device.createBindGroupLayout({
      label: 'agy-physarum fs',
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } },
      ],
    });
    const pRender = device.createRenderPipeline({
      label: 'agy-physarum render',
      layout: device.createPipelineLayout({ bindGroupLayouts: [fsBgl] }),
      vertex: { module: mod, entryPoint: 'vs_full' },
      fragment: { module: mod, entryPoint: 'fs_render', targets: [{ format: 'rgba16float' }] },
    });

    const mkCsBg = (rd: GPUBuffer, wr: GPUBuffer) =>
      device.createBindGroup({
        layout: csBgl,
        entries: [
          { binding: 0, resource: { buffer: ubuf } },
          { binding: 1, resource: { buffer: agentBuf } },
          { binding: 2, resource: { buffer: rd } },
          { binding: 3, resource: { buffer: wr } },
          { binding: 4, resource: { buffer: depBuf } },
        ],
      });
    const bgAB = mkCsBg(trailA, trailB);
    const bgBA = mkCsBg(trailB, trailA);
    const rdA = device.createBindGroup({ layout: fsBgl, entries: [{ binding: 0, resource: { buffer: ubuf } }, { binding: 2, resource: { buffer: trailA } }] });
    const rdB = device.createBindGroup({ layout: fsBgl, entries: [{ binding: 0, resource: { buffer: ubuf } }, { binding: 2, resource: { buffer: trailB } }] });

    const udata = new Float32Array(UBYTES / 4);
    const gx = Math.ceil(MAP_W / 8), gy = Math.ceil(MAP_H / 8), ga = Math.ceil(AGENTS / 128);
    let cur = 0; // 0 => latest trail is trailA, 1 => trailB
    let lastTick = -Infinity;

    return {
      frame({ enc, out, in: ins, params, audio, time, tick, past, width, height }) {
        const bass = (audio.bands[0] + audio.bands[1] + audio.bands[2]) / 3;
        const mid = (audio.bands[4] + audio.bands[5] + audio.bands[6] + audio.bands[7]) / 4;
        const high = (audio.bands[11] + audio.bands[12] + audio.bands[13] + audio.bands[14]) / 4;
        let kick = 0;
        for (let ago = 0; ago < 18; ago++) {
          if (past(ago).onset) { kick = Math.max(kick, Math.exp(-ago / 5)); break; }
        }

        const reset = lastTick === -Infinity || tick < lastTick || tick - lastTick > 120;
        const stepNow = reset || tick !== lastTick;

        const pal = (ins.palette as Palette | undefined)?.stops ??
          Array.from({ length: 6 }, (_, i) => oklch(0.7, 0.17, audio.pal + i / 6));
        const palN = Math.min(8, Math.max(1, pal.length));

        udata.fill(0);
        udata.set([MAP_W, MAP_H, AGENTS, width / Math.max(height, 1)], 0);
        udata.set([params.speed as number, params.sensor_angle as number, params.sensor_dist as number, params.turn as number], 4);
        udata.set([params.decay as number, 0.38, params.glow as number, kick], 8);
        udata.set([time, audio.rms, bass, kick], 12);
        udata.set([mid, high, audio.phase, audio.onset ? 1 : 0], 16);
        udata.set([(tick % 65536) + 1, reset ? 1 : 0, 0, 0], 20);
        for (let i = 0; i < palN; i++) udata.set([pal[i][0], pal[i][1], pal[i][2], 0], 24 + i * 4);
        udata.set([palN, 0, 0, 0], 56);
        device.queue.writeBuffer(ubuf, 0, udata);

        if (stepNow) {
          const cp = enc.beginComputePass();
          if (reset) {
            cur = 0;
            cp.setPipeline(pClear);
            cp.setBindGroup(0, bgAB); cp.dispatchWorkgroups(gx, gy);
            cp.setBindGroup(0, bgBA); cp.dispatchWorkgroups(gx, gy);
            cp.setPipeline(pInit);
            cp.setBindGroup(0, bgAB); cp.dispatchWorkgroups(ga);
            for (let s = 0; s < WARMUP; s++) {
              const bg = cur === 0 ? bgAB : bgBA;
              cp.setPipeline(pAgents); cp.setBindGroup(0, bg); cp.dispatchWorkgroups(ga);
              cp.setPipeline(pDiffuse); cp.setBindGroup(0, bg); cp.dispatchWorkgroups(gx, gy);
              cur ^= 1;
            }
          } else {
            const bg = cur === 0 ? bgAB : bgBA;
            cp.setPipeline(pAgents); cp.setBindGroup(0, bg); cp.dispatchWorkgroups(ga);
            cp.setPipeline(pDiffuse); cp.setBindGroup(0, bg); cp.dispatchWorkgroups(gx, gy);
            cur ^= 1;
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
      dispose: () => { ubuf.destroy(); agentBuf.destroy(); trailA.destroy(); trailB.destroy(); depBuf.destroy(); },
      status: () => `physarum ${AGENTS} agents ${MAP_W}x${MAP_H}`,
    };
  },
});
