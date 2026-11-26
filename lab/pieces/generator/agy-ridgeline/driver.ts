import { definePiece, oklabToLinear, oklch, type Palette } from '../../../api/index.ts';

const MAX_RIDGES = 48;
const COLS = 56;

function samplePal(stops: [number, number, number][], x: number): [number, number, number] {
  const n = stops.length;
  if (n <= 1) return oklabToLinear(stops[0] ?? [0.75, 0.12, 0.06]).map((c) => Math.max(0, c)) as [number, number, number];
  const f = Math.min(1, Math.max(0, x)) * (n - 1);
  const i = Math.min(Math.floor(f), n - 1);
  const j = Math.min(i + 1, n - 1);
  const t = f - i;
  const a = stops[i], b = stops[j];
  const rgb = oklabToLinear([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]);
  return [Math.max(0, rgb[0]), Math.max(0, rgb[1]), Math.max(0, rgb[2])];
}

function sampleBands(bands: Float32Array, pos: number): number {
  const f = Math.min(15, Math.max(0, pos));
  const i = Math.floor(f);
  const j = Math.min(15, i + 1);
  const t = f - i;
  // Smoothstep interpolation between adjacent log bands
  const s = t * t * (3 - 2 * t);
  return bands[i] * (1 - s) + bands[j] * s;
}

export default definePiece({
  gpu: ({ device, shader }) => {
    const mod = shader('ridgeline.wgsl');
    // Uniforms: 8 vec4f (params/audio) + 8 vec4f (palette linear rgb) = 16 vec4f = 256 bytes
    const ubuf = device.createBuffer({ label: 'agy-ridgeline u', size: 256, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const hbuf = device.createBuffer({ label: 'agy-ridgeline h', size: MAX_RIDGES * COLS * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    const mbuf = device.createBuffer({ label: 'agy-ridgeline m', size: MAX_RIDGES * 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });

    const skyPipe = device.createRenderPipeline({
      label: 'agy-ridgeline sky', layout: 'auto',
      vertex: { module: mod, entryPoint: 'vs_full' },
      fragment: { module: mod, entryPoint: 'fs_sky', targets: [{ format: 'rgba16float' }] },
    });
    const ridgePipe = device.createRenderPipeline({
      label: 'agy-ridgeline ridge', layout: 'auto',
      vertex: { module: mod, entryPoint: 'vs_ridge' },
      fragment: {
        module: mod, entryPoint: 'fs_ridge',
        targets: [{
          format: 'rgba16float',
          // Premultiplied alpha: opaque dark terrain silhouette + additive HDR crest glow above
          blend: {
            color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
            alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
          },
        }],
      },
    });

    const skyGroup = device.createBindGroup({ layout: skyPipe.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: ubuf } }] });
    const ridgeGroup = device.createBindGroup({
      layout: ridgePipe.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: ubuf } },
        { binding: 1, resource: { buffer: hbuf } },
        { binding: 2, resource: { buffer: mbuf } },
      ],
    });

    const udata = new Float32Array(64);
    const hdata = new Float32Array(MAX_RIDGES * COLS);
    const mdata = new Float32Array(MAX_RIDGES * 4);

    return {
      frame({ enc, out, in: ins, params, audio, tick, sub, time, past, width, height }) {
        const aspect = width / height;
        const numRidges = Math.min(MAX_RIDGES, Math.max(12, Math.round(params.ridges as number)));
        const peakH = params.height as number;
        const spread = params.spread as number;
        const glow = params.glow as number;
        const scroll = params.scroll as number;
        const tilt = params.tilt as number;

        const stops = (ins.palette as Palette | undefined)?.stops
          ?? Array.from({ length: 6 }, (_, i) => oklch(0.72, 0.17, 0.04 + audio.pal + i * 0.1));

        // Each ridge is anchored to a quantized birth tick so mountain waveforms physically glide into the horizon
        const step = Math.max(2, Math.round(6 / scroll));
        const tTick = tick + sub / 256;
        const headIdx = Math.floor(tTick / step);
        const frac = (tTick / step) - headIdx; // 0..1 smooth continuous glide

        let kick = 0;
        for (let ago = 0; ago < 20; ago++) if (past(ago).onset) kick = Math.max(kick, Math.exp(-ago / 6));

        // Build ridges back-to-front: r = 0 (farthest horizon) .. numRidges - 1 (closest front)
        for (let r = 0; r < numRidges; r++) {
          const stepsBack = (numRidges - 1) - r;
          const ridgeIdx = headIdx - stepsBack;
          const birthTick = ridgeIdx * step;
          const ago = Math.min(599, Math.max(0, tick - birthTick));
          const frame = past(ago);

          // Check if an onset occurred during this ridge's slice
          let onsetFlash = 0;
          for (let d = 0; d < step; d++) {
            const a = Math.min(599, Math.max(0, ago + d));
            if (past(a).onset) { onsetFlash = 1; break; }
          }

          // Smooth depth 0 (front) -> 1 (horizon)
          const depth = (stepsBack + frac) / numRidges;
          const palU = ((ridgeIdx * 0.025) % 1 + 1) % 1;
          const fadeFront = Math.min(1, depth / 0.055);
          const fadeBack = Math.min(1, (1 - depth) / 0.09);
          const fade = Math.max(0, Math.min(fadeFront, fadeBack));

          const mo = r * 4;
          mdata[mo] = depth;
          mdata[mo + 1] = onsetFlash;
          mdata[mo + 2] = palU;
          mdata[mo + 3] = fade;

          // Fill 80 horizontal elevation samples for this ridge
          const ho = r * COLS;
          const b = frame.bands;
          const rowEnergy = frame.rms;
          for (let c = 0; c < COLS; c++) {
            const u = c / (COLS - 1);
            const sx = u * 2 - 1; // -1..1
            const absX = Math.abs(sx);
            // Symmetric pulsar layout: sub-bass erupts in central mountain spine, mids & highs flank outward
            const bandPos = Math.pow(absX, 1.15) * 14.5;
            const spec = sampleBands(b, bandPos);
            // Bell + shoulder envelope (classic Unknown Pleasures silhouette)
            const bell = Math.exp(-sx * sx * 3.2);
            const edgeTaper = Math.max(0, 1 - Math.pow(absX, 4.0));
            // Subtle geological ridge ripples driven by row audio energy (0 on silence!)
            const ripple = rowEnergy > 0.004
              ? (0.5 + 0.5 * Math.sin(u * 23.0 + ridgeIdx * 1.37) * Math.cos(u * 11.0 - ridgeIdx * 0.71)) * 0.14 * rowEnergy
              : 0;
            const elev = (spec * (0.38 + 0.88 * bell) + ripple) * edgeTaper;
            hdata[ho + c] = elev;
          }
        }

        udata.set([
          width, height, aspect, time,
          audio.rms, kick, peakH, spread,
          glow, tilt, numRidges, COLS,
          audio.phase, audio.bar, 0, 0,
        ], 0);
        // Pack 8 linear RGB palette stops at float offset 16..47
        for (let i = 0; i < 8; i++) {
          const rgb = samplePal(stops, i / 7);
          udata.set([rgb[0], rgb[1], rgb[2], 1], 16 + i * 4);
        }

        device.queue.writeBuffer(ubuf, 0, udata);
        device.queue.writeBuffer(hbuf, 0, hdata.subarray(0, numRidges * COLS));
        device.queue.writeBuffer(mbuf, 0, mdata.subarray(0, numRidges * 4));

        const rp = enc.beginRenderPass({
          colorAttachments: [{ view: out.out.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }],
        });
        rp.setPipeline(skyPipe);
        rp.setBindGroup(0, skyGroup);
        rp.draw(3);
        rp.setPipeline(ridgePipe);
        rp.setBindGroup(0, ridgeGroup);
        rp.draw(6, numRidges * (COLS - 1));
        rp.end();
      },
      dispose: () => { ubuf.destroy(); hbuf.destroy(); mbuf.destroy(); },
    };
  },
});
