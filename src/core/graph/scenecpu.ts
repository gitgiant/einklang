// The CPU half of a whole scene, sections included: which variant shows (and which blends out), its
// CPU frame, and the sync hash. Pure function of (scene, tick, features + inputs, sub), shared by the
// browser (src/web/graph/scene.ts) and the Node tests. A scene without sections is one plan.
import type { FeatureSource } from '../features.ts';
import { type Transition } from '../transitions.ts';
import { compile, evalCpu, sampler, type CpuFrame, type Plan } from './eval.ts';
import { sectionGraphs, sectionStep, sectionTransition, type ForcePlan, type SectionStep } from './sections.ts';
import type { Registry, SceneGraph } from './types.ts';

export interface SceneFrame {
  /** The sync-hash input: the shown plan's hash, plus the section step and blend, plus the outgoing plan's while blending. */
  hash: Int32Array;
  /** Plan index shown (0 = base, i = variant i - 1) and its CPU frame. */
  plan: number; cur: CpuFrame;
  /** While a section blend runs: the outgoing plan, its frame, and the blend. */
  from: number; prev: CpuFrame | null; trans: Transition | null;
  step: SectionStep | null;
}

export interface SceneCpu {
  graph: SceneGraph;
  /** [base, ...variants]. */
  plans: Plan[];
  state(tick: number, F: FeatureSource, sub?: number): SceneFrame;
  /** The lab: show these sections in turn instead of what `when` picks (null = back to normal). */
  force(plan: ForcePlan | null): void;
}

export function sceneCpu(g: SceneGraph, reg: Registry): SceneCpu {
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
