// gpu≡cpu check, paced: the CPU reference sim walks toward the GPU's tick a time-boxed slice per frame
// instead of replaying a whole gap at once (up to an epoch: ~35 ms on a desktop CPU, far more on a phone).
import { FlowSim } from '../../../../src/core/scenes/flow.ts';
import type { FeatureSource } from '../../../../src/core/features.ts';

/** Main-thread time the CPU reference may take per frame. */
export const CPU_MS = 1;

/**
 * Step `sim` toward `goal` (reseeding first if `goal` is in another epoch or behind it) until it gets
 * there or `budgetMs` has passed; always at least one step, so it never stalls. True once at `goal`.
 */
export function follow(sim: FlowSim, goal: number, F: FeatureSource, budgetMs = CPU_MS, clock = () => performance.now()): boolean {
  const t0 = clock();
  while (!sim.seekTo(goal, F, 1)) if (clock() - t0 >= budgetMs) return false;
  return true;
}

/**
 * One GPU hash taken at tick `at`, waiting for the CPU to get there. The GPU side calls `gpuHash` when
 * its readback lands; `step` runs the CPU slice each frame and returns the verdict once both are in.
 */
export class FlowCheck {
  readonly sim: FlowSim;
  private pending: { at: number; gpu: number | null; worst: number } | null = null;
  constructor(n: number) { this.sim = new FlowSim(n); }
  get busy(): boolean { return this.pending !== null; }
  start(at: number): void { this.pending = { at, gpu: null, worst: 0 }; }
  gpuHash(at: number, h: number): void { if (this.pending?.at === at) this.pending.gpu = h; }
  /**
   * This frame's CPU slice: toward the pending check's tick, else toward `gpuTick` (so the next check
   * starts close). Returns `{ gpu, cpu, worst }` (worst = most ms one frame spent on it) when one finishes.
   */
  step(gpuTick: number, F: FeatureSource, budgetMs = CPU_MS, clock = () => performance.now()): { gpu: number; cpu: number; worst: number } | null {
    const p = this.pending, goal = p ? p.at : gpuTick;
    if (!Number.isFinite(goal)) return null;
    const t0 = clock();
    const there = follow(this.sim, goal, F, budgetMs, clock);
    if (!p) return null;
    p.worst = Math.max(p.worst, clock() - t0);
    if (!there || p.gpu === null) return null;
    this.pending = null;
    return { gpu: p.gpu, cpu: this.sim.hash(), worst: p.worst };
  }
}
