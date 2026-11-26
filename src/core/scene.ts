import type { FeatureSource } from './features.ts';
import { FNV0, fnv } from './math.ts';

/**
 * Integer scene state for one tick. `u` is the scene's uniform block, `prims` an optional
 * display list (8 ints per primitive, see prims.ts). The HUD hash covers both, so two hosts
 * with equal hashes are showing the same scene state.
 */
export interface SceneState { u: Int32Array; prims: Int32Array | null }

export interface SceneDef {
  id: string;
  name: string;
  state(f: number, F: FeatureSource): SceneState;
}

export const hashState = (s: SceneState): number => fnv(fnv(FNV0, s.u), s.prims ?? []);
