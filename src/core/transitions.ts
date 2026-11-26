// Scene transitions: per-effect progress curves as pure functions of (schedule, tick, features),
// so every host mixes the two scenes identically. The GPU side (lab/transitions/<id>/mix.wgsl,
// assembled by transwgsl.ts) only draws the mix; everything that enters the sync hash is computed
// here, in IEEE-exact ops (+ - * /, floor, ceil, round, min, max).
//
// The transitions themselves are folders (lab/transitions/<id>/transition.json + mix.wgsl). The
// host installs them once at startup (src/web/transitions.ts in the browser, src/server/
// transitions.ts in Node); `kind` is the position in the registry: the 14 core ones in CORE_ORDER,
// then the rest by id, so it is the same on every host.
import { RETIRE_AT, pickWeighted } from './votes.ts';
import { K_ONSET, NB } from './constants.ts';
import { smooth, type FeatureSource } from './features.ts';
import { FNV0, fnv } from './math.ts';
import { stepAt, type SceneSched, type TransSched, type TransType } from './protocol.ts';

/** Fixed-point one: progress and flash are integers 0..ONE so they hash exactly. */
export const ONE = 65536;

/** The plain hard switch: never drawn as a transition. */
export const CUT_ID = 'core-cut';

/** The engine's transitions, in their historical shader order (`kind` 0..13). */
export const CORE_ORDER = [
  'core-cut', 'core-blend', 'core-flash', 'core-wipe', 'core-iris', 'core-dissolve', 'core-luma',
  'core-zoom', 'core-glitch', 'core-stutter', 'core-swirl', 'core-melt', 'core-audio', 'core-pixelate',
] as const;

// ---------------------------------------------------------------------------------------------
// Curves: transition.json names one, with numeric params. All exact, all 0 at x = 0.

/** Curve params: name -> [default, min, max, integer]. */
export const CURVES = {
  /** progress = time */
  linear: {},
  /** the default: smooth in and out */
  smoothstep: {},
  /** smoother still: zero first and second derivative at both ends */
  smootherstep: {},
  /** cubic ease in-out: slow start and end, fast middle */
  cubic: {},
  /** slow start: x^power */
  'ease-in': { power: [2, 1, 8, true] },
  /** fast start, slow end: 1 - (1 - x)^power */
  'ease-out': { power: [2, 1, 8, true] },
  /** ease-out with three decaying bounces at the end */
  bounce: {},
  /**
   * Hard cuts on a 1/per-beat grid: each step starts on the old scene and cuts to the new one for
   * its last share, a share that grows step by step (p is only ever 0 or 1).
   */
  stutter: { per: [8, 1, 32, true] },
  /** Progress jumps on a 1/per-beat grid: (step + 1) / steps. */
  'beat-steps': { per: [4, 1, 32, true] },
  /** Smoothstep floor; every onset so far closes `push` of the remaining distance. */
  onset: { push: [0.15, 0, 1, false] },
} as const satisfies Record<string, Record<string, readonly [number, number, number, boolean]>>;
export type CurveType = keyof typeof CURVES;
export interface CurveSpec { type: CurveType; [param: string]: number | string }

const smoothstep = (x: number) => x * x * (3 - 2 * x);
const cubic = (x: number) => { if (x < 0.5) return 4 * x * x * x; const y = 2 - 2 * x; return 1 - (y * y * y) / 2; };
const ipow = (x: number, n: number) => { let m = x; for (let i = 1; i < n; i++) m *= x; return m; };
const bounceOut = (x: number) => {
  const n = 7.5625, d = 2.75;
  if (x < 1 / d) return n * x * x;
  if (x < 2 / d) { const y = x - 1.5 / d; return n * y * y + 0.75; }
  if (x < 2.5 / d) { const y = x - 2.25 / d; return n * y * y + 0.9375; }
  const y = x - 2.625 / d; return n * y * y + 0.984375;
};
const q16 = (x: number) => Math.round(Math.min(1, Math.max(0, x)) * ONE);

/** A curve param with its default. */
const cp = (c: CurveSpec, k: string): number => {
  const v = c[k], d = (CURVES[c.type] as Record<string, readonly [number, number, number, boolean]>)[k];
  return typeof v === 'number' ? v : d[0];
};

/**
 * Progress 0..ONE `dt` ticks into a `ticks`-long transition started at `at` (beat `tpb` ticks),
 * 0 <= dt < ticks; `sub` (0..255) places it between ticks for display interpolation (the hashed
 * value uses sub = 0).
 */
export function curveAt(c: CurveSpec, tr: { ticks: number; tpb: number }, at: number, dt: number, F: FeatureSource, sub = 0): number {
  const x = (dt + sub / 256) / tr.ticks;
  switch (c.type) {
    case 'linear': return q16(x);
    case 'smootherstep': return q16(x * x * x * (x * (x * 6 - 15) + 10));
    case 'cubic': return q16(cubic(x));
    case 'ease-in': return q16(ipow(x, cp(c, 'power')));
    case 'ease-out': { const y = 1 - x; return q16(1 - ipow(y, cp(c, 'power'))); }
    case 'bounce': return q16(bounceOut(x));
    case 'stutter': {
      const d = dt + sub / 256, step = tr.tpb / cp(c, 'per'), n = Math.max(1, Math.ceil(tr.ticks / step)), i = Math.floor(d / step);
      const u = (d - i * step) / step, share = (i + 1) / n;
      return u >= 1 - share ? ONE : 0;
    }
    case 'beat-steps': {
      const d = dt + sub / 256, step = tr.tpb / cp(c, 'per'), n = Math.max(1, Math.ceil(tr.ticks / step)), i = Math.floor(d / step);
      return q16((i + 1) / n);
    }
    case 'onset': {
      let k = 1;
      const keep = 1 - cp(c, 'push');
      for (let t = at; t <= at + dt; t++) if (F.get(t, K_ONSET)) k *= keep;
      const sm = smoothstep(x);
      return q16(sm + (1 - sm) * (1 - k));
    }
    default: return q16(smoothstep(x));
  }
}

// ---------------------------------------------------------------------------------------------
// Registry

/** Core-computed inputs a transition opts into (each one enters the hash). */
export const TRANS_USES = ['flash', 'roll', 'bands'] as const;
export type TransUse = (typeof TRANS_USES)[number];

/** A shader constant: `fn p_<name>() -> f32` in mix.wgsl. */
export interface TransParam { default: number; min?: number; max?: number; doc?: string }

/** lab/transitions/<id>/transition.json */
export interface TransDef {
  id: string;
  /** Shown in the selectors. */
  name: string;
  vendor: string;
  model?: string;
  description: string;
  curve: CurveSpec | CurveType;
  /** flash: white flash 0..1 peaking at p = 0.25; roll: re-roll index every 1/16 beat; bands: the 16 smoothed bands. */
  uses?: TransUse[];
  /** Post trails pushed up to this decay around the midpoint (melt: 0.985). */
  trails?: number;
  params?: Record<string, TransParam>;
  budget?: { ms: number };
  tags?: string[];
  changelog?: { date: string; by: string; note: string }[];
}

/** A registered transition: its def, curve resolved, `kind` = its index. */
export interface TransEntry extends TransDef {
  kind: number;
  curve: CurveSpec;
  /** mix.wgsl as written. */
  wgsl: string;
}

/** One folder as loaded from disk or a bundle. */
export interface TransFile { folder: string; def: unknown; wgsl: string | undefined }

const VENDORS = ['core', 'claude', 'codex', 'agy'];
const ID_RE = /^[a-z0-9]+(-[a-z0-9]+)+$/;
const KEYS = ['id', 'name', 'vendor', 'model', 'description', 'curve', 'uses', 'trails', 'params', 'budget', 'tags', 'changelog'];
const curveOf = (c: CurveSpec | CurveType): CurveSpec => (typeof c === 'string' ? { type: c } : c);

/** Schema and contract checks of one folder (the WGSL is only compiled in a browser: see transwgsl.ts). */
export function validateTransition(f: TransFile): string[] {
  const errs: string[] = [], d = f.def as TransDef, at = `transitions/${f.folder}`;
  const err = (s: string) => errs.push(`${at}: ${s}`);
  if (!d || typeof d !== 'object') return [`${at}: transition.json is not an object`];
  if (typeof d.id !== 'string' || !ID_RE.test(d.id)) err(`id must be <vendor>-<slug>, lowercase and hyphenated (got ${JSON.stringify(d.id)})`);
  else {
    if (d.id !== f.folder) err(`id ${d.id} doesn't match its folder`);
    const v = d.id.split('-')[0];
    if (!VENDORS.includes(v)) err(`id prefix ${v} is not a vendor (${VENDORS.join(', ')})`);
    if (d.vendor !== v) err(`vendor must be "${v}" (the id prefix)`);
  }
  for (const k of Object.keys(d)) if (!KEYS.includes(k)) err(`unknown key "${k}"`);
  if (typeof d.name !== 'string' || !d.name.trim() || d.name.length > 24) err('name: 1..24 characters');
  if (typeof d.description !== 'string' || !d.description.trim()) err('description: one sentence on what it looks like');
  if (d.model !== undefined && typeof d.model !== 'string') err('model must be a string');
  const c = d.curve === undefined ? undefined : curveOf(d.curve);
  if (!c || typeof c !== 'object' || !(c.type in CURVES)) err(`curve: one of ${Object.keys(CURVES).join(', ')} (got ${JSON.stringify(d.curve)})`);
  else {
    const spec = CURVES[c.type] as Record<string, readonly [number, number, number, boolean]>;
    for (const [k, v] of Object.entries(c)) {
      if (k === 'type') continue;
      const s = spec[k];
      if (!s) { err(`curve ${c.type} has no param "${k}"${Object.keys(spec).length ? ` (${Object.keys(spec).join(', ')})` : ''}`); continue; }
      if (typeof v !== 'number' || !Number.isFinite(v) || v < s[1] || v > s[2] || (s[3] && !Number.isInteger(v))) err(`curve.${k}: ${s[3] ? 'an integer' : 'a number'} in ${s[1]}..${s[2]}`);
    }
  }
  if (d.uses !== undefined && (!Array.isArray(d.uses) || d.uses.some((u) => !TRANS_USES.includes(u)))) err(`uses: a list of ${TRANS_USES.join(', ')}`);
  if (d.trails !== undefined && (typeof d.trails !== 'number' || d.trails < 0 || d.trails >= 1)) err('trails: a decay in 0..1 (exclusive)');
  if (d.budget !== undefined && (typeof d.budget?.ms !== 'number' || d.budget.ms < 0)) err('budget: { "ms": <cost over the plain blend at 1080p> }');
  if (d.tags !== undefined && (!Array.isArray(d.tags) || d.tags.some((t) => typeof t !== 'string'))) err('tags: a list of strings');
  if (d.params !== undefined) {
    if (typeof d.params !== 'object' || d.params === null) err('params: an object');
    else for (const [k, p] of Object.entries(d.params)) {
      if (!/^[a-z][a-z0-9_]*$/.test(k)) err(`param ${k}: lowercase identifier`);
      if (!p || typeof p.default !== 'number' || !Number.isFinite(p.default)) err(`param ${k}: needs a numeric default`);
      else if ((p.min !== undefined && p.default < p.min) || (p.max !== undefined && p.default > p.max)) err(`param ${k}: default outside min..max`);
    }
  }
  const w = f.wgsl;
  if (typeof w !== 'string') err('missing mix.wgsl');
  else {
    const code = w.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
    if (!/\bfn\s+trans\s*\(\s*\w+\s*:\s*vec2f\s*\)\s*->\s*vec3f/.test(code)) err('mix.wgsl must define fn trans(uv: vec2f) -> vec3f');
    const bad = code.match(/@(group|binding|fragment|vertex|compute|workgroup_size)\b|\benable\s+\w+\s*;|\b(texture_2d|sampler)\b|\bvar\s*<\s*(uniform|storage)/);
    if (bad) err(`mix.wgsl may not declare bindings, entry points or extensions (found "${bad[0]}"): use sa/sb and T`);
  }
  return errs;
}

/** Deterministic order: the core ones in CORE_ORDER, then the rest by id (code-unit order). */
export function orderTransitions<T extends { id: string }>(defs: T[]): T[] {
  const core = (id: string) => (CORE_ORDER as readonly string[]).indexOf(id);
  return [...defs].sort((a, b) => {
    const ca = core(a.id), cb = core(b.id);
    if (ca >= 0 || cb >= 0) return ca < 0 ? 1 : cb < 0 ? -1 : ca - cb;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/** Validate, order and index folders. Invalid ones are left out (and reported); so is a duplicate id. */
export function buildTransitions(files: TransFile[]): { list: TransEntry[]; errors: string[] } {
  const errors: string[] = [], ok: TransEntry[] = [], seen = new Set<string>();
  for (const f of [...files].sort((a, b) => (a.folder < b.folder ? -1 : a.folder > b.folder ? 1 : 0))) {
    const errs = validateTransition(f);
    const d = f.def as TransDef;
    if (!errs.length && seen.has(d.id)) errs.push(`transitions/${f.folder}: duplicate id ${d.id}`);
    errors.push(...errs);
    if (errs.length) continue;
    seen.add(d.id);
    ok.push({ ...d, kind: -1, curve: curveOf(d.curve), wgsl: f.wgsl! });
  }
  for (const id of CORE_ORDER) if (!seen.has(id)) errors.push(`transitions/${id}: core transition missing (kinds would shift)`);
  const list = orderTransitions(ok).map((e, kind) => ({ ...e, kind }));
  return { list, errors };
}

interface Reg { list: TransEntry[]; byId: Map<string, TransEntry> }
let REG: Reg | null = null;

/** Install the registry (once per host, before any schedule is evaluated). Returns the folders' problems. */
export function installTransitions(files: TransFile[]): string[] {
  const { list, errors } = buildTransitions(files);
  REG = { list, byId: new Map(list.map((e) => [e.id, e])) };
  return errors;
}

const reg = (): Reg => {
  if (!REG) throw new Error('transitions not installed: import src/web/transitions.ts (browser) or src/server/transitions.ts (Node) first');
  return REG;
};

/** Every registered transition, `kind` order. */
export const transitions = (): readonly TransEntry[] => reg().list;
/** Registered ids, `kind` order (cut first). */
export const transIds = (): string[] => reg().list.map((e) => e.id);
/** Every transition but cut. */
export const transEffects = (): string[] => reg().list.filter((e) => e.id !== CUT_ID).map((e) => e.id);
export const transEntry = (id: string): TransEntry | undefined => reg().byId.get(id);
/** Display name (the id itself for an unknown one). */
export const transName = (id: string): string => reg().byId.get(id)?.name ?? id;

/**
 * A registered id from a saved setting, URL or message: ids as they are, and the short names of
 * the core ones ('blend' -> 'core-blend'). null for anything else.
 */
export function resolveTrans(x: unknown): TransType | null {
  if (typeof x !== 'string') return null;
  const r = reg();
  if (r.byId.has(x)) return x;
  return r.byId.has(`core-${x}`) ? `core-${x}` : null;
}

// ---------------------------------------------------------------------------------------------
// Schedule evaluation

/** A transition in progress at one tick. */
export interface Transition {
  type: TransType;
  /** Shader switch index (position in the registry). */
  kind: number;
  from: string; to: string;
  /** Progress 0..ONE, and the same as a float. */
  p16: number; p: number;
  /** Flash intensity 0..ONE (with uses "flash", else 0). */
  flash16: number;
  /** Re-roll index every 1/16 beat (with uses "roll", else 0). */
  roll: number;
  seed: number; ticks: number;
  /** Smoothed bands 0..255 at the tick (with uses "bands", else null). */
  bands: number[] | null;
}

/** Progress 0..ONE of `tr` (started at `at`) `dt` ticks in; see curveAt. */
export function progress(tr: TransSched, at: number, dt: number, F: FeatureSource, sub = 0): number {
  const e = reg().byId.get(tr.type);
  return curveAt(e ? e.curve : { type: 'smoothstep' }, tr, at, dt, F, sub);
}

/** The transition running at `tick` (+ `sub`/256 for display), or null when one scene is simply showing. */
export function transitionAt(s: SceneSched, tick: number, F: FeatureSource, sub = 0): Transition | null {
  const st = stepAt(s, tick);
  if (!st || st.trans.type === CUT_ID || st.trans.ticks <= 0) return null;
  const tr = st.trans, dt = tick - st.at;
  if (dt >= tr.ticks) return null;
  // an id this host doesn't know (shouldn't happen: the server only schedules registered ones) mixes as a blend
  const e = reg().byId.get(tr.type) ?? reg().byId.get('core-blend')!;
  const uses = e.uses ?? [];
  const p16 = curveAt(e.curve, tr, st.at, dt, F, sub), p = p16 / ONE;
  let flash16 = 0;
  if (uses.includes('flash')) { const f = p < 0.25 ? p / 0.25 : (1 - p) / 0.75; flash16 = q16(f * f); }
  return {
    type: tr.type, kind: e.kind, from: st.prev, to: st.id, p16, p, flash16,
    roll: uses.includes('roll') ? Math.floor(dt / (tr.tpb / 16)) : 0,
    seed: tr.seed >>> 0, ticks: tr.ticks,
    bands: uses.includes('bands') ? Array.from({ length: NB }, (_, b) => smooth(F, tick, b, 8)) : null,
  };
}

/** Sync hash during a transition: both scene states plus everything that shapes the mix. */
export const transHash = (hFrom: number, hTo: number, t: Transition): number =>
  fnv(FNV0, [hFrom | 0, hTo | 0, t.kind, t.ticks, t.seed | 0, t.p16, t.flash16, t.roll]);

/** What `random` picks from: every effect except cut and those voted to RETIRE_AT or below (never empty). */
export function randomPool(scores: Record<string, number> = {}): TransType[] {
  const all = transEffects(), live = all.filter((t) => (scores[t] ?? 0) > RETIRE_AT);
  return live.length ? live : all;
}

/**
 * Server-side `random`: weighted by votes like scene rotation (2^score), over randomPool without `last`.
 * With no votes it is uniform. `r` in [0, 1).
 */
export function pickRandom(last: TransType | null, r: number, scores: Record<string, number> = {}): TransType {
  return pickWeighted(randomPool(scores), scores, r, last ?? undefined)!;
}
