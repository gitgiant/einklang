// Scene sections ("acts"): a scene's graph changes with the music. `sections.variants` are patches of
// the base graph (params, bindings, nodes added / removed / replaced, rewired edges, out, post), each
// with a `when` (song structure, a signal threshold, a MIDI note / CC, the room's cue). At every
// boundary (bar, phrase or N bars on the fixed beat grid from tick 0) the first variant whose `when`
// holds is chosen, none = the base graph; a change blends in with a registered transition over the
// first beats of the unit. The active variant is a pure function of the tick, the features and the
// inputs, so every host shows the same one, and it joins the scene's hash (scene.ts).
import { K_CUE, K_NOTE, K_P0, N_PARAMS, TICKS_PER_BEAT } from '../constants.ts';
import type { FeatureSource } from '../features.ts';
import { h32 } from '../math.ts';
import type { SceneSched, TransSched } from '../protocol.ts';
import { BAR_TICKS, SONG_SECTIONS, boundary, sectionAt } from '../songform.ts';
import { CUT_ID, transEffects, transEntry, transitionAt, type Transition } from '../transitions.ts';
import { POST_KEYS } from '../post.ts';
import { labSteps } from './evolve.ts';
import { splitRef, type GraphNode, type PortRef, type SceneGraph, type SectionVariant, type SectionWhen, type Sections } from './types.ts';

/** The id of the base graph among the sections. */
export const BASE = 'base';
const NAME = /^[a-z_][a-z0-9_]*$/;
const WHEN_KEYS = ['section', 'signal', 'cc', 'above', 'below', 'note', 'hold', 'cue'];

/** Bars per unit: 'bar' 1, 'phrase' 4 (default), or the number. */
export const unitBars = (s: Sections): number => (s.on === 'bar' ? 1 : s.on === undefined || s.on === 'phrase' ? 4 : s.on);
export const unitTicks = (s: Sections): number => unitBars(s) * BAR_TICKS;

/** The scene without its sections (what every variant patches). */
export function stripSections(g: SceneGraph): SceneGraph {
  const { sections: _s, expanded: _e, ...rest } = g;
  return rest;
}

/** The graph of one variant: the base with the patch applied (no sections of its own). */
export function applySection(g: SceneGraph, v: SectionVariant): SceneGraph {
  const base = stripSections(g), removed = new Set(v.remove ?? []);
  let nodes: GraphNode[] = base.nodes.filter((n) => !removed.has(n.id)).map((n) => ({ ...n, params: { ...n.params }, bind: { ...n.bind } }));
  for (const n of v.nodes ?? []) {
    const i = nodes.findIndex((x) => x.id === n.id), copy = { ...n, params: { ...n.params }, bind: { ...n.bind } };
    if (i >= 0) nodes[i] = copy; else nodes.push(copy);
  }
  for (const [id, ps] of Object.entries(v.params ?? {})) { const n = nodes.find((x) => x.id === id); if (n) Object.assign(n.params!, ps); }
  for (const [id, bs] of Object.entries(v.bind ?? {})) {
    const n = nodes.find((x) => x.id === id);
    if (!n) continue;
    for (const [k, b] of Object.entries(bs)) { if (b === null) delete n.bind![k]; else n.bind![k] = b; }
  }
  nodes = nodes.map((n) => {
    const o: GraphNode = { id: n.id, piece: n.piece };
    if (Object.keys(n.params!).length) o.params = n.params;
    if (Object.keys(n.bind!).length) o.bind = n.bind;
    return o;
  });
  const cut = new Set([...(v.unwire ?? []), ...(v.edges ?? []).map((e) => e.to)]);
  const gone = (ref: PortRef) => removed.has(splitRef(ref)[0]) && !nodes.some((n) => n.id === splitRef(ref)[0]);
  const edges = [...base.edges.filter((e) => !cut.has(e.to) && !gone(e.from) && !gone(e.to)), ...(v.edges ?? [])];
  return { ...base, nodes, edges, out: v.out ?? base.out, post: v.post ? { ...base.post, ...v.post } : base.post };
}

/** [base, ...variants] as full graphs (applyStyle's expansion when it ran). */
export function sectionGraphs(g: SceneGraph): SceneGraph[] {
  if (!g.sections) return [g];
  if (g.expanded) return g.expanded;
  return [stripSections(g), ...g.sections.variants.map((v) => applySection(g, v))];
}

/** Section ids in plan order: base first. An evolving scene: the steps the lab forces, s0 (its base) .. s3. */
export const sectionIds = (g: SceneGraph): string[] => (g.evolve ? labSteps() : [BASE, ...(g.sections?.variants ?? []).map((v) => v.id)]);

/** A base-graph signal at an integer tick. */
export type Sampler = (ref: PortRef, tick: number) => number;

/** Does `w` hold at boundary `b`? `song` caches the song section for this boundary. */
function holds(w: SectionWhen, b: number, unit: number, F: FeatureSource, sample: Sampler, song: () => number): boolean {
  if (w.section !== undefined) {
    const names = Array.isArray(w.section) ? w.section : [w.section];
    if (!names.includes(SONG_SECTIONS[song()])) return false;
  }
  if (w.signal !== undefined || w.cc !== undefined) {
    const v = w.signal !== undefined ? sample(w.signal, b) : F.get(b, K_P0 + w.cc!) / 254;
    if (w.above !== undefined && !(v > w.above)) return false;
    if (w.below !== undefined && !(v < w.below)) return false;
  }
  if (w.note !== undefined) {
    const [lo, hi] = Array.isArray(w.note) ? w.note : [w.note, w.note], from = b - Math.max(1, w.hold ?? 1) * unit;
    let hit = false;
    for (let t = b; t > from && !hit; t--) { const n = F.get(t, K_NOTE) - 1; hit = n >= lo && n <= hi; }
    if (!hit) return false;
  }
  if (w.cue !== undefined && F.get(b, K_CUE) !== w.cue) return false;
  return true;
}

/** The variant index (-1 = base) chosen at boundary `b`. */
export function pickAt(s: Sections, b: number, F: FeatureSource, sample: Sampler): number {
  const unit = unitTicks(s);
  let song = -1;
  const songAt = () => (song < 0 ? (song = sectionAt(F, b)) : song);
  return s.variants.findIndex((v) => holds(v.when, b, unit, F, sample, songAt));
}

/** Forced sections (the lab): from each `at` on, variant `idx` (-1 = base), switching with the usual transition. */
export type ForcePlan = { at: number; idx: number }[];

/** Which variant shows at `tick`: idx and prev (-1 = base), the boundary it changed at, and how it blends in. */
export interface SectionStep { idx: number; prev: number; at: number; trans: TransSched }

const CUT: TransSched = { type: CUT_ID, ticks: 0, seed: 0, tpb: TICKS_PER_BEAT };

/** The transition into variant `idx` at boundary `at` (seeded by the scene and the boundary), at most `max` ticks. */
function transInto(g: SceneGraph, s: Sections, idx: number, at: number, max: number, idHash: number): TransSched {
  const v = idx >= 0 ? s.variants[idx] : undefined, beats = v?.beats ?? s.beats ?? 4;
  let type = v?.transition ?? s.transition ?? 'core-blend';
  const seed = h32(h32(idHash, at), 0x5ec7) >>> 0;
  if (type === 'random') { const all = transEffects(); type = all[seed % all.length] ?? 'core-blend'; }
  if (!transEntry(type)) type = 'core-blend';
  const ticks = Math.min(max, Math.round(beats * TICKS_PER_BEAT));
  return type === CUT_ID || ticks <= 0 ? CUT : { type, ticks, seed, tpb: TICKS_PER_BEAT };
}

/** The section step at integer `tick`. With `force`, the lab's plan replaces the boundaries and `when`. */
export function sectionStep(g: SceneGraph, tick: number, F: FeatureSource, sample: Sampler, idHash: number, force?: ForcePlan | null): SectionStep {
  const s = g.sections!;
  if (force?.length) {
    let i = -1;
    while (i + 1 < force.length && force[i + 1].at <= tick) i++;
    if (i < 0) return { idx: force[0].idx, prev: force[0].idx, at: force[0].at, trans: CUT };
    const cur = force[i], prev = i > 0 ? force[i - 1].idx : cur.idx, next = force[i + 1]?.at ?? Infinity;
    return { idx: cur.idx, prev, at: cur.at, trans: prev === cur.idx ? CUT : transInto(g, s, cur.idx, cur.at, Math.floor((next - cur.at) / 2), idHash) };
  }
  const unit = unitTicks(s), b = boundary(tick, unit), idx = pickAt(s, b, F, sample), prev = pickAt(s, b - unit, F, sample);
  return { idx, prev, at: b, trans: prev === idx ? CUT : transInto(g, s, idx, b, unit, idHash) };
}

/** The blend running at `tick` (+ sub/256), or null when one variant simply shows. */
export function sectionTransition(st: SectionStep, tick: number, F: FeatureSource, sub = 0): Transition | null {
  if (st.trans.type === CUT_ID) return null;
  const sched: SceneSched = { id: String(st.idx), prev: String(st.prev), at: st.at, trans: st.trans, earlier: [] };
  return transitionAt(sched, tick, F, sub);
}

/** Problems with a scene's `sections` (the variant graphs themselves are validated by validateScene). */
export function validateSections(g: SceneGraph): string[] {
  const s = g.sections, errs: string[] = [], err = (x: string) => errs.push(`${g.id ?? '?'}: sections: ${x}`);
  if (!s) return errs;
  if (typeof s !== 'object' || !Array.isArray(s.variants) || !s.variants.length) { err('variants must be a non-empty array'); return errs; }
  if (s.on !== undefined && s.on !== 'bar' && s.on !== 'phrase' && !(Number.isInteger(s.on) && s.on >= 1 && s.on <= 16)) err('on must be "bar", "phrase" or 1..16 bars');
  const trans = (t: unknown, where: string) => {
    if (t === undefined || t === 'random') return;
    let known = true;
    try { known = typeof t === 'string' && !!transEntry(t); } catch { /* registry not installed: skip */ }
    if (!known) err(`${where}transition ${String(t)} is not a registered id or "random"`);
  };
  const beats = (b: unknown, where: string) => { if (b !== undefined && !(typeof b === 'number' && b >= 0 && b <= 16)) err(`${where}beats must be 0..16`); };
  trans(s.transition, ''); beats(s.beats, '');
  const ids = new Set<string>();
  for (const v of s.variants) {
    const at = `variant ${v.id ?? '?'}: `;
    if (typeof v.id !== 'string' || !NAME.test(v.id) || v.id === BASE) err(`${at}id must be lower_snake and not "${BASE}"`);
    if (ids.has(v.id)) err(`${at}duplicate id`);
    ids.add(v.id);
    trans(v.transition, at); beats(v.beats, at);
    const w = v.when;
    if (!w || typeof w !== 'object' || !Object.keys(w).length) { err(`${at}needs a when`); continue; }
    for (const k of Object.keys(w)) if (!WHEN_KEYS.includes(k)) err(`${at}when: unknown key ${k}`);
    if (w.section !== undefined) for (const n of Array.isArray(w.section) ? w.section : [w.section]) if (!(SONG_SECTIONS as readonly string[]).includes(n)) err(`${at}when.section ${n}: one of ${SONG_SECTIONS.join(', ')}`);
    if (w.signal !== undefined && w.cc !== undefined) err(`${at}when: signal or cc, not both`);
    if (w.cc !== undefined && !(Number.isInteger(w.cc) && w.cc >= 0 && w.cc < N_PARAMS)) err(`${at}when.cc is a param index 0..${N_PARAMS - 1}`);
    if ((w.signal !== undefined || w.cc !== undefined) && w.above === undefined && w.below === undefined) err(`${at}when: ${w.signal !== undefined ? 'signal' : 'cc'} needs above and/or below`);
    if ((w.above !== undefined || w.below !== undefined) && w.signal === undefined && w.cc === undefined) err(`${at}when: above / below need a signal or cc`);
    for (const k of ['above', 'below'] as const) if (w[k] !== undefined && !Number.isFinite(w[k])) err(`${at}when.${k} must be a number`);
    if (w.signal !== undefined) {
      const [n] = splitRef(w.signal);
      if (!g.nodes.some((x) => x.id === n)) err(`${at}when.signal ${w.signal}: not a base-graph node`);
    }
    if (w.note !== undefined) {
      const [lo, hi] = Array.isArray(w.note) ? w.note : [w.note, w.note];
      if (!(Number.isInteger(lo) && Number.isInteger(hi) && lo >= 0 && hi <= 127 && lo <= hi)) err(`${at}when.note is a pitch 0..127 or [lo, hi]`);
    }
    if (w.hold !== undefined && !(Number.isInteger(w.hold) && w.hold >= 1 && w.hold <= 16)) err(`${at}when.hold is 1..16 units`);
    if (w.cue !== undefined && !(Number.isInteger(w.cue) && w.cue >= 1 && w.cue <= 9)) err(`${at}when.cue is 1..9`);
    for (const id of v.remove ?? []) if (!g.nodes.some((n) => n.id === id)) err(`${at}remove ${id}: no such node`);
    const after = applySection(g, v).nodes;
    for (const id of [...Object.keys(v.params ?? {}), ...Object.keys(v.bind ?? {})]) if (!after.some((n) => n.id === id)) err(`${at}params / bind for ${id}: no such node`);
    for (const k of Object.keys(v.post ?? {})) if (!(POST_KEYS as string[]).includes(k)) err(`${at}post: unknown key ${k}`);
  }
  return errs;
}

/** Signal refs the `when`s sample (validateScene checks they are signals). */
export const sampledSignals = (s: Sections): PortRef[] => s.variants.flatMap((v) => (v.when?.signal ? [v.when.signal] : []));

/** For the lab: force every section in turn over `ticks` from `start` (base first). */
export function forceAll(g: SceneGraph, start: number, ticks: number): ForcePlan {
  const n = sectionIds(g).length, seg = Math.floor(ticks / n);
  return Array.from({ length: n }, (_, i) => ({ at: start + i * seg, idx: i - 1 }));
}

export { BAR_TICKS };
