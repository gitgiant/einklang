// Lab fixtures: synthetic feature streams the sandbox renders against (no audio needed, so they
// work in Hauptling containers). Three characters, so a scene is seen quiet, driving and busy:
//   quiet  - ambient pads, no drums, slow swells
//   techno - four-on-the-floor kick, offbeat hats, rolling bass (~129 bpm)
//   dense  - breakbeat kick/snare, 16th hats, noise bursts, full spectrum
// Integer math only, so a fixture is the same everywhere. A recorded .feat file in lab/fixtures/
// (fileSource format: frames x STRIDE bytes, then optional waveform blocks) can stand beside them.
import { NB, STRIDE, WAVE_N, TICKS_PER_BEAT as TPB, K_RMS, K_ONSET } from './constants.ts';
import { silence, type FeatureSource } from './features.ts';
import { isin, h32, clamp } from './math.ts';

export const FIXTURES = ['quiet', 'techno', 'dense'] as const;
export type FixtureName = (typeof FIXTURES)[number] | 'silence';

interface Hit { kick: number; snare: number; hat: number; noise: number }

function hits(name: FixtureName, t: number): Hit {
  const beat = Math.floor(t / TPB), pos = t - beat * TPB, inBar = beat & 3, sixteenth = Math.floor(pos / (TPB / 4)), p16 = pos % (TPB / 4);
  const decay = (start: number, from: number, rate: number) => Math.max(0, from - (pos - start) * rate);
  switch (name) {
    case 'techno': return {
      kick: decay(0, 255, 16),
      snare: inBar & 1 ? decay(0, 120, 8) : 0, // clap on 2 and 4
      hat: pos >= TPB / 2 ? decay(TPB / 2, 200, 22) : 0,
      noise: 0,
    };
    case 'dense': {
      // breakbeat on the 16th grid: kick 1, 7, 11; snare 5, 13, ghost 16
      const step = inBar * 4 + sixteenth, on = (pat: number) => (pat >> (15 - step)) & 1;
      return {
        kick: on(0b1000001000100000) ? Math.max(0, 255 - p16 * 30) : 0,
        snare: on(0b0000100000001001) ? Math.max(0, 240 - p16 * 26) : 0,
        hat: Math.max(0, 180 - p16 * 30) + (h32(beat, sixteenth) & 63),
        noise: (h32(t >> 3, 7) & 255) > 200 ? 150 : 0,
      };
    }
    default: return { kick: 0, snare: 0, hat: 0, noise: 0 };
  }
}

function frame(name: FixtureName, t: number): Uint8Array {
  const out = new Uint8Array(STRIDE);
  if (t < 0 || name === 'silence') return out;
  const h = hits(name, t), beat = Math.floor(t / TPB), pos = t - beat * TPB;
  const swell = (isin(t * 2) + 32768) >> 8; // 0..255, ~15 s cycle
  for (let b = 0; b < NB; b++) {
    let v: number;
    if (name === 'quiet') {
      // two slow pads drifting across the mids, a soft high shimmer
      const c1 = 5 + ((isin(t) + 32768) >> 13), c2 = 9 + ((isin(t * 3 + 1000) + 32768) >> 14);
      v = 10 + Math.max(0, 110 - Math.abs(b - c1) * 35) * swell / 255 + Math.max(0, 70 - Math.abs(b - c2) * 30) + (b > 12 ? (h32(t >> 2, b) & 31) : 0);
    } else {
      const bassNote = h32(beat >> 1, 3) % 3;
      v = 25 + (15 - b) * 2;
      if (b < 3) v += (h.kick * (3 - b)) / 3 + (b === bassNote ? 140 - pos * 3 : 40);
      else if (b < 8) v += h.snare * 0.5 + (swell * 70) / 255;
      else if (b < 12) v += h.snare * 0.9 + h.noise * 0.6;
      else v += h.hat * (b - 9) / 4 + h.noise;
    }
    v += h32(t, b + 100) & 15;
    out[b] = clamp(v | 0, 0, 255);
  }
  let s = 0;
  for (let b = 0; b < NB; b++) s += out[b];
  out[K_RMS] = clamp(((s / NB) | 0) + (h.kick >> 2), 0, 255);
  // an onset on the first tick of a kick or snare hit
  const prev = t > 0 ? hits(name, t - 1) : { kick: 0, snare: 0 };
  out[K_ONSET] = (h.kick > 200 && h.kick > prev.kick) || (h.snare > 200 && h.snare > prev.snare) ? 255 : 0;
  return out;
}

function wave(name: FixtureName, t: number, f: Uint8Array): Int8Array {
  const out = new Int8Array(WAVE_N * 2);
  if (name === 'silence') return out;
  // low partial follows the bass bands, a higher one the mids; detuned L/R for Lissajous
  // quiet: the pads carry the signal (mids), not the bass
  const lo = name === 'quiet' ? (f[5] + f[6]) >> 2 : (f[0] + f[1]) >> 2, mid = f[name === 'quiet' ? 9 : 6] >> 2, hi = f[13] >> 3;
  for (let i = 0; i < WAVE_N; i++) {
    const a = isin((i * 6 + t * 40) & 4095), b = isin((i * 21 + t * 17) & 4095), c = isin((i * 97) & 4095);
    const n = name === 'dense' ? (h32(i, t) & 31) - 16 : 0;
    out[i * 2] = clamp(((a * lo) >> 15) + ((b * mid) >> 15) + ((c * hi) >> 15) + n, -127, 127);
    out[i * 2 + 1] = clamp(((isin((i * 6 + t * 40 + 700) & 4095) * lo) >> 15) + ((b * mid) >> 16) + n, -127, 127);
  }
  return out;
}

/** A fixture as a FeatureSource (memoized per tick). */
export function fixtureSource(name: FixtureName): FeatureSource {
  if (name === 'silence') return silence;
  const cache = new Map<number, Uint8Array>();
  const get = (t: number) => {
    let f = cache.get(t);
    if (!f) { f = frame(name, t); cache.set(t, f); if (cache.size > 4096) cache.delete(cache.keys().next().value!); }
    return f;
  };
  return { get: (t, k) => (k < STRIDE ? get(t)[k] : 0), wave: (t) => wave(name, t, get(t)) };
}
