// A scene = a lab scene graph (lab/scenes/*.json), v1 scenes included. The Engine evaluates its
// CPU half for the hash and runs its GPU half into an HDR target; the show graph (transition and
// post nodes) takes it from there. A scene with sections holds every variant (one runner, shared
// nodes built once, all at load) and mixes a section change with its own core-transition node.
import type { PadFx } from '../../../lab/api/index.ts';
import type { SceneDef, SceneState } from '../../core/scene.ts';
import type { FeatureSource } from '../../core/features.ts';
import { noHelpers } from '../../core/graph/eval.ts';
import type { Registry, SceneGraph } from '../../core/graph/types.ts';
import { sceneCpu, type SceneFrame } from '../../core/graph/scenecpu.ts';
import { sectionGraphs, sectionIds, type ForcePlan } from '../../core/graph/sections.ts';
import type { EvolveInfo } from '../../core/graph/evolve.ts';
import { transEntry } from '../../core/transitions.ts';
import { POST_DEFAULT, mixPost, type PostParams } from '../../core/post.ts';
import { DEFAULT_PRESETS } from '../../core/protocol.ts';
import { GraphRunner, instantiate, type Budget } from './runner.ts';
import { LAB_SCENES, REGISTRY } from './registry.ts';

export interface GraphScene {
  readonly def: SceneDef;
  /** Settings for the show's post node: the shown section's (blended during a section change), as of the last encode. */
  readonly post: PostParams;
  readonly graph: SceneGraph;
  /** Encode the scene's GPU work for `state` (from def.state) into the HDR target. */
  encode(enc: GPUCommandEncoder, target: GPUTexture, state: SceneState, tick: number, F: FeatureSource, sub: number, pads: PadFx): void;
  /** Allocate the targets a w x h frame needs ahead of the first one (a switch to this scene is coming). */
  prepare(w: number, h: number): void;
  /** Sims only: particles this GPU can run. */
  bench?(): Promise<number>;
  /** Inputs for ticks >= `tick` changed after the fact (sims rewind and replay). */
  invalidate(tick: number): void;
  status(): string;
  /** Section ids, base first ([] without sections). */
  readonly sections: string[];
  /** The section shown in the last state (null without sections) and the one blending out, if any. */
  section(): { id: string; from: string | null } | null;
  /** The lab: force sections (or evolve steps) in turn (null = back to `when` / the grid). */
  force(plan: ForcePlan | null): void;
  /** An evolving scene: the state shown in the last state (what a vote records), else null. */
  evolve(): EvolveInfo | null;
}

export function graphScene(device: GPUDevice, g: SceneGraph, budget: Budget, reg: Registry = REGISTRY): GraphScene {
  const cpu = sceneCpu(g, reg), graphs = g.evolve ? [g] : sectionGraphs(g), evo = cpu.evolve;
  // an evolving scene: every slot is a socket holding all its candidates, swaps blended by a transition of its own
  const runner = new GraphRunner(device, cpu.plans, budget, evo ? { sockets: evo.sockets, mixer: reg.get('core-transition') } : {});
  const posts = graphs.map((x) => ({ ...POST_DEFAULT, ...x.post }));
  const ids = g.sections || g.evolve ? sectionIds(g) : [];
  const picks = (p: number[]) => Object.fromEntries(evo!.ev.slots.map((s, i) => [s.node, p[i]]));
  /** Section blends: the two variants' targets and a transition node of the scene's own. */
  const mix = g.sections ? instantiate(device, reg.get('core-transition')!, budget) : null;
  let pair: [GPUTexture, GPUTexture] | null = null;
  const pairFor = (w: number, h: number) => {
    if (!pair || pair[0].width !== w || pair[0].height !== h) {
      pair?.forEach((t) => t.destroy());
      const usage = GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC;
      pair = [0, 1].map((i) => device.createTexture({ size: [w, h], format: 'rgba16float', label: `${g.id}.section${i}`, usage })) as [GPUTexture, GPUTexture];
    }
    return pair;
  };
  /** The CPU frame behind each state handed out, so encode doesn't evaluate it again. */
  const frames = new WeakMap<SceneState, SceneFrame>();
  let last: SceneFrame | null = null, post = posts[0];
  const def: SceneDef = {
    id: g.id, name: g.name,
    state(f: number, F: FeatureSource, sub = 0): SceneState {
      const sf = cpu.state(f, F, sub), s: SceneState = { u: sf.hash, prims: null };
      frames.set(s, sf);
      last = sf;
      return s;
    },
  };
  return {
    def, graph: g, sections: ids,
    get post() { return post; },
    encode(enc, target, s, tick, F, sub, pads) {
      const sf = frames.get(s) ?? cpu.state(tick, F, sub), tr = sf.trans;
      if (sf.evolve) {
        const e = sf.evolve, blend = tr && sf.prev ? { frame: sf.prev, pick: picks(e.prevPick), trans: tr } : undefined;
        runner.encodeJobs(enc, [{ plan: 0, target, frame: sf.cur, pick: picks(e.pick), blend }], pads);
        post = posts[0];
        return;
      }
      if (!tr || !mix) {
        runner.encodeJobs(enc, [{ plan: sf.plan, target, frame: sf.cur }], pads);
        post = posts[sf.plan];
        return;
      }
      const [ta, tb] = pairFor(target.width, target.height);
      runner.encodeJobs(enc, [{ plan: sf.from, target: ta, frame: sf.prev! }, { plan: sf.plan, target: tb, frame: sf.cur }], pads);
      const params = { type: tr.kind, p: tr.p, flash: tr.flash16 / 65536, seed: tr.seed, roll: tr.roll, pads: true };
      const ins = { a: ta, b: tb };
      mix.frame({ ...sf.cur.base, ...noHelpers(params, ins), params, in: ins, device, enc, width: target.width, height: target.height, out: { out: target }, cpu: {}, pads });
      post = mixPost(posts[sf.from], posts[sf.plan], tr.p);
      const trails = transEntry(tr.type)?.trails;
      if (trails) post = { ...post, decay: Math.max(post.decay, trails * Math.min(1, 6.4 * tr.p * (1 - tr.p))) };
    },
    prepare: (w, h) => { runner.prepare(w, h); if (mix) pairFor(w, h); },
    bench: runner.hasBench ? async () => (await runner.bench())! : undefined,
    invalidate: (t) => runner.invalidate(t),
    status: () => runner.status(),
    section: () => (last?.evolve ? { id: `s${last.evolve.step.k}`, from: last.trans ? `s${last.evolve.step.prev}` : null }
      : last?.step ? { id: ids[last.plan], from: last.trans ? ids[last.from] : null } : null),
    force: (p) => cpu.force(p),
    evolve: () => (last?.evolve && evo ? evo.info(last) : null),
  };
}

/** Every lab scene that compiles, the room's default presets first; broken ones are logged and skipped. */
export function labScenes(device: GPUDevice, budget: Budget): GraphScene[] {
  const rank = (id: string) => { const i = DEFAULT_PRESETS.indexOf(id); return i < 0 ? DEFAULT_PRESETS.length : i; };
  const out: GraphScene[] = [];
  for (const g of [...LAB_SCENES].sort((a, b) => rank(a.id) - rank(b.id))) {
    try { out.push(graphScene(device, g, budget)); } catch (e) { console.error(`lab scene ${g.id} skipped:\n${(e as Error).message}`); }
  }
  return out;
}
