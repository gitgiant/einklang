// The CPU half of a whole scene, sections included: which variant shows (and which blends out), its
// CPU frame, and the sync hash. Pure function of (scene, tick, features + inputs, sub), shared by the
// browser (src/web/graph/scene.ts) and the Node tests. A scene without sections is one plan.
import type { FeatureSource } from '../features.ts';
import { type Transition } from '../transitions.ts';
import { compile, evalCpu, sampler, type CpuFrame, type Plan } from './eval.ts';
import { sectionGraphs, sectionStep, sectionTransition, type ForcePlan, type SectionStep } from './sections.ts';
import { candidateGraph, evolveStep, evolveTransition, resolveEvolve, stateAt, stateGraph, stateInfo, stripEvolve, type EvolveInfo, type EvolveStep, type ResolvedEvolve } from './evolve.ts';
import type { Registry, SceneGraph } from './types.ts';
import type { PlanNode } from './eval.ts';

export interface SceneFrame {
  /** The sync-hash input: the shown plan's hash, plus the section step and blend, plus the outgoing plan's while blending. */
  hash: Int32Array;
  /** Plan index shown (0 = base, i = variant i - 1) and its CPU frame. */
  plan: number; cur: CpuFrame;
  /** While a section blend runs: the outgoing plan, its frame, and the blend. */
  from: number; prev: CpuFrame | null; trans: Transition | null;
  step: SectionStep | null;
  /** An evolving scene: the step, the one blending out, and each slot's candidate index in both. */
  evolve?: { step: EvolveStep; pick: number[]; prevPick: number[] };
}

/** An evolving scene's slot: every candidate's plan node (index 0 = the base node), built at load. */
export interface Socket { node: string; cands: PlanNode[] }

export interface SceneCpu {
  graph: SceneGraph;
  /** [base, ...variants]. */
  plans: Plan[];
  state(tick: number, F: FeatureSource, sub?: number): SceneFrame;
  /** The lab: show these sections (or evolve steps) in turn instead of what `when` / the grid picks (null = back to normal). */
  force(plan: ForcePlan | null): void;
  /** An evolving scene: its resolved pools and every candidate's node (the GPU side builds them all at load). */
  evolve?: { ev: ResolvedEvolve; sockets: Socket[]; info(f: SceneFrame): EvolveInfo };
}

export function sceneCpu(g: SceneGraph, reg: Registry): SceneCpu {
  if (g.evolve) return evolveCpu(g, reg);
  const plans = sectionGraphs(g).map((x) => compile(x, reg)), base = plans[0];
  let forced: ForcePlan | null = null;
  if (!g.sections) {
    return {
      graph: g, plans, force: () => {},
      state: (tick, F, sub = 0) => { const cur = evalCpu(base, tick, F, sub); return { hash: cur.hash, plan: 0, cur, from: 0, prev: null, trans: null, step: null }; },
    };
  }
  const sample = sampler(base);
  return {
    graph: g, plans,
    force: (p) => { forced = p; },
    state(tick, F, sub = 0) {
      const step = sectionStep(g, tick, F, (ref, t) => sample(ref, t, F), base.idHash, forced);
      const trans = sectionTransition(step, tick, F, sub), plan = step.idx + 1, from = step.prev + 1;
      const cur = evalCpu(plans[plan], tick, F, sub), prev = trans ? evalCpu(plans[from], tick, F, sub) : null;
      const t = trans;
      const extra = [0x5ec7, step.idx, step.prev, step.at, t ? t.kind : -1, t ? t.ticks : 0, t ? t.seed | 0 : 0, t ? t.p16 : 0, t ? t.flash16 : 0, t ? t.roll : 0];
      const hash = new Int32Array(cur.hash.length + extra.length + (prev?.hash.length ?? 0));
      hash.set(cur.hash); hash.set(extra, cur.hash.length);
      if (prev) hash.set(prev.hash, cur.hash.length + extra.length);
      return { hash, plan, cur, from, prev, trans, step };
    },
  };
}

/**
 * An evolving scene: plan 0 is the base graph (the GPU runner's, with a socket per slot); each step's
 * graph is compiled when it first shows (a few kept). The hash is the step's plan hash, then [step,
 * previous, boundary, each slot's candidate now and before, the pools' scores hash, blend], then the
 * outgoing step's plan hash while blending.
 */
function evolveCpu(g: SceneGraph, reg: Registry): SceneCpu {
  const raw = stripEvolve(g), base = compile(raw, reg), ev = g.evolved ?? resolveEvolve(g, reg), id = base.idHash;
  const cache = new Map<number, Plan>();
  const planAt = (k: number): Plan => {
    let p = cache.get(k);
    if (!p) {
      if (cache.size >= 8) cache.delete(cache.keys().next().value!);
      cache.set(k, (p = k === 0 ? base : compile(stateGraph(g, ev, stateAt(ev, id, k), id, reg), reg)));
    }
    return p;
  };
  const sockets: Socket[] = ev.slots.map((s, i) => ({
    node: s.node,
    cands: s.cands.map((_, c) => (c === 0 ? base : compile(candidateGraph(g, ev, i, c, reg), reg)).byId.get(s.node)!),
  }));
  let forced: ForcePlan | null = null;
  return {
    graph: g, plans: [base],
    force: (p) => { forced = p; },
    evolve: { ev, sockets, info: (f) => stateInfo(ev, stateAt(ev, id, f.evolve!.step.k), id, reg) },
    state(tick, F, sub = 0) {
      const step = evolveStep(ev, tick, F, id, forced), trans = evolveTransition(step, tick, F, sub);
      const sc = stateAt(ev, id, step.k), sp = step.prev === step.k ? sc : stateAt(ev, id, step.prev);
      const cur = evalCpu(planAt(step.k), tick, F, sub), prev = trans ? evalCpu(planAt(step.prev), tick, F, sub) : null;
      const t = trans;
      const extra = [0xe701, step.k, step.prev, step.at, ...sc.pick, ...sp.pick, ev.scoresHash | 0, t ? t.kind : -1, t ? t.ticks : 0, t ? t.seed | 0 : 0, t ? t.p16 : 0, t ? t.flash16 : 0, t ? t.roll : 0];
      const hash = new Int32Array(cur.hash.length + extra.length + (prev?.hash.length ?? 0));
      hash.set(cur.hash); hash.set(extra, cur.hash.length);
      if (prev) hash.set(prev.hash, cur.hash.length + extra.length);
      return { hash, plan: 0, cur, from: 0, prev, trans, step: null, evolve: { step, pick: sc.pick, prevPick: sp.pick } };
    },
  };
}
