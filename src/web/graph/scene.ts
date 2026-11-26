// A lab scene graph as a GpuScene, so the Engine, transitions and gallery can show it. (#21 makes
// the graph the whole pipeline; until then graph scenes plug in beside the v1 scenes.)
import type { SceneDef, SceneState } from '../../core/scene.ts';
import type { FeatureSource } from '../../core/features.ts';
import { compile, evalCpu, type CpuFrame } from '../../core/graph/eval.ts';
import type { Registry, SceneGraph } from '../../core/graph/types.ts';
import { POST_DEFAULT } from '../gpu/post.ts';
import type { GpuScene } from '../scenes.ts';
import { GraphRunner } from './runner.ts';
import { LAB_SCENES, REGISTRY } from './registry.ts';

export function graphScene(device: GPUDevice, g: SceneGraph, reg: Registry = REGISTRY): GpuScene {
  const plan = compile(g, reg);
  const runner = new GraphRunner(device, plan);
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
    def,
    // the graph does its own post work (trails, bloom pieces); the v1 global chain stays neutral
    post: { ...POST_DEFAULT, bloom: 0.4, threshold: 0.8 },
    encode(enc, target, s, tick, F, sub = 0) { runner.encode(enc, target, frames.get(s) ?? evalCpu(plan, tick, F, sub)); },
    status: () => `graph ${g.id} v${g.version} · ${plan.order.length} nodes`,
  };
}

/** Every lab scene that compiles; broken ones are logged and skipped. */
export function labScenes(device: GPUDevice): GpuScene[] {
  const out: GpuScene[] = [];
  for (const g of LAB_SCENES) {
    try { out.push(graphScene(device, g)); } catch (e) { console.error(`lab scene ${g.id} skipped:\n${(e as Error).message}`); }
  }
  return out;
}
