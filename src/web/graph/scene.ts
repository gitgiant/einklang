// A scene = a lab scene graph (lab/scenes/*.json), v1 scenes included. The Engine evaluates its
// CPU half for the hash and runs its GPU half into an HDR target; the show graph (transition and
// post nodes) takes it from there.
import type { PadFx } from '../../../lab/api/index.ts';
import type { SceneDef, SceneState } from '../../core/scene.ts';
import type { FeatureSource } from '../../core/features.ts';
import { compile, evalCpu, type CpuFrame } from '../../core/graph/eval.ts';
import type { Registry, SceneGraph } from '../../core/graph/types.ts';
import { POST_DEFAULT, type PostParams } from '../../core/post.ts';
import { DEFAULT_PRESETS } from '../../core/protocol.ts';
import { GraphRunner, type Budget } from './runner.ts';
import { LAB_SCENES, REGISTRY } from './registry.ts';

export interface GraphScene {
  readonly def: SceneDef;
  /** Settings for the show's post node. */
  readonly post: PostParams;
  readonly graph: SceneGraph;
  /** Encode the scene's GPU work for `state` (from def.state) into the HDR target. */
  encode(enc: GPUCommandEncoder, target: GPUTexture, state: SceneState, tick: number, F: FeatureSource, sub: number, pads: PadFx): void;
  /** Sims only: particles this GPU can run. */
  bench?(): Promise<number>;
  /** Inputs for ticks >= `tick` changed after the fact (sims rewind and replay). */
  invalidate(tick: number): void;
  status(): string;
}

export function graphScene(device: GPUDevice, g: SceneGraph, budget: Budget, reg: Registry = REGISTRY): GraphScene {
  const plan = compile(g, reg);
  const runner = new GraphRunner(device, plan, budget);
  /** The CPU frame behind each state handed out, so encode doesn't evaluate it again. */
  const frames = new WeakMap<SceneState, CpuFrame>();
  const def: SceneDef = {
    id: g.id, name: g.name,
    state(f: number, F: FeatureSource, sub = 0): SceneState {
      const cf = evalCpu(plan, f, F, sub), s: SceneState = { u: cf.hash, prims: null };
      frames.set(s, cf);
      return s;
    },
  };
  return {
    def, graph: g,
    post: { ...POST_DEFAULT, ...g.post },
    encode(enc, target, s, tick, F, sub, pads) { runner.encode(enc, target, frames.get(s) ?? evalCpu(plan, tick, F, sub), pads); },
    bench: runner.hasBench ? async () => (await runner.bench())! : undefined,
    invalidate: (t) => runner.invalidate(t),
    status: () => runner.status(),
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
