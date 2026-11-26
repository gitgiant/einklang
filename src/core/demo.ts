// Synthetic, fully integer "track" so scenes can be previewed (and tested) without audio.
// 28 ticks per beat (~128.6 BPM), sections of 8 bars: intro -> build -> drop -> breakdown.
import { NB, STRIDE, WAVE_N, TICKS_PER_BEAT as TPB, K_RMS, K_ONSET } from './constants.ts';
import type { FeatureSource } from './features.ts';
import { isin, h32, clamp } from './math.ts';

const SECTION_BARS = 8;
export const SECTIONS = ['intro', 'build', 'drop', 'breakdown'] as const;

export function sectionAt(tick: number): (typeof SECTIONS)[number] {
  return SECTIONS[(Math.floor(tick / (TPB * 4 * SECTION_BARS)) % 4 + 4) % 4];
}

function frame(t: number): Uint8Array {
  const out = new Uint8Array(STRIDE);
  if (t < 0) return out;
  const beat = Math.floor(t / TPB), pos = t - beat * TPB, bar = beat >> 2, inBar = beat & 3;
  const sec = (Math.floor(bar / SECTION_BARS) % 4), barInSec = bar % SECTION_BARS;
  const drums = sec === 1 || sec === 2, full = sec === 2;

  const kick = drums || (sec === 0 && barInSec >= 4) ? Math.max(0, 255 - pos * 16) : 0;
  const snare = (full || (sec === 1 && barInSec >= 4)) && (inBar & 1) ? Math.max(0, 230 - pos * 11) : 0;
  const hatPos = pos - (TPB >> 1);
  const hat = sec !== 3 && hatPos >= 0 ? Math.max(0, 190 - hatPos * 24) : 0;
  const buildUp = sec === 1 ? (barInSec * 255) >> 3 : 0;
  // bass note per beat and a slow pad sweep
  const note = h32(bar, inBar) & 3;
  const bassAmp = full ? 200 - pos * 3 : sec === 3 ? 90 : 120;
  const sweep = (isin(t * 3) + 32768) >> 8; // 0..255, slow

  for (let b = 0; b < NB; b++) {
    let v = 20 + ((15 - b) * 3);
    if (b < 3) v += (kick * (3 - b)) / 3 + (b === note % 3 ? bassAmp : bassAmp >> 2);
    else if (b < 7) v += (bassAmp >> 1) * (7 - b) / 4 + ((sweep * (b === 3 + (sweep >> 6) ? 160 : 60)) >> 8);
    else if (b < 11) v += snare * 0.9 + ((sweep * 90) >> 8) + (sec === 3 ? 80 : 0);
    else v += hat * (b - 9) / 4 + snare * 0.6 + buildUp * (b - 10) / 8;
    v += h32(t, b) & 15;
    out[b] = clamp(v | 0, 0, 255);
  }
  let rms = 0;
  for (let b = 0; b < NB; b++) rms += out[b];
  out[K_RMS] = clamp(((rms / NB) | 0) + (kick >> 2), 0, 255);
  out[K_ONSET] = pos === 0 && kick ? 255 : pos === 0 && snare ? 255 : 0;
  return out;
}

function wave(t: number): Int8Array {
  // Two oscillators whose frequency ratio changes per section -> classic Lissajous figures.
  const ratios = [[1, 1], [2, 3], [3, 4], [1, 2]];
  const sec = (Math.floor(t / (TPB * 4 * SECTION_BARS)) % 4 + 4) % 4;
  const [fl, fr] = ratios[sec];
  const pos = ((t % TPB) + TPB) % TPB;
  const amp = 60 + Math.max(0, 60 - pos * 4); // kick swell
  const drift = t * 11, out = new Int8Array(WAVE_N * 2);
  for (let i = 0; i < WAVE_N; i++) {
    const a = (i * 8 * fl) & 4095, b = (i * 8 * fr + drift + 1024) & 4095;
    const wob = isin(i * 24 + t * 23) >> 13; // small high harmonic
    out[i * 2] = clamp(((isin(a) * amp) >> 15) + wob, -127, 127);
    out[i * 2 + 1] = clamp(((isin(b) * amp) >> 15) - wob, -127, 127);
  }
  return out;
}

/** Deterministic demo source; results are memoized per tick. */
export function demoSource(): FeatureSource {
  const cache = new Map<number, Uint8Array>(), wcache = new Map<number, Int8Array>();
  const get = (t: number) => {
    let f = cache.get(t);
    if (!f) { f = frame(t); cache.set(t, f); if (cache.size > 2048) cache.delete(cache.keys().next().value!); }
    return f;
  };
  return {
    get: (t, k) => get(t)[k],
    wave: (t) => {
      let w = wcache.get(t);
      if (!w) { w = wave(t); wcache.set(t, w); if (wcache.size > 64) wcache.delete(wcache.keys().next().value!); }
      return w;
    },
  };
}
