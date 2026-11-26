import { definePiece, oklch, type Palette } from '../../../api/index.ts';

const PARTICLES = 24576;
const WARMUP = 36;
const UBYTES = 320; // 80 floats: mat4(16) + 5 vec4(20) + 8 pal(32) + pal_n(4) + pad(8)
const ADD: GPUBlendState = {
  color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
  alpha: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
};

function perspective(fovy: number, aspect: number, near: number, far: number): number[] {
  const f = 1 / Math.tan(fovy / 2), nf = 1 / (near - far);
  return [f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, far * nf, -1, 0, 0, near * far * nf, 0];
}
function lookAt(eye: number[], at: number[], up: number[]): number[] {
  const sub = (a: number[], b: number[]) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const norm = (a: number[]) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
  const cross = (a: number[], b: number[]) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const z = norm(sub(eye, at)), x = norm(cross(up, z)), y = cross(z, x);
  return [x[0], y[0], z[0], 0, x[1], y[1], z[1], 0, x[2], y[2], z[2], 0, -dot(x, eye), -dot(y, eye), -dot(z, eye), 1];
}
const mul4 = (a: number[], b: number[]) => Array.from({ length: 16 }, (_, i) => {
  const c = Math.floor(i / 4), r = i % 4;
  return a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
});

export default definePiece({
  gpu: ({ device, shader }) => {
    const csMod = shader('sim.wgsl');
    const rdMod = shader('render.wgsl');

    const ubuf = device.createBuffer({ label: 'agy-attractor u', size: UBYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const partBuf = device.createBuffer({ label: 'agy-attractor parts', size: PARTICLES * 32, usage: GPUBufferUsage.STORAGE });

    const csBgl = device.createBindGroupLayout({
      label: 'agy-attractor cs',
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
      ],
    });
    const csLayout = device.createPipelineLayout({ bindGroupLayouts: [csBgl] });
    const pInit = device.createComputePipeline({ label: 'agy-attractor init', layout: csLayout, compute: { module: csMod, entryPoint: 'cs_init' } });
    const pStep = device.createComputePipeline({ label: 'agy-attractor step', layout: csLayout, compute: { module: csMod, entryPoint: 'cs_step' } });
    const csBg = device.createBindGroup({
      layout: csBgl,
      entries: [{ binding: 0, resource: { buffer: ubuf } }, { binding: 1, resource: { buffer: partBuf } }],
    });

    const bgBgl = device.createBindGroupLayout({
      label: 'agy-attractor bg',
      entries: [{ binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } }],
    });
    const pBg = device.createRenderPipeline({
      label: 'agy-attractor bg',
      layout: device.createPipelineLayout({ bindGroupLayouts: [bgBgl] }),
      vertex: { module: rdMod, entryPoint: 'vs_full' },
      fragment: { module: rdMod, entryPoint: 'fs_bg', targets: [{ format: 'rgba16float' }] },
    });
    const bgBg = device.createBindGroup({ layout: bgBgl, entries: [{ binding: 0, resource: { buffer: ubuf } }] });

    const ptBgl = device.createBindGroupLayout({
      label: 'agy-attractor pt',
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
      ],
    });
    const pPart = device.createRenderPipeline({
      label: 'agy-attractor part',
      layout: device.createPipelineLayout({ bindGroupLayouts: [ptBgl] }),
      vertex: { module: rdMod, entryPoint: 'vs_part' },
      fragment: { module: rdMod, entryPoint: 'fs_part', targets: [{ format: 'rgba16float', blend: ADD }] },
    });
    const ptBg = device.createBindGroup({
      layout: ptBgl,
      entries: [{ binding: 0, resource: { buffer: ubuf } }, { binding: 1, resource: { buffer: partBuf } }],
    });

    const udata = new Float32Array(UBYTES / 4);
    const groups = Math.ceil(PARTICLES / 128);
    let lastTick = -Infinity;
    let lastKind = -1;

    return {
      frame({ enc, out, in: ins, params, audio, time, tick, past, width, height }) {
        const bass = (audio.bands[0] + audio.bands[1] + audio.bands[2]) / 3;
        const mid = (audio.bands[4] + audio.bands[5] + audio.bands[6] + audio.bands[7]) / 4;
        const high = (audio.bands[11] + audio.bands[12] + audio.bands[13] + audio.bands[14]) / 4;
        let kick = 0;
        for (let ago = 0; ago < 20; ago++) {
          if (past(ago).onset) { kick = Math.max(kick, Math.exp(-ago / 5.5)); break; }
        }

        const kind = Math.min(3, Math.max(0, Math.round(params.attractor as number)));
        const reset = lastTick === -Infinity || tick < lastTick || tick - lastTick > 120 || kind !== lastKind;
        const stepNow = reset || tick !== lastTick;

        const aspect = width / Math.max(height, 1);
        const bps = (audio.bpm > 0 ? audio.bpm : 120) / 60;
        const ang = (time * bps / 16) * (params.orbit as number) * Math.PI * 2 + 0.5;
        const elev = 0.42 * Math.sin(time * 0.31 + 0.3) + 0.14 * bass;
        const dist = 2.65 - 0.38 * kick - 0.22 * bass;
        const eye = [Math.cos(ang) * Math.cos(elev) * dist, Math.sin(elev) * dist, Math.sin(ang) * Math.cos(elev) * dist];
        const roll = 0.18 * Math.sin(time * 0.27) + 0.08 * kick;
        const up = [Math.sin(roll), Math.cos(roll), 0];
        const vp = mul4(perspective(0.86 - 0.08 * kick, aspect, 0.08, 25), lookAt(eye, [0, 0, 0], up));

        const pal = (ins.palette as Palette | undefined)?.stops ??
          Array.from({ length: 6 }, (_, i) => oklch(0.72, 0.18, audio.pal + i / 6));
        const palN = Math.min(8, Math.max(1, pal.length));

        udata.fill(0);
        udata.set(vp, 0);
        udata.set([PARTICLES, kind, params.speed as number, params.chaos as number], 16);
        udata.set([params.streak as number, params.size as number, params.glow as number, aspect], 20);
        udata.set([time, audio.rms, bass, kick], 24);
        udata.set([mid, high, audio.phase, audio.onset ? 1 : 0], 28);
        udata.set([(tick % 65536) + 1, reset ? 1 : 0, width, height], 32);
        for (let i = 0; i < palN; i++) udata.set([pal[i][0], pal[i][1], pal[i][2], 0], 36 + i * 4);
        udata.set([palN, 0, 0, 0], 68);
        device.queue.writeBuffer(ubuf, 0, udata);

        if (stepNow) {
          const cp = enc.beginComputePass();
          if (reset) {
            lastKind = kind;
            cp.setPipeline(pInit); cp.setBindGroup(0, csBg); cp.dispatchWorkgroups(groups);
            cp.setPipeline(pStep);
            for (let s = 0; s < WARMUP; s++) cp.dispatchWorkgroups(groups);
          } else {
            cp.setPipeline(pStep); cp.setBindGroup(0, csBg); cp.dispatchWorkgroups(groups);
          }
          cp.end();
          lastTick = tick;
        }

        const rp = enc.beginRenderPass({
          colorAttachments: [{ view: out.out.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }],
        });
        rp.setPipeline(pBg); rp.setBindGroup(0, bgBg); rp.draw(3);
        rp.setPipeline(pPart); rp.setBindGroup(0, ptBg); rp.draw(6, PARTICLES);
        rp.end();
      },
      dispose: () => { ubuf.destroy(); partBuf.destroy(); },
      status: () => `attractor ${PARTICLES} particles`,
    };
  },
});
