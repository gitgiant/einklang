// The gallery's local stand-in for the server's scene schedule: a pure function of the tick (so stills
// repeat) that moves to the next scene every `cycle` ticks.
import { TICKS_PER_BEAT } from '../core/constants.ts';
import type { SceneSched, TransType } from '../core/protocol.ts';
import { randomPool, transEffects } from '../core/transitions.ts';
import { pickWeighted } from '../core/votes.ts';
import { h32 } from '../core/math.ts';
import type { GalleryTrans } from './defaults.ts';

const mod = (a: number, n: number) => ((a % n) + n) % n;

/** Effects shuffled for one round of switches. */
function round(r: number): TransType[] {
  return transEffects().map((t, i) => ({ t, k: h32(r, i) >>> 0 })).sort((a, b) => a.k - b.k).map((x) => x.t);
}

/** Switches per block of the vote-weighted sequence. */
const BLOCK = 16;

/**
 * The `random` effect of switch `n`, a pure function of `n` and the vote scores, never the same twice in a
 * row. With no votes: shuffled rounds through every effect. With votes: picks weighted like the server's
 * (👍 doubles, 👎 halves, retired ones left out).
 */
export function randomEffect(n: number, scores: Record<string, number> = {}): TransType {
  if (transEffects().some((t) => scores[t])) return weightedEffect(n, scores);
  const EFFECTS = transEffects(), len = EFFECTS.length, r = Math.floor(n / len), cur = round(r);
  // only the first two of a round ever swap, so the previous round's last entry is as shuffled
  if (cur[0] === round(r - 1)[len - 1]) [cur[0], cur[1]] = [cur[1], cur[0]];
  return cur[mod(n, len)];
}

function weightedEffect(n: number, scores: Record<string, number>): TransType {
  const pool = randomPool(scores);
  // two or fewer: nothing to weigh without repeating
  if (pool.length <= 2) return pool[mod(n, pool.length)];
  /** Block `r` as a chain, each pick excluding the one before. */
  const chain = (r: number) => {
    const out: TransType[] = [];
    for (let i = 0; i < BLOCK; i++) out.push(pickWeighted(pool, scores, h32(h32(r, i), 0x3e1) / 2 ** 32, out[i - 1])!);
    return out;
  };
  const r = Math.floor(n / BLOCK), i = mod(n, BLOCK), cur = chain(r);
  // only a block's first entry is ever changed (to differ from both neighbours), so a block's last one is its chain's
  const prev = i === 0 ? chain(r - 1)[BLOCK - 1] : undefined;
  if (cur[i] !== prev) return cur[i];
  return pickWeighted(pool.filter((t) => t !== prev && t !== cur[1]), scores, h32(h32(r, BLOCK), 0x3e1) / 2 ** 32)!;
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
  /** Transition vote scores, for `random`. */
  scores?: Record<string, number>;
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
  const E = transEffects(), type = c.trans === 'all' ? E[mod(n, E.length)] : c.trans === 'random' ? randomEffect(n, c.scores) : c.trans;
  return { id: to, prev: from, at, earlier: [], trans: { type, ticks: transTicks(c.beats), seed: h32(n, 0x7a5), tpb: TICKS_PER_BEAT } };
}

/**
 * Change the transition length without disturbing the switch running at `tick`: the anchor which, with
 * the new length, takes over at the next switch (its `at`; keep the old length and anchor until then).
 */
export function retime(c: Cycle, a: Anchor, tick: number): Anchor {
  const n = switchAt(c, a, tick) + 1, k = n - a.n;
  return { at: a.at + k * cycleTicks(c.beats), n, idx: a.idx + k, prev: a.idx + k - 1 };
}

export function cycleSched(c: Cycle, a: Anchor, tick: number): SceneSched {
  const n = switchAt(c, a, tick), k = n - a.n, id = (i: number) => c.ids[mod(i, c.ids.length)];
  return step(c, n, id(k === 0 ? a.prev : a.idx + k - 1), id(a.idx + k), a.at + k * cycleTicks(c.beats));
}
