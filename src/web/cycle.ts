// The gallery's local stand-in for the server's scene schedule: a pure function of the tick (so stills
// repeat) that moves to the next scene every `cycleTicks` ticks.
import { TICKS_PER_BEAT } from '../core/constants.ts';
import type { SceneSched, TransType } from '../core/protocol.ts';
import { randomPool, transEffects } from '../core/transitions.ts';
import { RETIRE_AT, pickWeighted } from '../core/votes.ts';
import { h32 } from '../core/math.ts';
import type { GalleryRot, GalleryTrans } from './defaults.ts';

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

/**
 * The scene (index into `ids`) switch `n` moves to from `prev`: any but retired ones weighted by votes, or
 * only the liked ones (score > 0; any, while there is none). `seed` varies the walk between page loads.
 */
export function pickScene(rot: 'weighted' | 'liked', ids: string[], scores: Record<string, number>, prev: number, n: number, seed = 0): number {
  const liked = rot === 'liked' ? ids.filter((i) => (scores[i] ?? 0) > 0) : [];
  const live = ids.filter((i) => (scores[i] ?? 0) > RETIRE_AT);
  const pool = liked.length ? liked : live.length ? live : ids;
  return ids.indexOf(pickWeighted(pool, scores, h32(h32(seed, n), 0x5ce) / 2 ** 32, ids[mod(prev, ids.length)])!);
}

/**
 * Where a run of the cycle started: at tick `at`, switch number `n`, from scene index `prev` to `idx`.
 * `seq`: the scenes picked so far (a `pick` cycle), so new vote scores never change one already shown.
 */
export interface Anchor { at: number; n: number; idx: number; prev: number; seq?: number[] }
/** The cycle counted from tick 0 and the first scene (what `stop=` stills show). */
export const ZERO: Anchor = { at: 0, n: 0, idx: 0, prev: -1 };

export interface Cycle {
  ids: string[];
  trans: Exclude<GalleryTrans, ''>;
  /** Transition length in beats. */
  beats: number;
  /** Bars each scene shows alone (`hold=`); see cycleTicks for the default. */
  hold?: number;
  /** Transition vote scores, for `random`. */
  scores?: Record<string, number>;
  /** The scene after `prev` for switch `n`; without it, the next in `ids` order. */
  pick?: (prev: number, n: number) => number;
  /** Stay on the anchor's scene: no further switches. */
  stay?: boolean;
}

export const transTicks = (beats: number) => Math.round(beats * TICKS_PER_BEAT);
/**
 * Ticks from one switch to the next, whole bars: the transition, then the scene alone for at least `hold`
 * bars. By default it is alone at least twice as long as in a cycle of max(2 bars, transition bars + 1).
 */
export function cycleTicks(beats: number, hold?: number): number {
  const alone = hold === undefined ? 2 * (Math.max(8, Math.ceil(beats / 4) * 4 + 4) - beats) : hold * 4;
  return Math.max(1, Math.ceil((beats + alone) / 4)) * 4 * TICKS_PER_BEAT;
}

/** An anchor that shows scene `idx` from `tick` on with no transition, until the next switch. */
export const holdAt = (tick: number, idx: number, beats: number, n = 0): Anchor => ({ at: tick - transTicks(beats), n, idx, prev: idx });

/** Number of the switch running at `tick`. */
export const switchAt = (c: Cycle, a: Anchor, tick: number) => (c.stay ? a.n : a.n + Math.floor((tick - a.at) / cycleTicks(c.beats, c.hold)));

/** The scene index `k` switches after the anchor's. */
function sceneIdx(c: Cycle, a: Anchor, k: number): number {
  if (k < 0) return k === -1 ? a.prev : a.idx + k;
  if (!c.pick) return a.idx + k;
  const seq = (a.seq ??= [a.idx]);
  while (seq.length <= k) seq.push(c.pick(seq[seq.length - 1], a.n + seq.length));
  return seq[k];
}

/** The switch `from` -> `to` starting at tick `at`, as switch number `n`. */
export function step(c: Cycle, n: number, from: string, to: string, at: number): SceneSched {
  const E = transEffects(), type = c.trans === 'all' ? E[mod(n, E.length)] : c.trans === 'random' ? randomEffect(n, c.scores) : c.trans;
  return { id: to, prev: from, at, earlier: [], trans: { type, ticks: transTicks(c.beats), seed: h32(n, 0x7a5), tpb: TICKS_PER_BEAT } };
}

/**
 * Change the cycle without disturbing the switch running at `tick`: the anchor which, with the new settings
 * `to`, takes over at the next switch (its `at`; keep the old ones and the old anchor until then).
 */
export function retime(c: Cycle, a: Anchor, tick: number, to: Cycle = c): Anchor {
  const n = switchAt(c, a, tick) + 1, k = n - a.n, prev = sceneIdx(c, a, k - 1);
  return { at: a.at + k * cycleTicks(c.beats, c.hold), n, idx: to.pick ? to.pick(prev, n) : c.pick ? prev + 1 : a.idx + k, prev };
}

export function cycleSched(c: Cycle, a: Anchor, tick: number): SceneSched {
  const n = switchAt(c, a, tick), k = n - a.n, id = (i: number) => c.ids[mod(i, c.ids.length)];
  const from = id(sceneIdx(c, a, k - 1)), to = id(sceneIdx(c, a, k)), at = c.stay ? a.at : a.at + k * cycleTicks(c.beats, c.hold);
  // a pick that stays put (one liked scene) shows it, with no transition into itself
  return step(c, n, from, to, k > 0 && from === to ? at - transTicks(c.beats) : at);
}

/** What the gallery's cycle can be set to. */
export interface Settings { rot: GalleryRot; trans: Exclude<GalleryTrans, ''>; beats: number; hold?: number }
/** The cycle in effect, and settings waiting to take over from tick `from`. */
export interface Run { s: Settings; anchor: Anchor; pending: { s: Settings; anchor: Anchor; from: number } | null }

/**
 * Change settings at `tick`; the switch running then is never disturbed. Transition, length, hold and order
 * apply from the next switch; `stay` stops after the running one; leaving `stay` starts holding the shown
 * scene once it has arrived. `cycleOf` builds the cycle of some settings.
 */
export function change(cycleOf: (s: Settings) => Cycle, run: Run, patch: Partial<Settings>, tick: number): Run {
  const next: Settings = { ...(run.pending?.s ?? run.s), ...patch };
  let { s, anchor } = run;
  if (next.rot === 'stay' && s.rot !== 'stay') {
    // freeze on the switch running now (its transition plays out as it was)
    const c = cycleOf(s), n = switchAt(c, anchor, tick), k = n - anchor.n;
    anchor = { at: anchor.at + k * cycleTicks(s.beats, s.hold), n, idx: sceneIdx(c, anchor, k), prev: sceneIdx(c, anchor, k - 1) };
    s = { ...s, rot: 'stay' };
  }
  if (s.rot === 'stay') {
    const from = anchor.at + transTicks(s.beats);
    // staying: nothing switches by itself, so new settings wait for the running switch to end (or the next pick)
    return { s, anchor, pending: { s: next, anchor: holdAt(Math.max(from, tick), anchor.idx, next.beats, anchor.n), from } };
  }
  const to = retime(cycleOf(s), anchor, tick, cycleOf(next));
  return { s, anchor, pending: { s: next, anchor: to, from: to.at } };
}
