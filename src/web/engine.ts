import type { Gpu } from './gpu/gpu.ts';
import { PostChain, type PostParams } from './gpu/post.ts';
import { TransitionPass } from './gpu/transition.ts';
import { createScenes, type GpuScene } from './scenes.ts';
import type { FeatureSource } from '../core/features.ts';
import { hashState } from '../core/scene.ts';
import { hex8 } from '../core/math.ts';
import { NO_FX, type Fx } from '../core/fx.ts';
import { sceneAt, type SceneSched } from '../core/protocol.ts';
import { transHash, transitionAt, type Transition } from '../core/transitions.ts';

const lerp = (a: number, b: number, p: number) => a + (b - a) * p;
const mixPost = (a: PostParams, b: PostParams, p: number): PostParams => ({
  decay: lerp(a.decay, b.decay, p), zoom: lerp(a.zoom, b.zoom, p), rotate: lerp(a.rotate, b.rotate, p),
  bloom: lerp(a.bloom, b.bloom, p), threshold: lerp(a.threshold, b.threshold, p), exposure: lerp(a.exposure, b.exposure, p),
});

/** One canvas: scene state -> GPU scene pass(es) -> [transition mix] -> post chain -> swapchain. */
export class Engine {
  readonly scenes: GpuScene[];
  private ctx: GPUCanvasContext;
  private post: PostChain;
  private trans: TransitionPass;
  private idx = 0;
  /** Per-host view (see VIEWS); framing only, the scene state and hash are unaffected. */
  view = 0;
  /** The transition the last frame drew, if any. */
  transition: Transition | null = null;
  private gpu: Gpu;
  private canvas: HTMLCanvasElement;

  constructor(gpu: Gpu, canvas: HTMLCanvasElement) {
    this.gpu = gpu; this.canvas = canvas;
    this.ctx = canvas.getContext('webgpu')!;
    this.ctx.configure({ device: gpu.device, format: gpu.format, alphaMode: 'opaque' });
    this.post = new PostChain(gpu.device, gpu.format);
    this.trans = new TransitionPass(gpu.device);
    this.scenes = createScenes(gpu.device);
  }

  get scene(): GpuScene { return this.scenes[this.idx]; }
  setScene(idOrIndex: string | number): void {
    const i = typeof idOrIndex === 'number' ? idOrIndex : this.scenes.findIndex((s) => s.def.id === idOrIndex);
    if (i >= 0 && i < this.scenes.length) this.idx = i;
  }
  private byId(id: string): GpuScene { return this.scenes.find((s) => s.def.id === id) ?? this.scene; }

  /** An input landed on a tick that may already be simulated: sims rewind and replay. */
  invalidate(tick: number): void { for (const s of this.scenes) s.invalidate?.(tick); }

  /**
   * Render tick `tick`; returns the sync hash shown in the HUD. With a schedule, the scene (and a
   * running transition) come from it; without one, the scene set by setScene shows. Pad FX ride
   * on the post chain; a freeze evaluates the scene (and transition) at the frozen tick while
   * trails and FX keep moving.
   */
  frame(tick: number, F: FeatureSource, fx: Fx = NO_FX, sched?: SceneSched): string {
    const st = fx.frozenAt !== null && fx.frozenAt < tick ? fx.frozenAt : tick;
    const dpr = devicePixelRatio || 1, c = this.canvas;
    const w = Math.max(1, Math.round(c.clientWidth * dpr)), h = Math.max(1, Math.round(c.clientHeight * dpr));
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    if (sched) this.setScene(sceneAt(sched, st));
    const tr = (this.transition = sched ? transitionAt(sched, st, F) : null);
    const d = this.gpu.device, enc = d.createCommandEncoder();
    const target = this.post.sceneTarget(w, h);
    let b: PostParams, hash: number;
    if (!tr) {
      const sc = this.scene, state = sc.def.state(st, F);
      sc.encode(enc, target, state, st, F);
      b = sc.post; hash = hashState(state);
    } else {
      // both scenes live, each into its own HDR target, mixed into the scene target
      const from = this.byId(tr.from), to = this.byId(tr.to), [ta, tb] = this.post.pairTargets();
      const sa = from.def.state(st, F), sb = to.def.state(st, F);
      from.encode(enc, ta, sa, st, F);
      to.encode(enc, tb, sb, st, F);
      this.trans.run(enc, target, ta, tb, tr, [fx.cx, fx.cy]);
      b = mixPost(from.post, to.post, tr.p);
      // melt: trails pushed to near 1 around the midpoint so the old scene smears into the new
      if (tr.type === 'melt') b = { ...b, decay: Math.max(b.decay, 0.985 * Math.min(1, 6.4 * tr.p * (1 - tr.p))) };
      hash = transHash(hashState(sa), hashState(sb), tr);
    }
    const post = {
      ...b,
      decay: Math.max(b.decay, fx.trails * 0.96),
      zoom: b.zoom + fx.zoom * 0.025,
      rotate: b.rotate + fx.rotate * 0.03,
      bloom: b.bloom + fx.bloom * 1.6,
    };
    this.post.run(enc, this.ctx.getCurrentTexture().createView(), post, this.view, fx, tick);
    d.queue.submit([enc.finish()]);
    return hex8(hash);
  }
}
