// Oscilloscope / Lissajous: XY plot of the decimated L/R waveform, rotated 45 degrees so a mono
// signal is a vertical line. Until the waveform stream (#7) lands it synthesizes one from the bands.
import { W, H, WAVE_N, K_RMS } from '../constants.ts';
import { derive, type FeatureSource } from '../features.ts';
import { hsv, isin, clamp } from '../math.ts';
import { PrimList, OP_LINE, OP_RING, OP_CLEAR } from '../prims.ts';
import type { SceneDef } from '../scene.ts';

function synthWave(F: FeatureSource, f: number): Int8Array {
  const out = new Int8Array(WAVE_N * 2), amp = 30 + (F.get(f, K_RMS) >> 1);
  for (let i = 0; i < WAVE_N; i++) {
    let l = 0, r = 0;
    for (let b = 0; b < 4; b++) {
      const v = F.get(f, b * 4);
      l += (isin(i * 8 * (b + 1) + f * 13 * b) * v) >> 17;
      r += (isin(i * 8 * (b + 2) + f * 17 + 1024) * v) >> 17;
    }
    out[i * 2] = clamp((l * amp) >> 7, -127, 127);
    out[i * 2 + 1] = clamp((r * amp) >> 7, -127, 127);
  }
  return out;
}

export const scope: SceneDef = {
  id: 'scope',
  name: 'Oscilloscope / Lissajous',
  state(f, F) {
    const w = F.wave(f) ?? synthWave(F, f);
    const { E, onsets, lastOnsetAge } = derive(F, f);
    const hue = 256 + ((onsets * 96) % 1536) + ((f >> 2) % 256);
    const L = new PrimList(WAVE_N + 8);
    const cx = W >> 1, cy = H >> 1, k = lastOnsetAge < 12 ? 3 : 2;
    L.push(OP_CLEAR, 0, 0, 0, 0, 0x000000, 255, 0);
    // graticule
    L.push(OP_RING, cx, cy, 300, 0, hsv(hue, 120, 90), 110, 1);
    L.push(OP_LINE, cx - 330, cy, cx + 330, cy, hsv(hue, 120, 70), 80, 1);
    L.push(OP_LINE, cx, cy - 330, cx, cy + 330, hsv(hue, 120, 70), 80, 1);
    const ptx = (i: number) => cx + ((((w[i * 2] - w[i * 2 + 1]) * 181) >> 8) * k);
    const pty = (i: number) => cy - ((((w[i * 2] + w[i * 2 + 1]) * 181) >> 8) * k);
    const al = clamp(120 + E, 0, 255);
    for (let i = 1; i < WAVE_N; i++)
      L.push(OP_LINE, ptx(i - 1), pty(i - 1), ptx(i), pty(i), hsv(hue + (i >> 3), 150, 255), al, 2);
    return { u: Int32Array.of(f, hue, E, lastOnsetAge), prims: L.done() };
  },
};
