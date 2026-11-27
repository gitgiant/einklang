import { definePiece, oklabToLinear, oklch, type Audio, type Palette } from '../../../api/index.ts';

const NUM_KEYS = 48; // 4 octaves: C2 (MIDI 36) .. B5 (MIDI 83)
const HIST_ROWS = 256;
const BANDS = 16;
// Uniform layout:
// 4 vec4f header + 8 vec4f palette + 12 vec4f active key levels (48 floats) = 24 vec4f = 384 bytes
const UBYTES = 24 * 16;

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

function sampleBands(bands: Float32Array, pos: number): number {
  const i0 = Math.max(0, Math.min(BANDS - 1, Math.floor(pos)));
  const i1 = Math.min(BANDS - 1, i0 + 1);
  const f = pos - i0;
  return bands[i0] + (bands[i1] - bands[i0]) * f;
}

/**
 * Derive 48-key note activations from 16 log audio bands + spectral flux + MIDI note-on.
 * Returns packed RGBA bytes into `out` at rowOffset.
 */
function computeRow(
  cur: Audio,
  prev: Audio,
  prev2: Audio,
  midiHold: Float32Array,
  threshold: number,
  gain: number,
  out: Uint8Array,
  rowOffset: number,
  activeOut?: Float32Array,
): void {
  const rms = cur.rms;
  const onsetBoost = cur.onset ? 1.0 : 0.0;

  // Decay MIDI hold envelopes and stamp new MIDI note-on if present
  for (let k = 0; k < NUM_KEYS; k++) {
    midiHold[k] *= 0.91;
  }
  if (cur.note >= 0 && cur.vel > 0) {
    const k = ((cur.note - 36) % NUM_KEYS + NUM_KEYS) % NUM_KEYS;
    midiHold[k] = Math.max(midiHold[k], Math.min(1.0, cur.vel * 1.15));
  }

  // Raw interpolated spectrum across 48 keys
  const raw = new Float32Array(NUM_KEYS);
  const flux = new Float32Array(NUM_KEYS);
  for (let k = 0; k < NUM_KEYS; k++) {
    const pos = (k / (NUM_KEYS - 1)) * (BANDS - 1);
    const v = sampleBands(cur.bands, pos);
    const vp = sampleBands(prev.bands, pos);
    const vp2 = sampleBands(prev2.bands, pos);
    // Subtle pitch-class harmonic emphasis so individual keys pop cleanly
    const pc = k % 12;
    const harmonicMod = 0.88 + 0.12 * Math.sin(pc * 1.0471975 + cur.phase * 6.2831853 + pos * 0.7);
    raw[k] = v * harmonicMod;
    flux[k] = Math.max(0, v - 0.55 * vp - 0.45 * vp2);
  }

  // Local prominence (spectral peak picking) so notes look like crisp keys, not a flat wash
  for (let k = 0; k < NUM_KEYS; k++) {
    let neigh = 0;
    let cnt = 0;
    for (let d = -3; d <= 3; d++) {
      if (d === 0) continue;
      const j = k + d;
      if (j >= 0 && j < NUM_KEYS) {
        neigh += raw[j];
        cnt++;
      }
    }
    const localAvg = cnt > 0 ? neigh / cnt : 0;
    const prominence = Math.max(0, raw[k] - localAvg * 0.62);
    const energy = (prominence * 1.45 + raw[k] * 0.45 + flux[k] * 2.2) * gain;

    // Adaptive gate: stays dark in silence, responsive on quiet tracks, punchy on dense tracks
    const effThresh = threshold * (0.65 + 0.55 * clamp01(rms * 1.8));
    const gated = energy > effThresh ? clamp01((energy - effThresh) / Math.max(0.18, 1.0 - effThresh)) : 0;

    // Combine audio-derived note with live MIDI note
    const midiVal = midiHold[k];
    const noteBody = Math.max(gated, midiVal);
    const attack = clamp01(
      (flux[k] * 3.2 + (gated > 0.25 ? onsetBoost * 0.75 : 0)) * gain + (cur.note >= 0 && ((cur.note - 36) % NUM_KEYS + NUM_KEYS) % NUM_KEYS === k ? cur.vel : 0),
    );
    const aura = clamp01(raw[k] * gain * 0.75);

    const idx = rowOffset + k * 4;
    out[idx + 0] = Math.round(noteBody * 255);
    out[idx + 1] = Math.round(attack * 255);
    out[idx + 2] = Math.round(aura * 255);
    out[idx + 3] = Math.round(clamp01(midiVal) * 255);

    if (activeOut) {
      activeOut[k] = noteBody;
    }
  }
}

function samplePalette8(pal: Palette | undefined, fallbackHue: number, out: Float32Array, offset: number): void {
  const stops = pal?.stops?.length
    ? pal.stops
    : [
        oklch(0.62, 0.22, fallbackHue + 0.0),
        oklch(0.68, 0.22, fallbackHue + 0.14),
        oklch(0.74, 0.20, fallbackHue + 0.28),
        oklch(0.76, 0.20, fallbackHue + 0.44),
        oklch(0.72, 0.22, fallbackHue + 0.60),
        oklch(0.68, 0.23, fallbackHue + 0.76),
        oklch(0.75, 0.20, fallbackHue + 0.90),
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
    const mod = shader('pianoroll.wgsl');
    const ubuf = device.createBuffer({
      label: 'pianoroll-u',
      size: UBYTES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    // Ring buffer: width = 48 keys, height = 256 time rows
    const rollTex = device.createTexture({
      label: 'pianoroll-ring',
      size: { width: NUM_KEYS, height: HIST_ROWS },
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });

    const sampler = device.createSampler({
      label: 'pianoroll-sampler',
      magFilter: 'linear',
      minFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'repeat',
    });

    const pipe = device.createRenderPipeline({
      label: 'pianoroll-render',
      layout: 'auto',
      vertex: { module: mod, entryPoint: 'vs_full' },
      fragment: { module: mod, entryPoint: 'fs_main', targets: [{ format: 'rgba16float' }] },
    });

    const bind = device.createBindGroup({
      layout: pipe.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: ubuf } },
        { binding: 1, resource: rollTex.createView() },
        { binding: 2, resource: sampler },
      ],
    });

    const udata = new Float32Array(UBYTES / 4);
    const rowBuf = new Uint8Array(NUM_KEYS * 4);
    const fullBuf = new Uint8Array(NUM_KEYS * HIST_ROWS * 4);
    const midiHold = new Float32Array(NUM_KEYS);
    const activeKeys = new Float32Array(NUM_KEYS);
    const smoothKeys = new Float32Array(NUM_KEYS);

    let writeRow = 0;
    let rowAccum = 0;
    let lastTick = -1;

    return {
      frame({ enc, out, in: ins, params, audio, tick, sub, time, past, width, height }) {
        const speed = Math.max(0.4, Math.min(4.0, params.speed as number));
        const gain = params.gain as number;
        const threshold = params.threshold as number;
        const perspective = params.perspective as number;
        const keyboardH = params.keyboard_h as number;
        const glow = params.glow as number;
        const grid = params.grid as number;

        if (lastTick < 0 || tick < lastTick || tick - lastTick > 40) {
          midiHold.fill(0);
          smoothKeys.fill(0);
          for (let r = 0; r < HIST_ROWS; r++) {
            const rowsAgo = HIST_ROWS - 1 - r;
            const ago = Math.min(597, Math.floor(rowsAgo / speed));
            const cur = ago === 0 ? audio : past(ago);
            const prev = past(Math.min(598, ago + 1));
            const prev2 = past(Math.min(599, ago + 2));
            computeRow(
              cur,
              prev,
              prev2,
              midiHold,
              threshold,
              gain,
              fullBuf,
              r * NUM_KEYS * 4,
              r === HIST_ROWS - 1 ? activeKeys : undefined,
            );
          }
          device.queue.writeTexture(
            { texture: rollTex },
            fullBuf,
            { bytesPerRow: NUM_KEYS * 4, rowsPerImage: HIST_ROWS },
            { width: NUM_KEYS, height: HIST_ROWS },
          );
          for (let k = 0; k < NUM_KEYS; k++) smoothKeys[k] = activeKeys[k];
          writeRow = HIST_ROWS - 1;
          rowAccum = 0;
          lastTick = tick;
        } else if (tick > lastTick) {
          const dt = tick - lastTick;
          rowAccum += dt * speed;
          const rowsToWrite = Math.min(HIST_ROWS - 2, Math.floor(rowAccum));
          rowAccum -= rowsToWrite;

          for (let s = 0; s < rowsToWrite; s++) {
            const rowsFromNow = rowsToWrite - 1 - s;
            const ago = Math.max(0, Math.min(597, Math.floor(rowsFromNow / speed)));
            const cur = ago === 0 ? audio : past(ago);
            const prev = past(Math.min(598, ago + 1));
            const prev2 = past(Math.min(599, ago + 2));
            writeRow = (writeRow + 1) % HIST_ROWS;
            computeRow(cur, prev, prev2, midiHold, threshold, gain, rowBuf, 0, activeKeys);
            device.queue.writeTexture(
              { texture: rollTex, origin: { x: 0, y: writeRow } },
              rowBuf,
              { bytesPerRow: NUM_KEYS * 4, rowsPerImage: 1 },
              { width: NUM_KEYS, height: 1 },
            );
          }
          // Smooth active key glow: fast attack, musical release
          for (let k = 0; k < NUM_KEYS; k++) {
            const target = activeKeys[k];
            smoothKeys[k] = target > smoothKeys[k]
              ? smoothKeys[k] + (target - smoothKeys[k]) * 0.72
              : smoothKeys[k] * 0.84;
          }
          lastTick = tick;
        }

        // Onset kick envelope
        let kick = 0;
        for (let a = 0; a < 14; a++) {
          if (past(a).onset) kick = Math.max(kick, Math.exp(-a / 4.2));
        }

        const bass = (audio.bands[0] + audio.bands[1] + audio.bands[2]) / 3;
        const headV = (writeRow + 0.5) / HIST_ROWS;
        const subV = ((rowAccum + (sub / 256) * speed) / HIST_ROWS) * 0.85;

        udata.set([width, height, time, headV], 0);
        udata.set([perspective, keyboardH, glow, grid], 4);
        udata.set([audio.rms, bass, kick, subV], 8);
        udata.set([audio.phase, audio.bar, speed, audio.pal], 12);
        samplePalette8(ins.palette as Palette | undefined, audio.pal, udata, 16);
        for (let k = 0; k < NUM_KEYS; k++) {
          udata[48 + k] = smoothKeys[k];
        }

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
        rollTex.destroy();
      },
    };
  },
});
