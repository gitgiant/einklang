// The gallery's local stand-in for the server's scene schedule: a pure function of the tick (so stills
// repeat) that moves to the next scene every `cycle` ticks.
import { TICKS_PER_BEAT } from '../core/constants.ts';
import { TRANSITIONS, type SceneSched, type TransType } from '../core/protocol.ts';
import { h32 } from '../core/math.ts';
import type { GalleryTrans } from './defaults.ts';

const EFFECTS = TRANSITIONS.filter((t) => t !== 'cut');
const mod = (a: number, n: number) => ((a % n) + n) % n;

/** Effects shuffled for one round of switches. */
function round(r: number): TransType[] {
  return EFFECTS.map((t, i) => ({ t, k: h32(r, i) >>> 0 })).sort((a, b) => a.k - b.k).map((x) => x.t);
}

/** The `random` effect of switch `n`: shuffled rounds through every effect, never the same twice in a row. */
export function randomEffect(n: number): TransType {
  const len = EFFECTS.length, r = Math.floor(n / len), cur = round(r);
  // only the first two of a round ever swap, so the previous round's last entry is as shuffled
  if (cur[0] === round(r - 1)[len - 1]) [cur[0], cur[1]] = [cur[1], cur[0]];
  return cur[mod(n, len)];
}

/** Where a run of the cycle started: at tick `at`, switch number `n`, from scene index `prev` to `idx`. */
export interface Anchor { at: number; n: number; idx: number; prev: number }
/** The cycle counted from tick 0 and the first scene (what `stop=` stills show). */
export const ZERO: Anchor = { at: 0, n: 0, idx: 0, prev: -1 };

export interface Cycle {
  ids: string[];
  trans: Exclude<GalleryTrans, ''>;
  /** Transition length in beats. */
  beats: number;
}

export const transTicks = (beats: number) => Math.round(beats * TICKS_PER_BEAT);
/** Ticks per scene: 2 bars, or longer so each scene holds a bar after a long transition. */
export const cycleTicks = (beats: number) => Math.max(8, Math.ceil(beats / 4) * 4 + 4) * TICKS_PER_BEAT;

/** An anchor that shows scene `idx` from `tick` on with no transition, until the next switch. */
export const holdAt = (tick: number, idx: number, beats: number, n = 0): Anchor => ({ at: tick - transTicks(beats), n, idx, prev: idx });

/** Number of the switch running at `tick`. */
export const switchAt = (c: Cycle, a: Anchor, tick: number) => a.n + Math.floor((tick - a.at) / cycleTicks(c.beats));

/** The switch `from` -> `to` starting at tick `at`, as switch number `n`. */
export function step(c: Cycle, n: number, from: string, to: string, at: number): SceneSched {
  const type = c.trans === 'all' ? EFFECTS[mod(n, EFFECTS.length)] : c.trans === 'random' ? randomEffect(n) : c.trans;
  return { id: to, prev: from, at, earlier: [], trans: { type, ticks: transTicks(c.beats), seed: h32(n, 0x7a5), tpb: TICKS_PER_BEAT } };
}

export function cycleSched(c: Cycle, a: Anchor, tick: number): SceneSched {
  const n = switchAt(c, a, tick), k = n - a.n, id = (i: number) => c.ids[mod(i, c.ids.length)];
  return step(c, n, id(k === 0 ? a.prev : a.idx + k - 1), id(a.idx + k), a.at + k * cycleTicks(c.beats));
}
