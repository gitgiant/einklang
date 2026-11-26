import type { Gpu } from './gpu/gpu.ts';
import type { GpuInstance, ParamValue } from '../../lab/api/index.ts';
import { labScenes, type GraphScene } from './graph/scene.ts';
import { instantiate, type Budget } from './graph/runner.ts';
import { REGISTRY } from './graph/registry.ts';
import type { FeatureSource } from '../core/features.ts';
import { hashState } from '../core/scene.ts';
import { baseCtx } from '../core/graph/eval.ts';
import { hex8 } from '../core/math.ts';
import { NO_FX, type Fx } from '../core/fx.ts';
import type { PostParams } from '../core/post.ts';
import { FLOW_N_DEFAULT, sceneAt, type SceneSched } from '../core/protocol.ts';
import { transHash, transitionAt, type Transition } from '../core/transitions.ts';

const lerp = (a: number, b: number, p: number) => a + (b - a) * p;
const mixPost = (a: PostParams, b: PostParams, p: number): PostParams => ({
  decay: lerp(a.decay, b.decay, p), zoom: lerp(a.zoom, b.zoom, p), rotate: lerp(a.rotate, b.rotate, p),
  bloom: lerp(a.bloom, b.bloom, p), threshold: lerp(a.threshold, b.threshold, p), exposure: lerp(a.exposure, b.exposure, p),
});
const HDR: GPUTextureFormat = 'rgba16float';

/** A piece run directly by the show graph (transition, post), outside any scene. */
function showNode(device: GPUDevice, id: string, budget: Budget): GpuInstance {
  const def = REGISTRY.get(id);
  const inst = def && instantiate(device, def, budget);
  if (!inst) throw new Error(`show piece ${id} is missing`);
  return inst;
}

/**
 * One canvas, running the show graph:
 *   scene A ─┐
 *            ├─ core-transition (only while one runs) ─ core-post (pads, view) ─ canvas
 *   scene B ─┘
 * Every scene is a lab scene graph (src/web/graph); the v1 scenes are graphs of one core piece.
 */
export class Engine {
  readonly scenes: GraphScene[];
  private ctx: GPUCanvasContext;
  private trans: GpuInstance;
  private post: GpuInstance;
  private idx = 0;
  /** Per-host view (see VIEWS); framing only, the scene state and hash are unaffected. */
  view = 0;
  /** Particle budget: set `n` from the room schedule and `cap` from bench(). */
  readonly budget: Budget = { n: () => FLOW_N_DEFAULT, cap: null };
  /** The transition the last frame drew, if any. */
  transition: Transition | null = null;
  private gpu: Gpu;
  private canvas: HTMLCanvasElement;
  private targets: { w: number; h: number; scene: GPUTexture; pair: [GPUTexture, GPUTexture] | null } | null = null;

  constructor(gpu: Gpu, canvas: HTMLCanvasElement) {
    this.gpu = gpu; this.canvas = canvas;
    this.ctx = canvas.getContext('webgpu')!;
    this.ctx.configure({ device: gpu.device, format: gpu.format, alphaMode: 'opaque' });
    this.scenes = labScenes(gpu.device, this.budget);
    this.trans = showNode(gpu.device, 'core-transition', this.budget);
    this.post = showNode(gpu.device, 'core-post', this.budget);
  }

  get scene(): GraphScene { return this.scenes[this.idx]; }
  setScene(idOrIndex: string | number): void {
    const i = typeof idOrIndex === 'number' ? idOrIndex : this.scenes.findIndex((s) => s.def.id === idOrIndex);
    if (i >= 0 && i < this.scenes.length) this.idx = i;
  }
  private byId(id: string): GraphScene { return this.scenes.find((s) => s.def.id === id) ?? this.scene; }

  /** Measure this GPU's particle capability (also sets budget.cap). Run before rendering. */
  async bench(): Promise<number> {
    const sim = this.scenes.find((s) => s.bench);
    const n = sim ? await sim.bench!() : FLOW_N_DEFAULT;
    this.budget.cap = n;
    return n;
  }

  /** An input landed on a tick that may already be simulated: sims rewind and replay. */
  invalidate(tick: number): void { for (const s of this.scenes) s.invalidate(tick); }

  private hdr(w: number, h: number, label: string): GPUTexture {
    return this.gpu.device.createTexture({ size: [w, h], format: HDR, label, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
  }
  private sceneTarget(w: number, h: number): GPUTexture {
    if (!this.targets || this.targets.w !== w || this.targets.h !== h) {
      this.targets?.scene.destroy(); this.targets?.pair?.forEach((t) => t.destroy());
      this.targets = { w, h, scene: this.hdr(w, h, 'scene'), pair: null };
    }
    return this.targets.scene;
  }
  private pairTargets(): [GPUTexture, GPUTexture] {
    const t = this.targets!;
    return (t.pair ??= [this.hdr(t.w, t.h, 'transFrom'), this.hdr(t.w, t.h, 'transTo')]);
  }

  /**
   * Render tick `tick`; returns the sync hash shown in the HUD. With a schedule, the scene (and a
   * running transition) come from it; without one, the scene set by setScene shows. Pad FX ride
   * on the post node; a freeze evaluates the scene (and transition) at the frozen tick while
   * trails and FX keep moving. `sub` (0..255) is the display time between `tick` and the next
   * one: closed-form scenes and transitions draw there, the hash stays the tick's.
   */
  frame(tick: number, F: FeatureSource, fx: Fx = NO_FX, sched?: SceneSched, sub = 0): string {
    const frozen = fx.frozenAt !== null && fx.frozenAt < tick, st = frozen ? fx.frozenAt! : tick;
    if (frozen) sub = 0;
    /** Drawn state at the display time, hashed state at the tick (one evaluation when sub = 0). */
    const states = (sc: GraphScene) => { const h = sc.def.state(st, F); return { draw: sub ? sc.def.state(st, F, sub) : h, hash: h }; };
    const dpr = devicePixelRatio || 1, c = this.canvas;
    const w = Math.max(1, Math.round(c.clientWidth * dpr)), h = Math.max(1, Math.round(c.clientHeight * dpr));
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    if (sched) this.setScene(sceneAt(sched, st));
    const tr = (this.transition = sched ? transitionAt(sched, st, F, sub) : null);
    const d = this.gpu.device, enc = d.createCommandEncoder();
    const target = this.sceneTarget(w, h);
    const node = (inst: GpuInstance, t: number, s: number, params: Record<string, ParamValue>, ins: Record<string, unknown>, out: GPUTexture) =>
      inst.frame({ ...baseCtx(t, F, s), params, in: ins, out: { out }, device: d, enc, width: out.width, height: out.height, cpu: {}, pads: fx });
    let b: PostParams, hash: number;
    if (!tr) {
      const sc = this.scene, s = states(sc);
      sc.encode(enc, target, s.draw, st, F, sub, fx);
      b = sc.post; hash = hashState(s.hash);
    } else {
      // both scenes live, each into its own HDR target, mixed into the scene target
      const from = this.byId(tr.from), to = this.byId(tr.to), [ta, tb] = this.pairTargets();
      const sa = states(from), sb = states(to);
      from.encode(enc, ta, sa.draw, st, F, sub, fx);
      to.encode(enc, tb, sb.draw, st, F, sub, fx);
      node(this.trans, st, sub, { type: tr.kind, p: tr.p, flash: tr.flash16 / 65536, seed: tr.seed, roll: tr.roll, pads: true }, { a: ta, b: tb }, target);
      b = mixPost(from.post, to.post, tr.p);
      // melt: trails pushed to near 1 around the midpoint so the old scene smears into the new
      if (tr.type === 'melt') b = { ...b, decay: Math.max(b.decay, 0.985 * Math.min(1, 6.4 * tr.p * (1 - tr.p))) };
      hash = transHash(hashState(sa.hash), hashState(sb.hash), sub ? transitionAt(sched!, st, F)! : tr);
    }
    node(this.post, tick, 0, { ...b, view: this.view }, { in: target }, this.ctx.getCurrentTexture());
    d.queue.submit([enc.finish()]);
    return hex8(hash);
  }
}
