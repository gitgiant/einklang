// Evolving scenes: a scene's `evolve` names slots (nodes of its graph) and pools of candidate pieces that
// fit the same ports. At every step (bar, phrase, N bars, or a song-section change) one slot swaps to
// another candidate, with params drawn from the candidate's ranges (or its defaults jittered), and the
// swap blends in with a registered transition. Which candidate comes is a pure function of the scene id,
// the step number and the vote scores in effect (lab/feedback.json, bundled with the build), weighted
// like the rotation (2^score); so every host shows the same mutation, and the state joins the hash.
// Spec: lab/AGENTS.md "Evolving scenes", docs/prd-lab.md "Build notes: evolving scenes".
import { CPU_PORTS, PIECE_KINDS, type ParamValue, type PortType } from '../../../lab/api/index.ts';
import { TICKS_PER_BEAT } from '../constants.ts';
import type { FeatureSource } from '../features.ts';
import { FNV0, fnv, h32 } from '../math.ts';
import type { SceneSched, TransSched } from '../protocol.ts';
import { BAR_TICKS, boundary, sectionAt } from '../songform.ts';
import { CUT_ID, transEffects, transEntry, transitionAt, type Transition } from '../transitions.ts';
import { RETIRE_AT, weight } from '../votes.ts';
import { splitRef, type Binding, type EvolveCandidate, type GraphNode, type PieceDef, type Registry, type SceneGraph } from './types.ts';

/** Candidates per slot, the base node included. Every one is built when the scene loads. */
export const MAX_POOL = 6;
export const MAX_SLOTS = 3;
/** The walk restarts from a fresh draw every EPOCH steps, so a state costs at most EPOCH small steps to find. */
export const EPOCH = 64;
/** Steps the lab render and the gate force in turn (s0 = the base graph). */
export const LAB_STEPS = 4;
const DEFAULT_JITTER = 0.08;

/** Piece scores (the digest's credit per piece) and per scene / slot / piece scores from votes on evolving scenes. */
export interface EvolveScores {
  pieces: Record<string, number>;
  slots?: Record<string, Record<string, Record<string, number>>>;
}
export const NO_SCORES: EvolveScores = { pieces: {} };

/** The scores in effect from a digest (lab/feedback.json); tolerant of older digests. */
export function scoresFromDigest(d: unknown): EvolveScores {
  const out: EvolveScores = { pieces: {}, slots: {} }, o = (d ?? {}) as { pieces?: Record<string, { score?: number }>; evolve?: Record<string, { slots?: Record<string, Record<string, { score?: number }>> }> };
  for (const [id, p] of Object.entries(o.pieces ?? {})) if (Number.isFinite(p?.score)) out.pieces[id] = p.score!;
  for (const [scene, e] of Object.entries(o.evolve ?? {})) {
    for (const [node, ps] of Object.entries(e?.slots ?? {})) {
      for (const [piece, s] of Object.entries(ps ?? {})) if (Number.isFinite(s?.score)) ((out.slots![scene] ??= {})[node] ??= {})[piece] = s.score!;
    }
  }
  return out;
}

export interface ResolvedCand {
  piece: string; params: Record<string, ParamValue>; ranges: Record<string, [number, number]>; bind: Record<string, Binding>;
  /** Piece score + this slot's score for it, and the resulting weight (0 = retired from the pool). */
  score: number; weight: number;
}
export interface ResolvedSlot { node: string; jitter: number; cands: ResolvedCand[] }
export interface ResolvedEvolve {
  slots: ResolvedSlot[];
  /** Ticks per step boundary; `section`: step on song-section changes, at least every `most` units. */
  unit: number; section: boolean; most: number;
  transition: string; beats: number;
  /** Hash of the pools and weights in effect (joins the scene hash). */
  scoresHash: number;
}

/** Which candidate each slot shows at step k, and the step that brought it in (seeds its params; 0 = as written). */
export interface EvolveState { k: number; pick: number[]; seeds: number[] }

const strHash = (s: string): number => fnv(FNV0, Array.from(s, (c) => c.charCodeAt(0)));
const outType = (g: SceneGraph, reg: Registry, ref: string): PortType | undefined => {
  const [n, p] = splitRef(ref), node = g.nodes.find((x) => x.id === n);
  return node ? reg.get(node.piece)?.manifest.ports.out[p]?.type : undefined;
};

/** Why `def` can't take slot `node`'s place in `g` (null = it fits): same GPU inputs and every output read downstream. */
export function fitError(g: SceneGraph, node: string, def: PieceDef | undefined, reg: Registry): string | null {
  if (!def) return 'unknown piece';
  const m = def.manifest, ins = m.ports.in ?? {}, fed = new Set<string>();
  if (m.id === 'core-transition' || m.id === 'core-post') return 'show-only piece';
  for (const e of g.edges) {
    const [tn, tp] = splitRef(e.to);
    if (tn !== node) continue;
    const t = outType(g, reg, e.from);
    if (t && ins[tp]?.type === t) fed.add(tp);
    else if (t && !CPU_PORTS.includes(t)) return `no ${t} input ${tp}`;
  }
  for (const [p, s] of Object.entries(ins)) if (!s.optional && !fed.has(p)) return `input ${p} would not be connected`;
  const base = g.nodes.find((x) => x.id === node), bdef = base && reg.get(base.piece);
  const reads = [...g.edges.map((e) => e.from), g.out, ...g.nodes.flatMap((n) => Object.values(n.bind ?? {}).map((b) => b.from))];
  for (const r of reads) {
    const [n, p] = splitRef(r);
    if (n !== node) continue;
    const want = bdef?.manifest.ports.out[p]?.type;
    if (m.ports.out[p]?.type !== want) return `no ${want} output ${p}`;
  }
  return null;
}

/** Pools expanded (explicit entries, then the filter by score), port-checked, capped and weighted. */
export function resolveEvolve(g: SceneGraph, reg: Registry, scores: EvolveScores = NO_SCORES): ResolvedEvolve {
  const e = g.evolve!, every = e.every ?? 'phrase';
  const bars = every === 'bar' ? 1 : every === 'phrase' || every === 'section' ? 4 : every;
  const scoreOf = (node: string, piece: string) => (scores.pieces[piece] ?? 0) + (scores.slots?.[g.id]?.[node]?.[piece] ?? 0);
  const slots: ResolvedSlot[] = (e.slots ?? []).map((s) => {
    const base = g.nodes.find((n) => n.id === s.node), cap = Math.max(1, Math.min(MAX_POOL, s.max ?? MAX_POOL));
    const cands: EvolveCandidate[] = base ? [{ piece: base.piece, params: base.params, bind: base.bind }] : [];
    for (const c of s.pool ?? []) {
      const x = typeof c === 'string' ? { piece: c } : c;
      if (!fitError(g, s.node, reg.get(x.piece), reg)) cands.push(x);
    }
    if (s.filter && base) {
      const f = s.filter, kind = f.kind ?? reg.get(base.piece)?.manifest.kind, have = new Set(cands.map((c) => c.piece));
      const found = [...reg.values()].map((d) => d.manifest).filter((m) => m.kind === kind && !have.has(m.id) && !(f.exclude ?? []).includes(m.id)
        && (!f.tags?.length || f.tags.some((t) => m.tags?.includes(t))) && (!f.vendor?.length || f.vendor.includes(m.author.vendor))
        && !fitError(g, s.node, reg.get(m.id), reg));
      found.sort((a, b) => scoreOf(s.node, b.id) - scoreOf(s.node, a.id) || (a.id < b.id ? -1 : 1));
      cands.push(...found.map((m) => ({ piece: m.id })));
    }
    const rs = cands.slice(0, cap).map((c): ResolvedCand => {
      const sc = scoreOf(s.node, c.piece);
      return { piece: c.piece, params: { ...c.params }, ranges: { ...c.ranges }, bind: { ...c.bind }, score: sc, weight: sc <= RETIRE_AT ? 0 : weight(sc) };
    });
    if (rs.length && rs.every((c) => c.weight === 0)) rs.forEach((c) => { c.weight = 1; });
    return { node: s.node, jitter: Math.max(0, Math.min(0.5, s.jitter ?? DEFAULT_JITTER)), cands: rs };
  });
  const scoresHash = strHash(JSON.stringify(slots.map((s) => [s.node, s.cands.map((c) => [c.piece, c.weight])])));
  return { slots, unit: bars * BAR_TICKS, section: every === 'section', most: Math.max(1, Math.min(16, e.most ?? 4)), transition: e.transition ?? 'core-blend', beats: e.beats ?? 4, scoresHash };
}

/** The scene with its evolve block resolved against `scores` (what loaders do; sceneCpu falls back to no scores). */
export const withEvolve = (g: SceneGraph, reg: Registry, scores: EvolveScores = NO_SCORES): SceneGraph =>
  g.evolve ? { ...g, evolved: resolveEvolve(g, reg, scores) } : g;

const unit32 = (x: number) => (x >>> 0) / 4294967296;

/** Weighted pick of a candidate index, never `not` while another has weight. */
function pickCand(s: ResolvedSlot, r: number, not: number): number {
  const ok = s.cands.map((c, i) => (i === not ? 0 : c.weight));
  if (!ok.some((w) => w > 0)) return not < 0 ? 0 : not;
  const total = ok.reduce((a, b) => a + b, 0);
  let x = r * total;
  for (let i = 0; i < ok.length; i++) { if (!ok[i]) continue; x -= ok[i]; if (x < 0) return i; }
  for (let i = ok.length - 1; i >= 0; i--) if (ok[i] > 0) return i;
  return 0;
}

/**
 * The state at step k: a walk that swaps one slot per step (slots in turn; the candidate weighted, never the one it has),
 * restarting every EPOCH steps from a fresh weighted draw (step 0: every slot shows its base node).
 */
export function stateAt(ev: ResolvedEvolve, idHash: number, k: number): EvolveState {
  k = Math.max(0, Math.floor(k));
  const n = ev.slots.length, e = Math.floor(k / EPOCH) * EPOCH, pick = new Array<number>(n).fill(0), seeds = new Array<number>(n).fill(0);
  const movable = ev.slots.flatMap((s, i) => (s.cands.filter((c) => c.weight > 0).length > 1 ? [i] : []));
  if (e > 0) for (const i of movable) { pick[i] = pickCand(ev.slots[i], unit32(h32(h32(idHash, e), 0x100 + i)), -1); seeds[i] = e; }
  for (let j = e + 1; j <= k && movable.length; j++) {
    // the slots take turns (from a per-scene offset), so every one of them evolves
    const i = movable[((j - 1) + (idHash >>> 0)) % movable.length];
    pick[i] = pickCand(ev.slots[i], unit32(h32(h32(idHash, j), 2)), pick[i]);
    seeds[i] = j;
  }
  return { k, pick, seeds };
}

const round3 = (v: number) => Math.round(v * 1000) / 1000;

/** Slot i's params for candidate c brought in at step `seed`: fixed params, then ranges drawn, other floats jittered. */
export function drawParams(ev: ResolvedEvolve, i: number, c: number, seed: number, idHash: number, reg: Registry): Record<string, ParamValue> {
  const s = ev.slots[i], cand = s.cands[c], specs = reg.get(cand.piece)?.manifest.params ?? {}, P: Record<string, ParamValue> = { ...cand.params };
  if (seed === 0) return P;
  const u = (name: string) => unit32(h32(h32(h32(idHash, seed), 0x200 + i), strHash(name)));
  for (const [k, [lo, hi]] of Object.entries(cand.ranges)) {
    const sp = specs[k];
    if (!sp) continue;
    if (sp.type === 'float') P[k] = round3(lo + u(k) * (hi - lo));
    else if (sp.type === 'int' || sp.type === 'enum') P[k] = Math.min(hi, lo + Math.floor(u(k) * (hi - lo + 1)));
  }
  if (s.jitter > 0) {
    for (const [k, sp] of Object.entries(specs)) {
      if (sp.type !== 'float' || k in cand.ranges || k in cand.bind) continue;
      const v0 = typeof P[k] === 'number' ? (P[k] as number) : (sp.default as number);
      P[k] = round3(Math.max(sp.min!, Math.min(sp.max!, v0 + (u(k) - 0.5) * 2 * s.jitter * (sp.max! - sp.min!))));
    }
  }
  return P;
}

/** What one slot shows: a candidate index and its params. */
export interface SlotChoice { c: number; params: Record<string, ParamValue> }

/** The choices of a state (params drawn). */
export const choicesOf = (ev: ResolvedEvolve, st: EvolveState, idHash: number, reg: Registry): SlotChoice[] =>
  ev.slots.map((_, i) => ({ c: st.pick[i], params: drawParams(ev, i, st.pick[i], st.seeds[i], idHash, reg) }));

/** The scene without its evolve block (what every state patches). */
export function stripEvolve(g: SceneGraph): SceneGraph {
  const { evolve: _e, evolved: _r, ...rest } = g;
  return rest;
}

/**
 * The graph with each slot showing its choice: the candidate's piece and params; the base node's bindings
 * carry over to params of the same name (the candidate's own win); edges into the slot stay where the
 * candidate has a same-typed input (CPU ones it lacks are dropped).
 */
export function applyChoices(g: SceneGraph, ev: ResolvedEvolve, choices: SlotChoice[], reg: Registry): SceneGraph {
  const base = stripEvolve(g), types = new Map(base.edges.map((e) => [e.to, outType(base, reg, e.from)]));
  const bySlot = new Map(ev.slots.map((s, i) => [s.node, { s, ch: choices[i] }]));
  const nodes: GraphNode[] = base.nodes.map((n) => {
    const x = bySlot.get(n.id);
    if (!x) return n;
    const cand = x.s.cands[x.ch.c], specs = reg.get(cand.piece)?.manifest.params ?? {}, bind: Record<string, Binding> = {};
    for (const [k, b] of Object.entries(n.bind ?? {})) if (specs[k]?.type === 'float' || specs[k]?.type === 'int') bind[k] = b;
    Object.assign(bind, cand.bind);
    const o: GraphNode = { id: n.id, piece: cand.piece };
    if (Object.keys(x.ch.params).length) o.params = { ...x.ch.params };
    if (Object.keys(bind).length) o.bind = bind;
    return o;
  });
  const edges = base.edges.filter((e) => {
    const [tn, tp] = splitRef(e.to), x = bySlot.get(tn);
    if (!x) return true;
    return reg.get(x.s.cands[x.ch.c].piece)?.manifest.ports.in?.[tp]?.type === types.get(e.to);
  });
  // a style pack's palette feeds every palette input: a candidate's too
  if (base.nodes.some((n) => n.id === 'style_palette')) {
    for (const [node, x] of bySlot) {
      for (const [p, sp] of Object.entries(reg.get(x.s.cands[x.ch.c].piece)?.manifest.ports.in ?? {})) {
        if (sp.type === 'palette' && !edges.some((e) => e.to === `${node}.${p}`)) edges.push({ from: 'style_palette.palette', to: `${node}.${p}` });
      }
    }
  }
  return { ...base, nodes, edges };
}

/** The graph of state `st`. */
export const stateGraph = (g: SceneGraph, ev: ResolvedEvolve, st: EvolveState, idHash: number, reg: Registry): SceneGraph =>
  applyChoices(g, ev, choicesOf(ev, st, idHash, reg), reg);

/** The base graph with only slot i on candidate c (as written): every candidate's node, for building them at load. */
export const candidateGraph = (g: SceneGraph, ev: ResolvedEvolve, i: number, c: number, reg: Registry): SceneGraph =>
  applyChoices(g, ev, ev.slots.map((s, j) => ({ c: j === i ? c : 0, params: { ...s.cands[j === i ? c : 0].params } })), reg);

/** A short id for the pieces a state shows: "gen=claude-fire,fx=core-kaleido" (#c when a pool repeats a piece). */
export function stateKey(ev: ResolvedEvolve, pick: number[]): string {
  return ev.slots.map((s, i) => {
    const p = s.cands[pick[i]]?.piece ?? '?', dup = s.cands.filter((c) => c.piece === p).length > 1;
    return `${s.node}=${p}${dup ? `#${pick[i]}` : ''}`;
  }).join(',');
}

/** What a vote records about the state on screen (lab/AGENTS.md "Evolving scenes"). */
export interface EvolveInfo { step: number; key: string; slots: Record<string, { piece: string; params: Record<string, ParamValue> }> }
export function stateInfo(ev: ResolvedEvolve, st: EvolveState, idHash: number, reg: Registry): EvolveInfo {
  const ch = choicesOf(ev, st, idHash, reg);
  return { step: st.k, key: stateKey(ev, st.pick), slots: Object.fromEntries(ev.slots.map((s, i) => [s.node, { piece: s.cands[ch[i].c].piece, params: ch[i].params }])) };
}

// ---- steps on the beat grid ----

/** The step index at boundary tick b (a multiple of the unit). */
function stepIndex(ev: ResolvedEvolve, b: number, F: FeatureSource, song: Map<number, number>): number {
  const p = Math.floor(b / ev.unit);
  if (p <= 0) return 0;
  if (!ev.section) return p;
  const at = (j: number) => { let v = song.get(j); if (v === undefined) song.set(j, (v = sectionAt(F, j * ev.unit))); return v; };
  const floor = Math.floor(p / ev.most) * ev.most;
  for (let j = p; j > floor; j--) if (at(j) !== at(j - 1)) return j;
  return floor;
}

/** Forced steps (the lab): from each `at` on, step `idx + 1` (idx -1 = s0, the base), blending as usual. */
export type EvolveForce = { at: number; idx: number }[];

export interface EvolveStep { k: number; prev: number; at: number; trans: TransSched }
const CUT: TransSched = { type: CUT_ID, ticks: 0, seed: 0, tpb: TICKS_PER_BEAT };

function transInto(ev: ResolvedEvolve, at: number, max: number, idHash: number): TransSched {
  let type = ev.transition;
  const seed = h32(h32(idHash, at), 0xe701) >>> 0;
  if (type === 'random') { const all = transEffects(); type = all[seed % all.length] ?? 'core-blend'; }
  if (!transEntry(type)) type = 'core-blend';
  const ticks = Math.min(max, Math.round(ev.beats * TICKS_PER_BEAT));
  return type === CUT_ID || ticks <= 0 ? CUT : { type, ticks, seed, tpb: TICKS_PER_BEAT };
}

/** The step showing at integer `tick`, the one before it and how the swap blends in. With `force`, the lab's plan. */
export function evolveStep(ev: ResolvedEvolve, tick: number, F: FeatureSource, idHash: number, force?: EvolveForce | null): EvolveStep {
  if (force?.length) {
    let i = -1;
    while (i + 1 < force.length && force[i + 1].at <= tick) i++;
    if (i < 0) return { k: force[0].idx + 1, prev: force[0].idx + 1, at: force[0].at, trans: CUT };
    const cur = force[i], prev = i > 0 ? force[i - 1].idx : cur.idx, next = force[i + 1]?.at ?? Infinity;
    return { k: cur.idx + 1, prev: prev + 1, at: cur.at, trans: prev === cur.idx ? CUT : transInto(ev, cur.at, Math.floor((next - cur.at) / 2), idHash) };
  }
  const b = boundary(tick, ev.unit), song = new Map<number, number>(), k = stepIndex(ev, b, F, song), prev = stepIndex(ev, b - ev.unit, F, song);
  // at most half the unit: each state shows on its own for a while (and only renders once)
  return { k, prev, at: b, trans: k === prev ? CUT : transInto(ev, b, Math.floor(ev.unit / 2), idHash) };
}

/** The blend running at `tick` (+ sub/256), or null when one state simply shows. */
export function evolveTransition(st: EvolveStep, tick: number, F: FeatureSource, sub = 0): Transition | null {
  if (st.trans.type === CUT_ID) return null;
  const sched: SceneSched = { id: String(st.k), prev: String(st.prev), at: st.at, trans: st.trans, earlier: [] };
  return transitionAt(sched, tick, F, sub);
}

/** Lab labels: s0 (the base) .. s{LAB_STEPS - 1}. */
export const labSteps = (): string[] => Array.from({ length: LAB_STEPS }, (_, i) => `s${i}`);

// ---- validation ----

interface Helpers { validateScene: (g: SceneGraph, reg: Registry) => string[]; order: (g: SceneGraph) => string[] | null }

/** Problems with a scene's `evolve` block: format, ports fit, pools non-empty, every candidate's graph valid. */
export function validateEvolve(g: SceneGraph, reg: Registry, h: Helpers): string[] {
  const e = g.evolve, errs: string[] = [], err = (x: string) => errs.push(`${g.id ?? '?'}: evolve: ${x}`);
  if (!e) return errs;
  if (g.sections) err('a scene has sections or evolve, not both');
  if (typeof e !== 'object' || !Array.isArray(e.slots) || !e.slots.length) { err('slots must be a non-empty array'); return errs; }
  if (e.slots.length > MAX_SLOTS) err(`at most ${MAX_SLOTS} slots`);
  const ev = e.every;
  if (ev !== undefined && ev !== 'bar' && ev !== 'phrase' && ev !== 'section' && !(Number.isInteger(ev) && (ev as number) >= 1 && (ev as number) <= 16)) err('every must be "bar", "phrase", "section" or 1..16 bars');
  if (e.most !== undefined && !(Number.isInteger(e.most) && e.most >= 1 && e.most <= 16)) err('most must be 1..16 phrases');
  if (e.most !== undefined && ev !== 'section') err('most only applies with every "section"');
  if (e.transition !== undefined && e.transition !== 'random') {
    let known = true;
    try { known = typeof e.transition === 'string' && !!transEntry(e.transition); } catch { /* registry not installed */ }
    if (!known) err(`transition ${String(e.transition)} is not a registered id or "random"`);
  }
  if (e.beats !== undefined && !(typeof e.beats === 'number' && e.beats >= 0 && e.beats <= 16)) err('beats must be 0..16');
  const used = h.order(stripEvolve(g)) ?? [], seen = new Set<string>();
  for (const s of e.slots) {
    const at = `slot ${s?.node ?? '?'}: `;
    if (!s || typeof s.node !== 'string') { err('every slot needs a node'); continue; }
    if (seen.has(s.node)) err(`${at}listed twice`);
    seen.add(s.node);
    if (!g.nodes.some((n) => n.id === s.node)) { err(`${at}no such node`); continue; }
    if (!used.includes(s.node)) err(`${at}not on the way to out`);
    if (s.max !== undefined && !(Number.isInteger(s.max) && s.max >= 2 && s.max <= MAX_POOL)) err(`${at}max must be 2..${MAX_POOL}`);
    if (s.jitter !== undefined && !(typeof s.jitter === 'number' && s.jitter >= 0 && s.jitter <= 0.5)) err(`${at}jitter must be 0..0.5`);
    if (!s.pool?.length && !s.filter) err(`${at}needs a pool or a filter`);
    for (const c of s.pool ?? []) {
      const x = typeof c === 'string' ? { piece: c } as EvolveCandidate : c, def = reg.get(x?.piece);
      if (!x || typeof x.piece !== 'string') { err(`${at}pool entries are piece ids or { piece, params, ranges, bind }`); continue; }
      const why = fitError(g, s.node, def, reg);
      if (why) { err(`${at}${x.piece} doesn't fit: ${why}`); continue; }
      const specs = def!.manifest.params ?? {};
      for (const [k, r] of Object.entries(x.ranges ?? {})) {
        const sp = specs[k];
        if (!sp) { err(`${at}${x.piece}: range for unknown param ${k}`); continue; }
        if (!['float', 'int', 'enum'].includes(sp.type)) err(`${at}${x.piece}: range ${k} needs a float, int or enum param`);
        const [lo, hi] = Array.isArray(r) ? r : [NaN, NaN], max = sp.type === 'enum' ? sp.options!.length - 1 : sp.max!, min = sp.type === 'enum' ? 0 : sp.min!;
        if (!(Number.isFinite(lo) && Number.isFinite(hi) && lo <= hi && lo >= min && hi <= max)) err(`${at}${x.piece}: range ${k} must be [lo, hi] within [${min}, ${max}]`);
      }
    }
    if (s.filter) {
      const f = s.filter;
      if (f.kind !== undefined && !PIECE_KINDS.includes(f.kind as never)) err(`${at}filter.kind ${f.kind}: one of ${PIECE_KINDS.join(', ')}`);
      for (const k of Object.keys(f)) if (!['kind', 'tags', 'vendor', 'exclude'].includes(k)) err(`${at}filter: unknown key ${k}`);
    }
  }
  if (errs.length) return errs;
  const r = resolveEvolve(g, reg);
  r.slots.forEach((s, i) => {
    if (s.cands.length < 2) err(`slot ${s.node}: the pool is empty (nothing but the base fits)`);
    for (let c = 1; c < s.cands.length; c++) {
      // the candidate as written, and with its ranges at both ends
      const lo = { ...s.cands[c].params }, hi = { ...s.cands[c].params };
      for (const [k, [a, b]] of Object.entries(s.cands[c].ranges)) { lo[k] = a; hi[k] = b; }
      for (const params of [s.cands[c].params, lo, hi]) {
        const graph = applyChoices(g, r, r.slots.map((x, j) => ({ c: j === i ? c : 0, params: j === i ? params : { ...x.cands[0].params } })), reg);
        for (const x of h.validateScene(graph, reg)) errs.push(x.replace(`${g.id}: `, `${g.id}: evolve ${s.node}=${s.cands[c].piece}: `));
      }
    }
  });
  return [...new Set(errs)];
}

// ---- freeze ----

/**
 * A liked state as a scene of its own (`lab evolve freeze`): the raw scene with every slot on its piece
 * and params, no evolve block, `parent` = the evolving scene, version 1.
 */
export function freezeScene(raw: SceneGraph, reg: Registry, info: Pick<EvolveInfo, 'slots'>, o: { id: string; name?: string; created: string; model?: string }): SceneGraph {
  const ev = resolveEvolve(raw, reg);
  const choices = ev.slots.map((s): SlotChoice => {
    const want = info.slots[s.node];
    if (!want) return { c: 0, params: { ...s.cands[0].params } };
    const c = s.cands.findIndex((x) => x.piece === want.piece);
    if (c < 0) throw new Error(`${raw.id}: slot ${s.node} has no candidate ${want.piece} (pool: ${s.cands.map((x) => x.piece).join(', ')})`);
    return { c, params: { ...want.params } };
  });
  const g = applyChoices(raw, ev, choices, reg);
  const { sections: _s, expanded: _x, ...rest } = g;
  return {
    ...rest, id: o.id, name: o.name ?? `${raw.name} (frozen)`, version: 1, parent: raw.id, status: 'live', created: o.created,
    author: { vendor: raw.author.vendor, model: o.model ?? raw.author.model },
  };
}
