import { definePiece, oklabToLinear, oklch, type Palette } from '../../../api/index.ts';

const MAX_ROWS = 64;
const BANDS = 16;
const SEGMENTS = 128;
const VERTS_PER_ROW = SEGMENTS * 6;
// Uniform layout: 4 vec4s header + 8 vec4s palette = 12 vec4s = 192 bytes
const UBYTES = 12 * 16;
// Per-row metadata: vec4f(depth, rowIndex, onsetPulse, ridgeEnergy)
const ROW_META_BYTES = MAX_ROWS * 16;
// Per-row spectrum heights: MAX_ROWS * 16 floats (stored as vec4f[MAX_ROWS * 4])
const ROW_DATA_BYTES = MAX_ROWS * BANDS * 4;

const PREMUL_BLEND: GPUBlendState = {
  color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
  alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
};

function samplePalette8(pal: Palette | undefined, fallbackHue: number, out: Float32Array, offset: number): void {
  const stops = pal?.stops?.length
    ? pal.stops
    : Array.from({ length: 6 }, (_, i) => oklch(0.72, 0.14, fallbackHue + i * 0.12));
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

export default definePiece({
  gpu: ({ device, shader }) => {
    const mod = shader('ridgeline.wgsl');
    const ubuf = device.createBuffer({ label: 'ridgeline-u', size: UBYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const metaBuf = device.createBuffer({ label: 'ridgeline-meta', size: ROW_META_BYTES, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    const specBuf = device.createBuffer({ label: 'ridgeline-spec', size: ROW_DATA_BYTES, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });

    const bgPipe = device.createRenderPipeline({
      label: 'ridgeline-bg',
      layout: 'auto',
      vertex: { module: mod, entryPoint: 'vs_full' },
      fragment: { module: mod, entryPoint: 'fs_bg', targets: [{ format: 'rgba16float' }] },
    });

    const ridgePipe = device.createRenderPipeline({
      label: 'ridgeline-rows',
      layout: 'auto',
      vertex: { module: mod, entryPoint: 'vs_ridge' },
      fragment: {
        module: mod,
        entryPoint: 'fs_ridge',
        targets: [{ format: 'rgba16float', blend: PREMUL_BLEND }],
      },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
    });

    const bgBind = device.createBindGroup({
      layout: bgPipe.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: ubuf } }],
    });

    const ridgeBind = device.createBindGroup({
      layout: ridgePipe.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: ubuf } },
        { binding: 1, resource: { buffer: metaBuf } },
        { binding: 2, resource: { buffer: specBuf } },
      ],
    });

    const udata = new Float32Array(UBYTES / 4);
    const meta = new Float32Array(MAX_ROWS * 4);
    const spec = new Float32Array(MAX_ROWS * BANDS);

    return {
      frame({ enc, out, in: ins, params, audio, tick, sub, time, past, width, height }) {
        const rows = Math.max(16, Math.min(MAX_ROWS, Math.round(params.rows as number)));
        const speed = Math.max(0.1, params.speed as number);
        const amp = params.height as number;
        const persp = params.perspective as number;
        const glow = params.glow as number;
        const thickness = params.thickness as number;
        const fill = params.fill as number;

        // Ticks between successive historical ridge snapshots
        const interval = Math.max(1.5, 6.5 / speed);
        const contTick = tick + sub / 256;
        const slotIndex = Math.floor(contTick / interval);
        const frac = contTick / interval - slotIndex;

        // Compute recent onset glow pulse
        let kick = 0;
        for (let a = 0; a < 18; a++) {
          if (past(a).onset) kick = Math.max(kick, Math.exp(-a / 5));
        }

        // Fill rows in back-to-front painter's order: instance 0 = farthest back (oldest), instance rows-1 = closest (newest)
        for (let inst = 0; inst < rows; inst++) {
          const k = rows - 1 - inst; // k = 0 is newest/front, k = rows - 1 is oldest/back
          const ridgeId = slotIndex - k;
          const depth = (k + frac) / rows; // 0 = front, 1 = far horizon
          const agoExact = (k + frac) * interval;
          const ago0 = Math.max(0, Math.min(599, Math.floor(agoExact)));
          const ago1 = Math.max(0, Math.min(599, ago0 + 1));
          const ago2 = Math.max(0, Math.min(599, ago0 + 2));

          const f0 = past(ago0);
          const f1 = past(ago1);
          const f2 = past(ago2);

          // Check if an onset occurred near this historical slice
          const onsetHit = (f0.onset || f1.onset) ? 1.0 : 0.0;
          const energy = (f0.rms + f1.rms) * 0.5;

          meta[inst * 4 + 0] = depth;
          meta[inst * 4 + 1] = ((ridgeId % 4096) + 4096) % 4096;
          meta[inst * 4 + 2] = onsetHit;
          meta[inst * 4 + 3] = energy;

          // Temporal smoothing over 3 neighboring ticks + subtle harmonic symmetry across bands
          const base = inst * BANDS;
          for (let b = 0; b < BANDS; b++) {
            const v = f0.bands[b] * 0.5 + f1.bands[b] * 0.35 + f2.bands[b] * 0.15;
            // Emphasize peaks slightly for iconic silhouette contrast
            spec[base + b] = Math.pow(Math.max(0, v), 1.15);
          }
        }

        const bass = (audio.bands[0] + audio.bands[1] + audio.bands[2]) / 3;
        udata.set([width, height, time, rows], 0);
        udata.set([amp, persp, glow, thickness], 4);
        udata.set([fill, audio.rms, bass, kick], 8);
        udata.set([audio.phase, audio.bar, SEGMENTS, 0], 12);
        samplePalette8(ins.palette as Palette | undefined, audio.pal, udata, 16);

        device.queue.writeBuffer(ubuf, 0, udata);
        device.queue.writeBuffer(metaBuf, 0, meta, 0, rows * 4);
        device.queue.writeBuffer(specBuf, 0, spec, 0, rows * BANDS);

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

        rp.setPipeline(ridgePipe);
        rp.setBindGroup(0, ridgeBind);
        rp.draw(VERTS_PER_ROW, rows);
        rp.end();
      },
      dispose() {
        ubuf.destroy();
        metaBuf.destroy();
        specBuf.destroy();
      },
    };
  },
});
