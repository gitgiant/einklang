import { NB, STRIDE, K_RMS, K_ONSET } from './constants.ts';

/** Read-only view of per-tick audio features. Unknown ticks read as silence. */
export interface FeatureSource {
  /** Feature k (see STRIDE layout) at tick, 0..255. */
  get(tick: number, k: number): number;
  /** Decimated L/R waveform at tick (WAVE_N interleaved int8 pairs), or null if not streamed. */
  wave(tick: number): Int8Array | null;
}

export const silence: FeatureSource = { get: () => 0, wave: () => null };

/** Whole-track features as sent by the file-mode leader. */
export function fileSource(feat: Uint8Array, frames: number): FeatureSource {
  return {
    get: (t, k) => (t < 0 || t >= frames ? 0 : feat[t * STRIDE + k]),
    wave: () => null,
  };
}

/** Sparse live features keyed by tick. */
export function mapSource(m: Map<number, Uint8Array>): FeatureSource {
  return { get: (t, k) => m.get(t)?.[k] ?? 0, wave: () => null };
}

/** Triangular-weighted average of feature k over the last n ticks. */
export function smooth(F: FeatureSource, f: number, k: number, n: number): number {
  let s = 0, w = 0;
  for (let i = 0; i < n; i++) { s += F.get(f - i, k) * (n - i); w += n - i; }
  return (s / w) | 0;
}

export interface Smoothed { S: Int32Array; E: number; bass: number; onsets: number; lastOnsetAge: number }

/** Common per-tick derived values every scene uses. */
export function derive(F: FeatureSource, f: number, lookback = 600): Smoothed {
  const S = new Int32Array(NB);
  for (let b = 0; b < NB; b++) S[b] = smooth(F, f, b, 8);
  const E = smooth(F, f, K_RMS, 16);
  const bass = ((S[0] + S[1] + S[2]) / 3) | 0;
  let onsets = 0, lastOnsetAge = 255;
  for (let i = 0; i < lookback; i++) if (F.get(f - i, K_ONSET)) { onsets++; if (lastOnsetAge === 255 && i < 255) lastOnsetAge = i; }
  return { S, E, bass, onsets, lastOnsetAge };
}
