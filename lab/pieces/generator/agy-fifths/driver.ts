import { definePiece, oklabToLinear, oklch, type Audio, type Palette } from '../../../api/index.ts';

const BANDS = 16;
const TAU = Math.PI * 2;
// Krumhansl-Schmuckler major key profile (C=0 .. B=11), normalized
const MAJOR_PROFILE = [
  6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88,
];
const PROFILE_MEAN = MAJOR_PROFILE.reduce((a, b) => a + b, 0) / 12;

// Uniform layout:
// 4 vec4f header + 3 vec4f fifthsChroma (12 floats) + 3 vec4f keyScores (12 floats)
// + 12 vec4f wedgeColors + 1 vec4f keyColor = 23 vec4f = 368 bytes
const UBYTES = 23 * 16;

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/** Precomputed projection weights from 16 log bands to 12 pitch classes (C=0..B=11). */
const BAND_TO_PC: Float32Array[] = [];
for (let b = 0; b < BANDS; b++) {
  const row = new Float32Array(12);
  // 16 log bands span ~5 octaves (~3.75 semitones per band)
  const centerSemi = b * 3.75;
  let sum = 0;
  for (let pc = 0; pc < 12; pc++) {
    // Circular distance in semitones
    let d = ((pc - (centerSemi % 12)) + 18) % 12 - 6;
    const wMain = Math.exp(-0.5 * (d / 1.35) ** 2);
    // Slight 5th harmonic contribution for richer musical chroma
    let d5 = ((pc - ((centerSemi + 7) % 12)) + 18) % 12 - 6;
    const w5 = 0.22 * Math.exp(-0.5 * (d5 / 1.1) ** 2);
    row[pc] = wMain + w5;
    sum += row[pc];
  }
  if (sum > 0) {
    for (let pc = 0; pc < 12; pc++) row[pc] /= sum;
  }
  BAND_TO_PC.push(row);
}

/** Extract 12 pitch-class chroma (C=0..B=11) from an Audio frame. */
function extractChroma(a: Audio, out: Float32Array): void {
  out.fill(0);
  let meanBand = 0;
  for (let b = 0; b < BANDS; b++) meanBand += a.bands[b];
  meanBand /= BANDS;

  for (let b = 0; b < BANDS; b++) {
    const v = a.bands[b];
    // Local contrast enhancement so pitch classes stand out clearly
    const contrast = Math.max(0, v - meanBand * 0.42);
    const weight = v * 0.42 + contrast * 1.45;
    const proj = BAND_TO_PC[b];
    for (let pc = 0; pc < 12; pc++) {
      out[pc] += weight * proj[pc];
    }
  }

  // Incorporate live MIDI note-on directly into its exact pitch class
  if (a.note >= 0 && a.vel > 0) {
    const pc = ((a.note % 12) + 12) % 12;
    out[pc] += a.vel * 1.6;
  }
}

function samplePaletteLinear(pal: Palette | undefined, x: number): [number, number, number] | null {
  if (!pal?.stops?.length) return null;
  const stops = pal.stops;
  const n = stops.length;
  const t = clamp01(x) * (n - 1);
  const a = Math.min(n - 1, Math.floor(t));
  const b = Math.min(n - 1, a + 1);
  const f = t - a;
  const lab: [number, number, number] = [
    stops[a][0] + (stops[b][0] - stops[a][0]) * f,
    stops[a][1] + (stops[b][1] - stops[a][1]) * f,
    stops[a][2] + (stops[b][2] - stops[a][2]) * f,
  ];
  const rgb = oklabToLinear(lab);
  return [Math.max(0, rgb[0]), Math.max(0, rgb[1]), Math.max(0, rgb[2])];
}

function wrapAngle(a: number): number {
  let r = (a + Math.PI) % TAU;
  if (r < 0) r += TAU;
  return r - Math.PI;
}

export default definePiece({
  gpu: ({ device, shader }) => {
    const mod = shader('fifths.wgsl');
    const ubuf = device.createBuffer({
      label: 'fifths-u',
      size: UBYTES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    const pipe = device.createRenderPipeline({
      label: 'fifths-render',
      layout: 'auto',
      vertex: { module: mod, entryPoint: 'vs_full' },
      fragment: { module: mod, entryPoint: 'fs_main', targets: [{ format: 'rgba16float' }] },
    });

    const bind = device.createBindGroup({
      layout: pipe.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: ubuf } }],
    });

    const udata = new Float32Array(UBYTES / 4);
    const tmpChroma = new Float32Array(12);
    const curChroma = new Float32Array(12);
    const avgChroma = new Float32Array(12);
    const smoothFifths = new Float32Array(12);
    const fifthsScores = new Float32Array(12);

    let wheelAngle = 0;
    let lastTick = -1;

    return {
      frame({ enc, out, in: ins, params, audio, tick, time, past, width, height }) {
        const gain = params.gain as number;
        const rotSpeed = params.rot_speed as number;
        const web = params.web as number;
        const pulse = params.pulse as number;
        const glow = params.glow as number;
        const labels = params.labels ? 1.0 : 0.0;
        const keyHueMix = params.key_hue as number;

        // Current frame chroma
        extractChroma(audio, curChroma);

        // Short-window average chroma over ~48 ticks for stable musical key estimation
        avgChroma.fill(0);
        const taps = 12;
        for (let i = 0; i < taps; i++) {
          const ago = i * 4;
          const a = ago === 0 ? audio : past(ago);
          extractChroma(a, tmpChroma);
          const decay = Math.exp(-i * 0.14);
          for (let pc = 0; pc < 12; pc++) {
            avgChroma[pc] += tmpChroma[pc] * decay;
          }
        }

        // Convert current chroma into circle-of-fifths order (k = 0..11 => pc = (k*7)%12)
        // Smooth attack / release for silky wedge glow
        const reset = lastTick < 0 || tick < lastTick || tick - lastTick > 40;
        for (let k = 0; k < 12; k++) {
          const pc = (k * 7) % 12;
          const target = clamp01(curChroma[pc] * gain * 1.15);
          if (reset) {
            smoothFifths[k] = target;
          } else if (tick > lastTick) {
            smoothFifths[k] = target > smoothFifths[k]
              ? smoothFifths[k] + (target - smoothFifths[k]) * 0.65
              : smoothFifths[k] * 0.86;
          }
        }

        // Krumhansl-Schmuckler key correlation across all 12 major keys (in fifths order)
        let avgMean = 0;
        for (let pc = 0; pc < 12; pc++) avgMean += avgChroma[pc];
        avgMean /= 12;

        let bestK = 0;
        let bestScore = -1e9;
        let minScore = 1e9;
        for (let k = 0; k < 12; k++) {
          const tonicPc = (k * 7) % 12;
          let num = 0;
          let denA = 0;
          let denB = 0;
          for (let pc = 0; pc < 12; pc++) {
            const da = avgChroma[(tonicPc + pc) % 12] - avgMean;
            const db = MAJOR_PROFILE[pc] - PROFILE_MEAN;
            num += da * db;
            denA += da * da;
            denB += db * db;
          }
          const corr = denA > 1e-6 ? num / Math.sqrt(denA * denB) : 0;
          fifthsScores[k] = corr;
          if (corr > bestScore) {
            bestScore = corr;
            bestK = k;
          }
          if (corr < minScore) minScore = corr;
        }

        // Normalize key scores 0..1
        const span = Math.max(0.05, bestScore - minScore);
        for (let k = 0; k < 12; k++) {
          fifthsScores[k] = clamp01((fifthsScores[k] - minScore) / span);
        }

        // Rotate wheel so estimated key rises smoothly to 12 o'clock
        const targetAngle = -bestK * (TAU / 12);
        if (reset) {
          wheelAngle = targetAngle;
        } else if (tick > lastTick) {
          const diff = wrapAngle(targetAngle - wheelAngle);
          const step = Math.min(1.0, (tick - lastTick) * rotSpeed);
          wheelAngle = wrapAngle(wheelAngle + diff * step);
        }
        lastTick = tick;

        // Onset kick envelope
        let kick = 0;
        for (let a = 0; a < 16; a++) {
          if (past(a).onset) kick = Math.max(kick, Math.exp(-a / 4.8));
        }

        const bass = (audio.bands[0] + audio.bands[1] + audio.bands[2]) / 3;
        const palIn = ins.palette as Palette | undefined;

        // Key-to-hue mapping: estimated wheel angle maps directly to OKLCh hue (turns)
        const keyHue = (((-wheelAngle) / TAU) % 1 + 1 + audio.pal) % 1;
        const keyRgbRaw = oklabToLinear(oklch(0.76, 0.21, keyHue));
        const keyRgb: [number, number, number] = [
          Math.max(0, keyRgbRaw[0]),
          Math.max(0, keyRgbRaw[1]),
          Math.max(0, keyRgbRaw[2]),
        ];

        // Header vec4s
        udata.set([width, height, time, wheelAngle], 0);
        udata.set([bestK, keyHue, web, pulse], 4);
        udata.set([glow, labels, audio.rms, bass], 8);
        udata.set([kick, audio.phase, audio.bar, clamp01(bestScore)], 12);

        // 12 fifths chroma activations (3 vec4f at offset 16..27)
        for (let k = 0; k < 12; k++) {
          udata[16 + k] = smoothFifths[k];
        }
        // 12 normalized key scores (3 vec4f at offset 28..39)
        for (let k = 0; k < 12; k++) {
          udata[28 + k] = fifthsScores[k];
        }
        // 12 wedge colors (12 vec4f at offset 40..87): key-to-hue OKLCh blended with optional palette
        for (let k = 0; k < 12; k++) {
          const h = (k / 12 + audio.pal) % 1;
          const okRgb = oklabToLinear(oklch(0.72, 0.22, h));
          const palRgb = samplePaletteLinear(palIn, k / 11);
          const m = palRgb ? keyHueMix : 1.0;
          const r = palRgb ? palRgb[0] * (1 - m) + Math.max(0, okRgb[0]) * m : Math.max(0, okRgb[0]);
          const g = palRgb ? palRgb[1] * (1 - m) + Math.max(0, okRgb[1]) * m : Math.max(0, okRgb[1]);
          const b = palRgb ? palRgb[2] * (1 - m) + Math.max(0, okRgb[2]) * m : Math.max(0, okRgb[2]);
          udata[40 + k * 4 + 0] = r;
          udata[40 + k * 4 + 1] = g;
          udata[40 + k * 4 + 2] = b;
          udata[40 + k * 4 + 3] = 1;
        }
        // Key color (1 vec4f at offset 88..91)
        const palKey = samplePaletteLinear(palIn, keyHue);
        const km = palKey ? keyHueMix : 1.0;
        udata[88] = palKey ? palKey[0] * (1 - km) + keyRgb[0] * km : keyRgb[0];
        udata[89] = palKey ? palKey[1] * (1 - km) + keyRgb[1] * km : keyRgb[1];
        udata[90] = palKey ? palKey[2] * (1 - km) + keyRgb[2] * km : keyRgb[2];
        udata[91] = 1;

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
      },
    };
  },
});
