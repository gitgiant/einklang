import { definePiece, oklabToLinear, oklch, type Palette } from '../../../api/index.ts';

const MAX_POINTS = 128 * 1024;
// Sim uniform: 4 vec4fs = 64 bytes
const SIM_UBYTES = 4 * 16;
// Draw uniform: mat4x4f (64B) + 4 vec4fs (64B) + 8 vec4fs palette (128B) = 256 bytes
const DRAW_UBYTES = 64 + 64 + 128;

const ADD_BLEND: GPUBlendState = {
  color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
  alpha: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
};

function samplePalette8(pal: Palette | undefined, fallbackHue: number, out: Float32Array, offset: number): void {
  const stops = pal?.stops?.length
    ? pal.stops
    : Array.from({ length: 6 }, (_, i) => oklch(0.74, 0.17, fallbackHue + i * 0.14));
  const n = stops.length;
  for (let i = 0; i < 8; i++) {
    const t = (i / 7) * (n - 1);
    const a = Math.min(n - 1, Math.floor(t));
    const b = Math.min(n - 1, a + 1);
    const f = t - a;
    const lab: [number, number, number] = [
      stops[a][0] + (stops[b][0] - stops[a][0]) * f,
      stops[a][1] + (stops[b][1] - stops[a][1]) * f,
      stops[a][2] + (stops[b][2] - stops[a][2]) * f,
    ];
    const rgb = oklabToLinear(lab);
    out[offset + i * 4 + 0] = Math.max(0, rgb[0]);
    out[offset + i * 4 + 1] = Math.max(0, rgb[1]);
    out[offset + i * 4 + 2] = Math.max(0, rgb[2]);
    out[offset + i * 4 + 3] = 1;
  }
}

function perspective(fovy: number, aspect: number, near: number, far: number): number[] {
  const f = 1 / Math.tan(fovy / 2);
  const nf = 1 / (near - far);
  return [f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, far * nf, -1, 0, 0, near * far * nf, 0];
}

function lookAt(eye: number[], at: number[], up: number[]): number[] {
  const sub = (a: number[], b: number[]) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const norm = (a: number[]) => {
    const l = Math.hypot(a[0], a[1], a[2]) || 1;
    return [a[0] / l, a[1] / l, a[2] / l];
  };
  const cross = (a: number[], b: number[]) => [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
  const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const z = norm(sub(eye, at));
  const x = norm(cross(up, z));
  const y = cross(z, x);
  return [
    x[0], y[0], z[0], 0,
    x[1], y[1], z[1], 0,
    x[2], y[2], z[2], 0,
    -dot(x, eye), -dot(y, eye), -dot(z, eye), 1,
  ];
}

function mul4(a: number[], b: number[]): number[] {
  const r = new Array<number>(16);
  for (let c = 0; c < 4; c++) {
    for (let row = 0; row < 4; row++) {
      r[c * 4 + row] =
        a[row] * b[c * 4] +
        a[4 + row] * b[c * 4 + 1] +
        a[8 + row] * b[c * 4 + 2] +
        a[12 + row] * b[c * 4 + 3];
    }
  }
  return r;
}

export default definePiece({
  gpu: ({ device, shader }) => {
    const simMod = shader('sim.wgsl');
    const drawMod = shader('draw.wgsl');

    const simBuf = device.createBuffer({ label: 'attractor-sim-u', size: SIM_UBYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const drawBuf = device.createBuffer({ label: 'attractor-draw-u', size: DRAW_UBYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    // 2 vec4fs (32 bytes) per particle
    const ptsBuf = device.createBuffer({ label: 'attractor-pts', size: MAX_POINTS * 32, usage: GPUBufferUsage.STORAGE });

    const csBgl = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
      ],
    });
    const csLayout = device.createPipelineLayout({ bindGroupLayouts: [csBgl] });
    const seedPipe = device.createComputePipeline({ layout: csLayout, label: 'attractor-seed', compute: { module: simMod, entryPoint: 'cs_seed' } });
    const stepPipe = device.createComputePipeline({ layout: csLayout, label: 'attractor-step', compute: { module: simMod, entryPoint: 'cs_step' } });
    const csBind = device.createBindGroup({
      layout: csBgl,
      entries: [
        { binding: 0, resource: { buffer: simBuf } },
        { binding: 1, resource: { buffer: ptsBuf } },
      ],
    });

    const bgPipe = device.createRenderPipeline({
      label: 'attractor-bg',
      layout: 'auto',
      vertex: { module: drawMod, entryPoint: 'vs_full' },
      fragment: { module: drawMod, entryPoint: 'fs_bg', targets: [{ format: 'rgba16float' }] },
    });
    const splatPipe = device.createRenderPipeline({
      label: 'attractor-splat',
      layout: 'auto',
      vertex: { module: drawMod, entryPoint: 'vs_splat' },
      fragment: {
        module: drawMod,
        entryPoint: 'fs_splat',
        targets: [{ format: 'rgba16float', blend: ADD_BLEND }],
      },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
    });

    const bgBind = device.createBindGroup({
      layout: bgPipe.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: drawBuf } }],
    });
    const splatBind = device.createBindGroup({
      layout: splatPipe.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: drawBuf } },
        { binding: 1, resource: { buffer: ptsBuf } },
      ],
    });

    const simData = new Float32Array(SIM_UBYTES / 4);
    const drawData = new Float32Array(DRAW_UBYTES / 4);
    let seededType = -1;
    let seededCount = 0;

    return {
      frame({ enc, out, in: ins, params, audio, tick, time, past, width, height }) {
        const kind = Math.max(0, Math.min(2, Math.round(params.attractor as number)));
        const count = Math.max(16, Math.min(128, Math.round(params.points as number))) * 1024;
        const morph = params.morph as number;
        const spin = params.spin as number;
        const speed = params.speed as number;
        const size = params.size as number;
        const gain = params.gain as number;

        // Smooth band energies over ~20 ticks so attractor parameters morph organically without jitter
        let bassAcc = 0, midAcc = 0, highAcc = 0, rmsAcc = 0;
        const span = 20;
        for (let a = 0; a < span; a++) {
          const f = past(a);
          bassAcc += (f.bands[0] + f.bands[1] + f.bands[2]) / 3;
          midAcc += (f.bands[5] + f.bands[6] + f.bands[7] + f.bands[8]) / 4;
          highAcc += (f.bands[11] + f.bands[12] + f.bands[13] + f.bands[14]) / 4;
          rmsAcc += f.rms;
        }
        const bass = bassAcc / span;
        const mid = midAcc / span;
        const high = highAcc / span;
        const rms = rmsAcc / span;

        let kick = 0;
        for (let a = 0; a < 16; a++) {
          if (past(a).onset) kick = Math.max(kick, Math.exp(-a / 5));
        }

        // Compute curated chaotic parameters slowly morphing with band energy
        let p0 = 0, p1 = 0, p2 = 0, p3 = 0;
        let centerX = 0, centerY = 0, centerZ = 0, invScale = 1;
        if (kind === 0) {
          // Lorenz: sigma, rho, beta
          p0 = Math.max(6.5, Math.min(15.5, 10.0 + Math.sin(time * 0.19) * 1.1 + morph * (bass - 0.25) * 4.2));
          p1 = Math.max(21.0, Math.min(37.0, 28.0 + Math.cos(time * 0.14) * 2.4 + morph * (mid - 0.25) * 8.5));
          p2 = Math.max(1.9, Math.min(3.6, 2.6667 + Math.sin(time * 0.23) * 0.28 + morph * (high - 0.25) * 0.9));
          p3 = 0;
          centerZ = p1 - 1.5;
          invScale = 1 / 24.5;
        } else if (kind === 1) {
          // Clifford: curated chaotic ribbon neighborhood
          p0 = -1.72 + 0.24 * Math.sin(time * 0.15) + morph * (bass - 0.25) * 0.42;
          p1 = 1.82 + 0.22 * Math.cos(time * 0.12) + morph * (mid - 0.25) * 0.38;
          p2 = -0.95 + 0.26 * Math.sin(time * 0.18 + 1.1) + morph * (high - 0.25) * 0.36;
          p3 = -1.25 + 0.22 * Math.cos(time * 0.13 + 2.3) + morph * (rms - 0.25) * 0.32;
          invScale = 1 / 2.3;
        } else {
          // Peter de Jong: lacy folded sheets
          p0 = -2.24 + 0.30 * Math.sin(time * 0.13) + morph * (bass - 0.25) * 0.44;
          p1 = 0.43 + 0.32 * Math.cos(time * 0.16) + morph * (mid - 0.25) * 0.42;
          p2 = -0.65 + 0.30 * Math.sin(time * 0.11 + 1.5) + morph * (high - 0.25) * 0.38;
          p3 = -2.43 + 0.26 * Math.cos(time * 0.14 + 2.1) + morph * (rms - 0.25) * 0.34;
          invScale = 1 / 2.25;
        }

        const dt = 0.0048 * speed * (1.0 + kick * 0.45 + rms * 0.35);
        simData.set([count, kind, speed, morph], 0);
        simData.set([time, bass, mid, high], 4);
        simData.set([rms, kick, tick % 65536, dt], 8);
        simData.set([p0, p1, p2, p3], 12);
        device.queue.writeBuffer(simBuf, 0, simData);

        const groups = Math.ceil(count / 256);
        const cpass = enc.beginComputePass();
        if (seededType !== kind || seededCount < count) {
          cpass.setPipeline(seedPipe);
          cpass.setBindGroup(0, csBind);
          cpass.dispatchWorkgroups(groups);
          seededType = kind;
          seededCount = count;
        } else {
          cpass.setPipeline(stepPipe);
          cpass.setBindGroup(0, csBind);
          cpass.dispatchWorkgroups(groups);
        }
        cpass.end();

        // Beat-synced 3D orbital camera rotation
        const bpm = audio.bpm > 0 ? audio.bpm : 120;
        const beats = time * (bpm / 60);
        const bIdx = Math.floor(beats);
        const bFrac = beats - bIdx;
        // Crisp elastic step on each beat downbeat
        const eased = bFrac < 0.36 ? (1 - Math.cos((bFrac / 0.36) * Math.PI)) * 0.5 : 1.0;
        const beatStep = bIdx + eased;

        const yaw = beatStep * 0.46 * spin + time * 0.14;
        const pitch = 0.25 + Math.sin(time * 0.27) * 0.34 + Math.sin(beatStep * 0.5) * 0.16 * spin;
        const roll = Math.cos(beatStep * 0.25) * 0.22 * spin;
        const camDist = kind === 0 ? 2.65 - kick * 0.18 : 2.85 - kick * 0.16;

        const cp = Math.cos(pitch);
        const eye = [Math.sin(yaw) * cp * camDist, Math.sin(pitch) * camDist, Math.cos(yaw) * cp * camDist];
        const up = [Math.sin(roll), Math.cos(roll), 0];
        const vp = mul4(perspective(0.82, width / height, 0.05, 20), lookAt(eye, [0, 0, 0], up));

        // Normalize additive brightness by particle count so 16K..128K stay well exposed without blowing out
        const countNorm = 65536 / count;
        const splatAlpha = gain * countNorm * (0.026 + rms * 0.022 + kick * 0.015);
        const pxSize = (Math.max(1.5, Math.min(width, height) * 0.0032)) * size * (1.0 + kick * 0.22);

        drawData.set(vp, 0);
        drawData.set([width, height, pxSize, splatAlpha], 16);
        drawData.set([centerX, centerY, centerZ, invScale], 20);
        drawData.set([time, rms, kick, kind], 24);
        drawData.set([bass, mid, high, audio.phase], 28);
        samplePalette8(ins.palette as Palette | undefined, audio.pal, drawData, 32);
        device.queue.writeBuffer(drawBuf, 0, drawData);

        const rp = enc.beginRenderPass({
          colorAttachments: [{
            view: out.out.createView(),
            loadOp: 'clear',
            storeOp: 'store',
            clearValue: [0, 0, 0, 1],
          }],
        });
        rp.setPipeline(bgPipe);
        rp.setBindGroup(0, bgBind);
        rp.draw(3);

        rp.setPipeline(splatPipe);
        rp.setBindGroup(0, splatBind);
        rp.draw(6, count);
        rp.end();
      },
      dispose() {
        simBuf.destroy();
        drawBuf.destroy();
        ptsBuf.destroy();
      },
    };
  },
});
