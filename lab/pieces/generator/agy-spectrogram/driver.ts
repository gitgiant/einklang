import { definePiece, oklabToLinear, oklch, type Audio, type Palette } from '../../../api/index.ts';

const HIST_W = 512;
const HIST_H = 128;
const BANDS = 16;
// Uniform layout: 5 vec4s header + 8 vec4s palette = 13 vec4s = 208 bytes
const UBYTES = 13 * 16;

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

function catmullRom(bands: Float32Array, pos: number): number {
  const i1 = Math.floor(pos);
  const f = pos - i1;
  const b0 = bands[Math.max(0, Math.min(BANDS - 1, i1 - 1))];
  const b1 = bands[Math.max(0, Math.min(BANDS - 1, i1))];
  const b2 = bands[Math.max(0, Math.min(BANDS - 1, i1 + 1))];
  const b3 = bands[Math.max(0, Math.min(BANDS - 1, i1 + 2))];
  const f2 = f * f;
  const f3 = f2 * f;
  const v = 0.5 * (
    2 * b1 +
    (-b0 + b2) * f +
    (2 * b0 - 5 * b1 + 4 * b2 - b3) * f2 +
    (-b0 + 3 * b1 - 3 * b2 + b3) * f3
  );
  return v > 0 ? v : 0;
}

function writeColumnData(
  cur: Audio,
  prev: Audio,
  out: Uint8Array,
  colOffset: number,
  rowStride: number,
  onsetBoost: number,
): void {
  const curBands = cur.bands;
  const prevBands = prev.bands;
  const onsetByte = Math.round(clamp01(onsetBoost) * 255);
  const rmsByte = Math.round(clamp01(cur.rms) * 255);

  for (let y = 0; y < HIST_H; y++) {
    const f = y / (HIST_H - 1);
    const pos = f * (BANDS - 1);
    const mag = catmullRom(curBands, pos);
    const prevMag = catmullRom(prevBands, pos);
    const flux = Math.max(0, mag - prevMag);

    // Subtle fine harmonic striation scaled strictly by live energy so silence stays clean
    const ripple = 0.94 + 0.06 * Math.sin(y * 1.15 + cur.phase * 6.2831853);
    const magPacked = Math.round(clamp01(mag * ripple * 0.85) * 255);
    const fluxPacked = Math.round(clamp01(flux * 2.5) * 255);

    const idx = y * rowStride + colOffset;
    out[idx + 0] = magPacked;
    out[idx + 1] = onsetByte;
    out[idx + 2] = rmsByte;
    out[idx + 3] = fluxPacked;
  }
}

function samplePalette8(pal: Palette | undefined, fallbackHue: number, out: Float32Array, offset: number): void {
  const stops = pal?.stops?.length
    ? pal.stops
    : [
        oklch(0.18, 0.08, fallbackHue + 0.65),
        oklch(0.36, 0.14, fallbackHue + 0.52),
        oklch(0.55, 0.17, fallbackHue + 0.35),
        oklch(0.72, 0.17, fallbackHue + 0.16),
        oklch(0.86, 0.14, fallbackHue + 0.04),
        oklch(0.96, 0.06, fallbackHue - 0.02),
      ];
  const n = stops.length;
  for (let i = 0; i < 8; i++) {
    const t = (i / 7) * (n - 1);
    const a = Math.min(n - 1, Math.floor(t));
    const b = Math.min(n - 1, a + 1);
    const frac = t - a;
    const lab: [number, number, number] = [
      stops[a][0] + (stops[b][0] - stops[a][0]) * frac,
      stops[a][1] + (stops[b][1] - stops[a][1]) * frac,
      stops[a][2] + (stops[b][2] - stops[a][2]) * frac,
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
    const mod = shader('spectrogram.wgsl');
    const ubuf = device.createBuffer({
      label: 'spectrogram-u',
      size: UBYTES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    const histTex = device.createTexture({
      label: 'spectrogram-ring',
      size: { width: HIST_W, height: HIST_H },
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });

    const sampler = device.createSampler({
      label: 'spectrogram-sampler',
      magFilter: 'linear',
      minFilter: 'linear',
      addressModeU: 'repeat',
      addressModeV: 'clamp-to-edge',
    });

    const pipe = device.createRenderPipeline({
      label: 'spectrogram-render',
      layout: 'auto',
      vertex: { module: mod, entryPoint: 'vs_full' },
      fragment: { module: mod, entryPoint: 'fs_main', targets: [{ format: 'rgba16float' }] },
    });

    const bind = device.createBindGroup({
      layout: pipe.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: ubuf } },
        { binding: 1, resource: histTex.createView() },
        { binding: 2, resource: sampler },
      ],
    });

    const udata = new Float32Array(UBYTES / 4);
    const colBuf = new Uint8Array(HIST_H * 4);
    const fullBuf = new Uint8Array(HIST_W * HIST_H * 4);

    let writeHead = 0;
    let colAccum = 0;
    let lastTick = -1;

    return {
      frame({ enc, out, in: ins, params, audio, tick, sub, time, past, width, height }) {
        const direction = Math.round(params.direction as number);
        const speed = Math.max(0.2, Math.min(6.0, params.speed as number));
        const freqScale = Math.round(params.freq_scale as number);
        const gain = params.gain as number;
        const gamma = params.gamma as number;
        const palMode = Math.round(params.pal_mode as number);
        const mirror = params.mirror ? 1.0 : 0.0;
        const onsetMark = params.onset_mark as number;
        const tilt = params.tilt as number;
        const glow = params.glow as number;

        if (lastTick < 0 || tick < lastTick || tick - lastTick > 40) {
          // Cold start or seek: backfill ring buffer from past(ago) once
          for (let c = 0; c < HIST_W; c++) {
            const colsAgo = HIST_W - 1 - c;
            const ago = Math.min(599, Math.floor(colsAgo / speed));
            const cur = ago === 0 ? audio : past(ago);
            const prev = past(Math.min(599, ago + 1));
            const onsetVal = cur.onset ? 1.0 : (past(Math.min(599, ago + 1)).onset ? 0.35 : 0.0);
            writeColumnData(cur, prev, fullBuf, c * 4, HIST_W * 4, onsetVal);
          }
          device.queue.writeTexture(
            { texture: histTex },
            fullBuf,
            { bytesPerRow: HIST_W * 4, rowsPerImage: HIST_H },
            { width: HIST_W, height: HIST_H },
          );
          writeHead = HIST_W - 1;
          colAccum = 0;
          lastTick = tick;
        } else if (tick > lastTick) {
          // Incremental ring-buffer write: only write the newly elapsed column(s), no full copies
          const dt = tick - lastTick;
          colAccum += dt * speed;
          const colsToWrite = Math.min(HIST_W - 3, Math.floor(colAccum));
          colAccum -= colsToWrite;

          for (let s = 0; s < colsToWrite; s++) {
            const colsFromNow = colsToWrite - 1 - s;
            const ago = Math.max(0, Math.min(599, Math.floor(colsFromNow / speed)));
            const cur = ago === 0 ? audio : past(ago);
            const prev = past(Math.min(599, ago + 1));
            const onsetVal = cur.onset ? 1.0 : 0.0;

            writeHead = (writeHead + 1) % HIST_W;
            writeColumnData(cur, prev, colBuf, 0, 4, onsetVal);
            device.queue.writeTexture(
              { texture: histTex, origin: { x: writeHead, y: 0 } },
              colBuf,
              { bytesPerRow: 4, rowsPerImage: HIST_H },
              { width: 1, height: HIST_H },
            );
          }
          lastTick = tick;
        }

        // Smooth onset kick envelope for horizon / playhead pulse
        let kick = 0;
        for (let a = 0; a < 14; a++) {
          if (past(a).onset) kick = Math.max(kick, Math.exp(-a / 4.5));
        }

        const bass = (audio.bands[0] + audio.bands[1] + audio.bands[2]) / 3;
        const headU = (writeHead + 0.5) / HIST_W;
        // Sub-column scroll interpolation for silky motion at any speed or display refresh
        const subOffsetU = ((colAccum + (sub / 256) * speed) / HIST_W) * 0.85;

        udata.set([width, height, time, headU], 0);
        udata.set([direction, freqScale, gain, gamma], 4);
        udata.set([palMode, mirror, onsetMark, tilt], 8);
        udata.set([glow, audio.rms, bass, kick], 12);
        udata.set([audio.phase, audio.bar, subOffsetU, HIST_W], 16);
        samplePalette8(ins.palette as Palette | undefined, audio.pal, udata, 20);

        device.queue.writeBuffer(ubuf, 0, udata);

        const rp = enc.beginRenderPass({
          colorAttachments: [{
            view: out.out.createView(),
            loadOp: 'clear',
            storeOp: 'store',
            clearValue: [0, 0, 0, 1],
          }],
        });
        rp.setPipeline(pipe);
        rp.setBindGroup(0, bind);
        rp.draw(3);
        rp.end();
      },
      invalidate() {
        lastTick = -1;
      },
      dispose() {
        ubuf.destroy();
        histTex.destroy();
      },
    };
  },
});
