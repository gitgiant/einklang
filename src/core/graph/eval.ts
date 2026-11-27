// CPU side of a scene graph tick: modulators, color pieces and param bindings, plus the sync hash.
// Pure function of (graph, tick, features, sub), so every host resolves the same param values.
import { CPU_PORTS, type Audio, type CpuCtx, type CpuOut, type ParamValue } from '../../../lab/api/index.ts';
import { K_BAR, K_BPM, K_CUE, K_NOTE, K_ONSET, K_P0, K_PAL, K_PHASE, K_RMS, K_VEL, LOOKBACK, NB, FPS, TICKS_PER_BEAT } from '../constants.ts';
import type { FeatureSource } from '../features.ts';
import { FNV0, fnv, h32 } from '../math.ts';
import { lyricAt } from '../lrc.ts';
import { order, validateScene } from './validate.ts';
import { splitRef, type GraphNode, type PieceDef, type PortRef, type Registry, type SceneGraph } from './types.ts';

/** Feature keys that join the hash: the audio frame plus the input keys (see constants.ts). */
const HASH_KEYS = K_PAL + 1;
/** Resolved float params are hashed at this fixed-point scale. */
const Q = 4096;

export interface PlanNode { node: GraphNode; def: PieceDef; inputs: Record<string, PortRef> }
/** A validated scene ready to evaluate: nodes in order, inputs resolved to their sources. */
export interface Plan { graph: SceneGraph; order: PlanNode[]; idHash: number; byId: Map<string, PlanNode> }

export function strHash(s: string): number {
  const c = new Array<number>(s.length);
  for (let i = 0; i < s.length; i++) c[i] = s.charCodeAt(i);
  return fnv(FNV0, c);
}

/** Validate and plan a scene; throws with every problem listed. */
export function compile(g: SceneGraph, reg: Registry): Plan {
  const errs = validateScene(g, reg);
  if (errs.length) throw new Error(errs.join('\n'));
  const byId = new Map(g.nodes.map((n) => [n.id, n]));
  const inputs = new Map<string, Record<string, PortRef>>(g.nodes.map((n) => [n.id, {}]));
  for (const e of g.edges) { const [n, p] = splitRef(e.to); inputs.get(n)![p] = e.from; }
  return planOf(g, order(g)!.map((id) => ({ node: byId.get(id)!, def: reg.get(byId.get(id)!.piece)!, inputs: inputs.get(id)! })));
}

const planOf = (graph: SceneGraph, ord: PlanNode[]): Plan => ({ graph, order: ord, idHash: strHash(graph.id), byId: new Map(ord.map((pn) => [pn.node.id, pn])) });

/** The audio/input frame at tick, normalized. Without a clock, phase follows the fixed beat grid. */
export function audioAt(F: FeatureSource, tick: number): Audio {
  const bands = new Float32Array(NB);
  for (let b = 0; b < NB; b++) bands[b] = F.get(tick, b) / 255;
  const bpm = F.get(tick, K_BPM), note = F.get(tick, K_NOTE);
  const grid = ((tick % TICKS_PER_BEAT) + TICKS_PER_BEAT) % TICKS_PER_BEAT;
  return {
    bands, rms: F.get(tick, K_RMS) / 255, onset: F.get(tick, K_ONSET) > 0,
    phase: bpm ? F.get(tick, K_PHASE) / 256 : grid / TICKS_PER_BEAT,
    bar: bpm ? F.get(tick, K_BAR) : Math.floor(tick / TICKS_PER_BEAT) & 3,
    bpm: bpm || (60 * FPS) / TICKS_PER_BEAT,
    note: note ? note - 1 : -1, vel: F.get(tick, K_VEL) / 254,
    cc: [0, 1, 2, 3].map((i) => F.get(tick, K_P0 + i) / 254) as Audio['cc'],
    pal: F.get(tick, K_PAL) / 256, cue: F.get(tick, K_CUE),
  };
}

export interface CpuFrame {
  /** CPU outputs by node id. */
  outs: Map<string, CpuOut>;
  /** Resolved params by node id (defaults, then scene values, then bindings). */
  params: Map<string, Record<string, ParamValue>>;
  /** The scene's sync-hash input (fed to hashState as the uniform block). */
  hash: Int32Array;
  /** The per-tick part of every piece context (GPU drivers get it too). */
  base: BaseCtx;
  /** The node-specific helpers of each node's context (paramAt, inputAt, wired), for its GPU frame too. */
  helpers: Map<string, NodeHelpers>;
}
export type NodeHelpers = Pick<CpuCtx, 'paramAt' | 'inputAt' | 'wired'>;
export type BaseCtx = Omit<CpuCtx, 'params' | 'in' | keyof NodeHelpers>;
/** Helpers for a node run outside a scene graph (the show's transition and post): nothing to sample. */
export const noHelpers = (params: Record<string, ParamValue>, ins: Record<string, unknown>): NodeHelpers => ({
  paramAt: (n) => params[n], inputAt: () => undefined, wired: Object.keys(ins).filter((k) => ins[k] !== undefined),
});

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** The per-tick part of a piece context: time, audio (+ history), waveform, raw features, seeded noise. */
export function baseCtx(tick: number, F: FeatureSource, sub = 0, seed = 0): BaseCtx {
  const audio = audioAt(F, tick), cache = new Map<number, Audio>([[0, audio]]);
  const past = (ago: number) => {
    const a = Math.max(0, Math.min(LOOKBACK, Math.floor(ago)));
    let v = cache.get(a);
    if (!v) cache.set(a, (v = audioAt(F, tick - a)));
    return v;
  };
  let wv: Float32Array | null | undefined;
  const wave = () => {
    if (wv === undefined) { const w = F.wave(tick); wv = w ? Float32Array.from(w, (x) => x / 127) : null; }
    return wv;
  };
  return {
    tick, sub, time: (tick + sub / 256) / FPS, audio, past, wave, raw: F,
    rand: (a, b = 0) => h32(h32(a | 0, b | 0), seed) / 4294967296,
    lyric: () => lyricAt(F.lyrics, (tick + sub / 256) / FPS),
  };
}

interface NodeVal { P: Record<string, ParamValue>; o: CpuOut | undefined }

/**
 * Evaluate the CPU half of the graph at tick (+ sub/256 for drawing). The hash covers what the
 * hosts must agree on: scene id + version, tick, the feature frame, every resolved param, and
 * the state of synced pieces. Piece internals on the GPU are not hashed (free-form pieces).
 * `paramAt` / `inputAt` evaluate the graph upstream at other ticks (sub 0), memoized per call.
 */
export function evalCpu(plan: Plan, tick: number, F: FeatureSource, sub = 0): CpuFrame {
  const base = baseCtx(tick, F, sub, plan.idHash);
  const outs = new Map<string, CpuOut>(), params = new Map<string, Record<string, ParamValue>>(), helpers = new Map<string, NodeHelpers>();
  const h: number[] = [plan.idHash, plan.graph.version, tick];
  for (let k = 0; k < HASH_KEYS; k++) h.push(F.get(tick, k));
  const bases = new Map<number, BaseCtx>(), memo = new Map<string, NodeVal>();
  const baseAt = (t: number) => { let b = bases.get(t); if (!b) bases.set(t, (b = baseCtx(t, F, 0, plan.idHash))); return b; };
  if (sub === 0) bases.set(tick, base);
  /** Node `id` at integer tick t (sub 0), memoized; the main pass fills this for `tick` when sub is 0. */
  const at = (id: string, t: number): NodeVal => {
    const key = `${id}@${t}`;
    let v = memo.get(key);
    if (!v) {
      const pn = plan.byId.get(id);
      v = pn ? run(pn, t, baseAt(t), (ref) => { const [n, p] = splitRef(ref); return at(n, t).o?.[p]; }) : { P: {}, o: undefined };
      memo.set(key, v);
    }
    return v;
  };
  const resolve = (node: GraphNode, k: string, s: NonNullable<PieceDef['manifest']['params']>[string], value: (ref: PortRef) => unknown): ParamValue => {
    let v: ParamValue = node.params?.[k] ?? s.default;
    const b = node.bind?.[k];
    if (b) {
      const [lo, hi] = b.range ?? [s.min!, s.max!];
      v = Math.max(s.min!, Math.min(s.max!, lo + num(value(b.from)) * (hi - lo)));
    }
    if (s.type === 'int') v = Math.round(v as number);
    return v;
  };
  function helpersOf(pn: PlanNode, t: number, P: Record<string, ParamValue>): NodeHelpers {
    const { node, def, inputs } = pn, specs = def.manifest.params ?? {};
    return {
      wired: Object.keys(inputs),
      paramAt: (k, t2) => {
        t2 = Math.floor(t2);
        if (t2 === t && sub === 0) return P[k];
        const s = specs[k];
        return s ? resolve(node, k, s, (ref) => { const [n, p] = splitRef(ref); return at(n, t2).o?.[p]; }) : undefined as unknown as ParamValue;
      },
      inputAt: (port, t2) => { const ref = inputs[port]; if (!ref) return undefined; const [n, p] = splitRef(ref); return at(n, Math.floor(t2)).o?.[p]; },
    };
  }
  function run(pn: PlanNode, t: number, b: BaseCtx, value: (ref: PortRef) => unknown): NodeVal {
    const { node, def, inputs } = pn, specs = def.manifest.params ?? {}, P: Record<string, ParamValue> = {};
    for (const [k, s] of Object.entries(specs)) P[k] = resolve(node, k, s, value);
    const drv = def.driver;
    if (!drv?.cpu) return { P, o: undefined };
    const ins: Record<string, unknown> = {};
    for (const [p, ref] of Object.entries(inputs)) if (CPU_PORTS.includes(def.manifest.ports.in![p].type)) ins[p] = value(ref);
    return { P, o: drv.cpu({ ...b, params: P, in: ins, ...helpersOf(pn, t, P) }) };
  }
  const value = (ref: PortRef) => { const [n, p] = splitRef(ref); return outs.get(n)?.[p]; };

  for (const pn of plan.order) {
    const v = run(pn, tick, base, value), { node, def } = pn;
    for (const x of Object.values(v.P)) h.push(typeof x === 'number' ? Math.round(x * Q) | 0 : typeof x === 'boolean' ? +x : strHash(x));
    params.set(node.id, v.P);
    helpers.set(node.id, helpersOf(pn, tick, v.P));
    if (sub === 0) memo.set(`${node.id}@${tick}`, v);
    if (!v.o) continue;
    outs.set(node.id, v.o);
    if (def.manifest.synced && v.o.state) for (const x of v.o.state) h.push(x | 0);
  }
  return { outs, params, hash: Int32Array.from(h), base, helpers };
}

/** The plan cut down to node `id` and everything it depends on (inputs and bindings), in order. */
export function upstream(plan: Plan, id: string): Plan {
  const need = new Set<string>(), stack = [id];
  while (stack.length) {
    const n = stack.pop()!, pn = plan.byId.get(n);
    if (need.has(n) || !pn) continue;
    need.add(n);
    for (const r of Object.values(pn.inputs)) stack.push(splitRef(r)[0]);
    for (const b of Object.values(pn.node.bind ?? {})) stack.push(splitRef(b.from)[0]);
  }
  return planOf(plan.graph, plan.order.filter((pn) => need.has(pn.node.id)));
}

/** A CPU output of the plan at any integer tick, evaluating only what it needs (sub-plans cached). */
export function sampler(plan: Plan): (ref: PortRef, tick: number, F: FeatureSource) => number {
  const subs = new Map<string, Plan>();
  return (ref, tick, F) => {
    const [n, p] = splitRef(ref);
    let sp = subs.get(n);
    if (!sp) subs.set(n, (sp = upstream(plan, n)));
    return num(evalCpu(sp, tick, F).outs.get(n)?.[p]);
  };
}
