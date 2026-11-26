// Scene transitions: per-effect progress curves as pure functions of (schedule, tick, features),
// so every host mixes the two scenes identically. The GPU side (transition.wgsl) only draws the
// mix; everything that enters the sync hash is computed here, in IEEE-exact ops (+ - * /, round).
import { K_ONSET, NB } from './constants.ts';
import { smooth, type FeatureSource } from './features.ts';
import { FNV0, fnv } from './math.ts';
import { TRANSITIONS, stepAt, type SceneSched, type TransSched, type TransType } from './protocol.ts';

/** Fixed-point one: progress and flash are integers 0..ONE so they hash exactly. */
export const ONE = 65536;

export const TRANS_NAMES: Record<TransType, string> = {
  cut: 'cut', blend: 'blend', flash: 'flash', wipe: 'wipe', iris: 'iris', dissolve: 'dissolve', luma: 'luma',
  zoom: 'zoom', glitch: 'glitch', stutter: 'stutter', swirl: 'swirl', melt: 'melt', audio: 'audio mask', pixelate: 'pixelate',
};

/** A transition in progress at one tick. */
export interface Transition {
  type: TransType;
  /** Shader switch index (position in TRANSITIONS). */
  kind: number;
  from: string; to: string;
  /** Progress 0..ONE, and the same as a float. */
  p16: number; p: number;
  /** Flash intensity 0..ONE (flash only). */
  flash16: number;
  /** Glitch bands re-roll every 1/16 beat: the roll index. */
  roll: number;
  seed: number; ticks: number;
  /** Smoothed bands 0..255 at the tick (audio mask only). */
  bands: number[] | null;
}

const smoothstep = (x: number) => x * x * (3 - 2 * x);
const cubic = (x: number) => { if (x < 0.5) return 4 * x * x * x; const y = 2 - 2 * x; return 1 - (y * y * y) / 2; };
const q16 = (x: number) => Math.round(Math.min(1, Math.max(0, x)) * ONE);
/** Each onset during the audio mask closes this share of the remaining distance. */
const ONSET_PUSH = 0.15;

/**
 * Progress 0..ONE of `tr` (started at `at`) `dt` ticks in, 0 <= dt < tr.ticks; `sub` (0..255)
 * places it between ticks for display interpolation (the hashed value uses sub = 0).
 */
export function progress(tr: TransSched, at: number, dt: number, F: FeatureSource, sub = 0): number {
  const x = (dt + sub / 256) / tr.ticks;
  switch (tr.type) {
    case 'flash': { const y = 1 - x; return q16(1 - y * y * y); } // fast in, slow out
    case 'zoom': case 'swirl': return q16(cubic(x));
    case 'stutter': {
      // 1/8-beat steps; each starts on the old scene and cuts to the new one for its last `share`
      const d = dt + sub / 256, step = tr.tpb / 8, n = Math.max(1, Math.ceil(tr.ticks / step)), i = Math.floor(d / step);
      const u = (d - i * step) / step, share = (i + 1) / n;
      return u >= 1 - share ? ONE : 0;
    }
    case 'audio': {
      // smoothstep floor; every onset so far pushes ahead of it; still 1 at the end at the latest
      let k = 1;
      for (let t = at; t <= at + dt; t++) if (F.get(t, K_ONSET)) k *= 1 - ONSET_PUSH;
      const sm = smoothstep(x);
      return q16(sm + (1 - sm) * (1 - k));
    }
    default: return q16(smoothstep(x));
  }
}

/** The transition running at `tick` (+ `sub`/256 for display), or null when one scene is simply showing. */
export function transitionAt(s: SceneSched, tick: number, F: FeatureSource, sub = 0): Transition | null {
  const st = stepAt(s, tick);
  if (!st || st.trans.type === 'cut' || st.trans.ticks <= 0) return null;
  const tr = st.trans, dt = tick - st.at;
  if (dt >= tr.ticks) return null;
  const p16 = progress(tr, st.at, dt, F, sub), p = p16 / ONE;
  let flash16 = 0;
  if (tr.type === 'flash') { const f = p < 0.25 ? p / 0.25 : (1 - p) / 0.75; flash16 = q16(f * f); }
  return {
    type: tr.type, kind: TRANSITIONS.indexOf(tr.type), from: st.prev, to: st.id, p16, p, flash16,
    roll: tr.type === 'glitch' ? Math.floor(dt / (tr.tpb / 16)) : 0,
    seed: tr.seed >>> 0, ticks: tr.ticks,
    bands: tr.type === 'audio' ? Array.from({ length: NB }, (_, b) => smooth(F, tick, b, 8)) : null,
  };
}

/** Sync hash during a transition: both scene states plus everything that shapes the mix. */
export const transHash = (hFrom: number, hTo: number, t: Transition): number =>
  fnv(FNV0, [hFrom | 0, hTo | 0, t.kind, t.ticks, t.seed | 0, t.p16, t.flash16, t.roll]);

/** Server-side `random`: uniform over every effect except cut and `last`. `r` in [0, 1). */
export function pickRandom(last: TransType | null, r: number): TransType {
  const pool = TRANSITIONS.filter((t) => t !== 'cut' && t !== last);
  return pool[Math.min(pool.length - 1, Math.floor(r * pool.length))];
}
