import { definePiece, oklabToLinear, oklch, type Palette } from '../../../api/index.ts';

const SAMPLES = 256;
const MAIN_SEGS = SAMPLES - 1;       // 255 stereo Lissajous segments
const ECHO_SEGS = 127;               // 127 phase-shifted harmonic Lissajous segments
const SCOPE_SEGS = 127;              // 127 dual-trace time-domain segments
const MAX_SEGS = MAIN_SEGS + ECHO_SEGS + SCOPE_SEGS;
const SEG_FLOATS = 8;                // p0.xy, p1.xy, col.rgb, intensity

function samplePal(stops: [number, number, number][], x: number): [number, number, number] {
  const n = stops.length;
  if (n <= 1) return oklabToLinear(stops[0] ?? [0.75, -0.1, 0.08]).map((c) => Math.max(0, c)) as [number, number, number];
  const f = Math.min(1, Math.max(0, x)) * (n - 1);
  const i = Math.min(Math.floor(f), n - 1);
  const j = Math.min(i + 1, n - 1);
  const t = f - i;
  const a = stops[i], b = stops[j];
  const rgb = oklabToLinear([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]);
  return [Math.max(0, rgb[0]), Math.max(0, rgb[1]), Math.max(0, rgb[2])];
}

export default definePiece({
  gpu: ({ device, shader }) => {
    const mod = shader('lissajous.wgsl');
    const ubuf = device.createBuffer({ label: 'agy-lissajous u', size: 64, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const sbuf = device.createBuffer({ label: 'agy-lissajous segs', size: MAX_SEGS * SEG_FLOATS * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });

    const bgPipe = device.createRenderPipeline({
      label: 'agy-lissajous bg', layout: 'auto',
      vertex: { module: mod, entryPoint: 'vs_full' },
      fragment: { module: mod, entryPoint: 'fs_bg', targets: [{ format: 'rgba16float' }] },
    });
    const segPipe = device.createRenderPipeline({
      label: 'agy-lissajous seg', layout: 'auto',
      vertex: { module: mod, entryPoint: 'vs_seg' },
      fragment: {
        module: mod, entryPoint: 'fs_seg',
        targets: [{
          format: 'rgba16float',
          blend: {
            color: { srcFactor: 'one', dstFactor: 'one' },
            alpha: { srcFactor: 'one', dstFactor: 'one' },
          },
        }],
      },
    });

    const bgGroup = device.createBindGroup({ layout: bgPipe.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: ubuf } }] });
    const segGroup = device.createBindGroup({
      layout: segPipe.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: ubuf } },
        { binding: 1, resource: { buffer: sbuf } },
      ],
    });

    const udata = new Float32Array(16);
    const sdata = new Float32Array(MAX_SEGS * SEG_FLOATS);
    const lx = new Float32Array(SAMPLES);
    const ly = new Float32Array(SAMPLES);

    return {
      frame({ enc, out, in: ins, params, audio, time, past, wave, width, height }) {
        const aspect = width / height;
        const gain = params.gain as number;
        const beamW = params.width as number;
        const glow = params.glow as number;
        const twist = params.twist as number;
        const scopeMix = params.scope_mix as number;
        const grid = params.grid as number;

        let kick = 0;
        for (let ago = 0; ago < 20; ago++) if (past(ago).onset) kick = Math.max(kick, Math.exp(-ago / 5.5));

        const stops = (ins.palette as Palette | undefined)?.stops
          ?? Array.from({ length: 6 }, (_, i) => oklch(0.75, 0.17, 0.42 + audio.pal + i * 0.08));
        const gridCol = samplePal(stops, 0.25);

        const w = (ins.wave as Float32Array | null | undefined) ?? wave();
        const mid = (audio.bands[4] + audio.bands[5] + audio.bands[6] + audio.bands[7]) * 0.25;
        const hi = (audio.bands[11] + audio.bands[12] + audio.bands[13] + audio.bands[14]) * 0.25;

        // Smooth rotation angle locked to time & beat phase
        const ang = time * (0.28 + 0.42 * twist) + Math.sin(audio.phase * Math.PI * 2) * 0.14 * twist;
        const ca = Math.cos(ang), sa = Math.sin(ang);

        // Compute normalized L/R points in [-1..1] virtual square coordinates (aspect applied in shader)
        let peak = 0;
        if (w && w.length >= SAMPLES * 4) {
          for (let i = 0; i < SAMPLES; i++) {
            const wi = i * 4;
            const a = Math.abs(w[wi]), b = Math.abs(w[wi + 1]);
            if (a > peak) peak = a;
            if (b > peak) peak = b;
          }
        }
        // Soft auto-leveling only when signal is present (keeps silence quiet!)
        const active = peak > 0.002 ? 1 : 0;
        const norm = active ? Math.min(2.6, 0.65 / Math.max(peak, 0.16)) : 0;
        const scale = gain * norm * (0.58 + 0.14 * kick);

        for (let i = 0; i < SAMPLES; i++) {
          const wi = i * 4;
          const rawL = w && w.length >= SAMPLES * 4 ? w[wi] : 0;
          const rawR = w && w.length >= SAMPLES * 4 ? w[wi + 1] : 0;
          // Add gentle harmonic Lissajous modulation proportional to audio energy
          const t = (i / SAMPLES) * Math.PI * 2;
          const hAmp = active ? (0.07 + 0.14 * mid) * gain * Math.min(1, peak * 3.5) : 0;
          const x = rawL * scale + Math.sin(t * 2 + time * 1.3) * hAmp;
          const y = rawR * scale + Math.cos(t * 3 - time * 0.9) * hAmp;
          lx[i] = x * ca - y * sa;
          ly[i] = x * sa + y * ca;
        }

        let segCount = 0;
        const pushSeg = (x0: number, y0: number, x1: number, y1: number, r: number, g: number, b: number, inten: number) => {
          if (segCount >= MAX_SEGS) return;
          const o = segCount * SEG_FLOATS;
          sdata[o] = x0; sdata[o + 1] = y0; sdata[o + 2] = x1; sdata[o + 3] = y1;
          sdata[o + 4] = r; sdata[o + 5] = g; sdata[o + 6] = b; sdata[o + 7] = inten;
          segCount++;
        };

        // 1. Primary stereo Lissajous trace with velocity-weighted phosphor brightness
        const baseI = glow * (0.62 + 0.55 * audio.rms + 0.4 * kick);
        for (let i = 0; i < MAIN_SEGS; i++) {
          const x0 = lx[i], y0 = ly[i], x1 = lx[i + 1], y1 = ly[i + 1];
          const d = Math.hypot(x1 - x0, y1 - y0);
          // Analog CRT physics: slower beam deposits brighter phosphor, cusps glow hot
          const vel = 1.0 / (0.18 + d * 8.0);
          const u = (i / MAIN_SEGS + time * 0.06 + hi * 0.2) % 1;
          const [r, g, b] = samplePal(stops, u);
          const inten = active ? Math.min(3.2, baseI * vel * 0.52) : 0.12;
          pushSeg(x0, y0, x1, y1, r, g, b, inten);
        }

        // 2. Phase-shifted harmonic orbital echo Lissajous
        const shift = Math.floor(16 + 24 * Math.sin(time * 0.45 * (0.5 + twist)) + 24);
        const echoScale = 1.16 + 0.08 * kick;
        const echoI = glow * (0.32 + 0.38 * mid + 0.3 * kick) * (0.4 + 0.6 * Math.min(1, twist));
        for (let k = 0; k < ECHO_SEGS; k++) {
          const i0 = k * 2, i1 = i0 + 2;
          const j0 = (i0 + shift) & 255, j1 = (i1 + shift) & 255;
          const x0 = lx[i0] * echoScale, y0 = ly[j0] * echoScale;
          const x1 = lx[i1] * echoScale, y1 = ly[j1] * echoScale;
          const d = Math.hypot(x1 - x0, y1 - y0);
          const vel = 1.0 / (0.22 + d * 7.0);
          const u = (0.55 + k / ECHO_SEGS * 0.45 + time * 0.04) % 1;
          const [r, g, b] = samplePal(stops, u);
          const inten = active ? Math.min(2.2, echoI * vel * 0.42) : 0.0;
          pushSeg(x0, y0, x1, y1, r, g, b, inten);
        }

        // 3. Time-domain horizontal oscilloscope ribbon across screen width
        if (scopeMix > 0.01 && active) {
          const halfW = aspect * 0.9;
          const ampY = 0.24 * gain * norm;
          const scI = glow * scopeMix * (0.45 + 0.5 * audio.rms);
          for (let k = 0; k < SCOPE_SEGS; k++) {
            const wi0 = k * 8, wi1 = (k + 1) * 8;
            const u0 = k / SCOPE_SEGS, u1 = (k + 1) / SCOPE_SEGS;
            const x0 = (u0 * 2 - 1) * halfW, x1 = (u1 * 2 - 1) * halfW;
            const w0 = w && wi0 + 1 < w.length ? (w[wi0] - w[wi0 + 1]) * 0.5 : 0;
            const w1 = w && wi1 + 1 < w.length ? (w[wi1] - w[wi1 + 1]) * 0.5 : 0;
            // Edge envelope so scope tapers neatly into the sides
            const e0 = Math.sin(u0 * Math.PI), e1 = Math.sin(u1 * Math.PI);
            const y0 = w0 * ampY * (0.35 + 0.65 * e0);
            const y1 = w1 * ampY * (0.35 + 0.65 * e1);
            const [r, g, b] = samplePal(stops, (u0 * 0.8 + 0.15) % 1);
            pushSeg(x0, y0, x1, y1, r, g, b, scI * 0.55);
          }
        }

        udata.set([
          width, height, aspect, time,
          audio.rms, kick, beamW, glow,
          grid, audio.phase, active, 0,
          gridCol[0], gridCol[1], gridCol[2], 1,
        ], 0);
        device.queue.writeBuffer(ubuf, 0, udata);
        if (segCount > 0) device.queue.writeBuffer(sbuf, 0, sdata.subarray(0, segCount * SEG_FLOATS));

        const rp = enc.beginRenderPass({
          colorAttachments: [{ view: out.out.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }],
        });
        rp.setPipeline(bgPipe);
        rp.setBindGroup(0, bgGroup);
        rp.draw(3);
        if (segCount > 0) {
          rp.setPipeline(segPipe);
          rp.setBindGroup(0, segGroup);
          rp.draw(6, segCount);
        }
        rp.end();
      },
      dispose: () => { ubuf.destroy(); sbuf.destroy(); },
    };
  },
});
