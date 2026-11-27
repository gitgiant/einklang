// Song structure from the feature stream: which of intro / build / drop / breakdown the music is in,
// decided on bar boundaries from the bars before the boundary (no look-ahead: anticipation is v2 #15).
// Pure and integer-driven (reads feature bytes only), so every host decides the same. Used by the
// core-section modulator and by scene sections (`"when": { "section": "drop" }`).
//
// Per bar: onsets per beat (drums), mean of the top 4 bands (brightness), sampled every 4th tick.
//   drums now (>= 3 onsets in the last bar):  build when the highs rise bar on bar over 2 bars
//                                             or the onset density jumps (risers, snare rolls), else drop
//   no drums now:                             build when rising, else breakdown when there were drums
//                                             in the 8 bars before, else intro
// Bars are on the fixed beat grid (TICKS_PER_BEAT, the one sims reseed on) from tick 0, until beat
// tracking lands (v2 #14): with a MIDI clock at another tempo the boundaries don't follow its bars.
import { K_ONSET, K_RMS, TICKS_PER_BEAT } from './constants.ts';

export const SONG_SECTIONS = ['intro', 'build', 'drop', 'breakdown'] as const;
export type SongSection = (typeof SONG_SECTIONS)[number];
export const BAR_TICKS = TICKS_PER_BEAT * 4;

interface Feat { get(tick: number, key: number): number }

/** Onsets in the bar ending at `end` (exclusive). */
function onsets(F: Feat, end: number): number {
  let n = 0;
  for (let t = end - BAR_TICKS; t < end; t++) if (F.get(t, K_ONSET)) n++;
  return n;
}
/** Mean of bands 12..15 over the bar ending at `end`, every 4th tick, 0..255. */
function highs(F: Feat, end: number): number {
  let s = 0, n = 0;
  for (let t = end - BAR_TICKS; t < end; t += 4, n++) s += F.get(t, 12) + F.get(t, 13) + F.get(t, 14) + F.get(t, 15);
  return s / (4 * n);
}

/** Onsets per bar that count as drums (3 = most beats have one). */
const DRUMS = 3;
/** Rising: highs up by this much (0..255) over 2 bars, or 4 more onsets per bar. */
const RISE_HI = 14, RISE_ON = 4;
/** Bars back that still make a drum-less bar a breakdown rather than an intro. */
const MEMORY = 8;

/** The section index (into SONG_SECTIONS) the music shows at boundary tick `b`, from the bars before it. */
export function sectionAt(F: Feat, b: number): number {
  const on1 = onsets(F, b), on3 = onsets(F, b - 2 * BAR_TICKS);
  const h1 = highs(F, b), h2 = highs(F, b - BAR_TICKS), h3 = highs(F, b - 2 * BAR_TICKS);
  const rising = (h1 > h2 && h2 > h3 && h1 - h3 > RISE_HI) || on1 - on3 >= RISE_ON;
  if (rising) return 1;
  if (on1 >= DRUMS) return 2;
  for (let k = 1; k <= MEMORY; k++) if (onsets(F, b - k * BAR_TICKS) >= DRUMS) return 3;
  return 0;
}

/** The boundary at or before `tick` on a grid of `unit` ticks from 0. */
export const boundary = (tick: number, unit: number): number => Math.floor(tick / unit) * unit;

/** Loudness 0..1: mean RMS over the last bar (every 4th tick), scaled so a full mix reads ~0.8. */
export function energyAt(F: Feat, tick: number): number {
  let s = 0, n = 0;
  for (let t = tick - BAR_TICKS + 1; t <= tick; t += 4, n++) s += F.get(t, K_RMS);
  return Math.min(1, (s / n / 255) * 1.6);
}
