import type { Lyric } from './lrc.ts';
import { NB, STRIDE, K_RMS, K_ONSET, K_P0, K_PAL, WAVE_BYTES, WAVE_N } from './constants.ts';

/** Read-only view of per-tick audio features. Unknown ticks read as silence. */
export interface FeatureSource {
  /** Feature k (see STRIDE layout, plus the input keys past it) at tick, 0..255. */
  get(tick: number, k: number): number;
  /** Decimated L/R waveform at tick (WAVE_N interleaved int8 pairs), or null if not streamed. */
  wave(tick: number): Int8Array | null;
  /** Timed lyrics of the track, if it came with an .lrc. */
  lyrics?: readonly Lyric[] | null;
}

export const silence: FeatureSource = { get: () => 0, wave: () => null };

/** Whole-track features (+ optional waveform block after them) as sent by the file-mode leader. */
export function fileSource(feat: Uint8Array, frames: number): FeatureSource {
  const hasWave = feat.length >= frames * (STRIDE + WAVE_BYTES);
  return {
    get: (t, k) => (t < 0 || t >= frames || k >= STRIDE ? 0 : feat[t * STRIDE + k]),
    wave: (t) => (hasWave && t >= 0 && t < frames
      ? new Int8Array(feat.buffer, feat.byteOffset + frames * STRIDE + t * WAVE_BYTES, WAVE_BYTES) : null),
  };
}

/** Sparse live frames keyed by tick: STRIDE feature bytes, optionally followed by a waveform block. */
export function mapSource(m: Map<number, Uint8Array>): FeatureSource {
  return {
    get: (t, k) => (k < STRIDE ? m.get(t)?.[k] ?? 0 : 0),
    wave: (t) => {
      const u = m.get(t);
      return u && u.length >= STRIDE + WAVE_BYTES ? new Int8Array(u.buffer, u.byteOffset + STRIDE, WAVE_BYTES) : null;
    },
  };
}

/**
 * Decimate one tick of stereo audio (`span` samples starting at `start`) to WAVE_N int8 pairs
 * in `out` at `off`. Out-of-range samples read as silence.
 */
export function decimateWave(L: Float32Array, R: Float32Array, start: number, span: number, out: Uint8Array, off: number): void {
  const n = L.length;
  for (let i = 0; i < WAVE_N; i++) {
    const s = Math.floor(start + (i * span) / WAVE_N), ok = s >= 0 && s < n;
    out[off + i * 2] = Math.max(-127, Math.min(127, Math.round((ok ? L[s] : 0) * 127))) & 255;
    out[off + i * 2 + 1] = Math.max(-127, Math.min(127, Math.round((ok ? R[s] : 0) * 127))) & 255;
  }
}

/** Triangular-weighted average of feature k over the last n ticks. */
export function smooth(F: FeatureSource, f: number, k: number, n: number): number {
  let s = 0, w = 0;
  for (let i = 0; i < n; i++) { s += F.get(f - i, k) * (n - i); w += n - i; }
  return (s / w) | 0;
}

/** `hueOff`: MIDI param 0 (mod wheel) and the pads' palette step rotate every scene's hues; 0 without inputs. */
export interface Smoothed { S: Int32Array; E: number; bass: number; onsets: number; lastOnsetAge: number; hueOff: number }

/** Common per-tick derived values every scene uses. */
export function derive(F: FeatureSource, f: number, lookback = 600): Smoothed {
  const S = new Int32Array(NB);
  for (let b = 0; b < NB; b++) S[b] = smooth(F, f, b, 8);
  const E = smooth(F, f, K_RMS, 16);
  const bass = ((S[0] + S[1] + S[2]) / 3) | 0;
  let onsets = 0, lastOnsetAge = 255;
  for (let i = 0; i < lookback; i++) if (F.get(f - i, K_ONSET)) { onsets++; if (lastOnsetAge === 255 && i < 255) lastOnsetAge = i; }
  return { S, E, bass, onsets, lastOnsetAge, hueOff: F.get(f, K_P0) * 6 + F.get(f, K_PAL) * 256 };
}
