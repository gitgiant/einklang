import type { Gpu } from './gpu/gpu.ts';
import { PostChain } from './gpu/post.ts';
import { createScenes, type GpuScene } from './scenes.ts';
import type { FeatureSource } from '../core/features.ts';
import { hashState } from '../core/scene.ts';
import { hex8 } from '../core/math.ts';

/** One canvas: scene state -> GPU scene pass -> post chain -> swapchain. */
export class Engine {
  readonly scenes: GpuScene[];
  private ctx: GPUCanvasContext;
  private post: PostChain;
  private idx = 0;
  /** Per-host view (see VIEWS); framing only, the scene state and hash are unaffected. */
  view = 0;
  private gpu: Gpu;
  private canvas: HTMLCanvasElement;

  constructor(gpu: Gpu, canvas: HTMLCanvasElement) {
    this.gpu = gpu; this.canvas = canvas;
    this.ctx = canvas.getContext('webgpu')!;
    this.ctx.configure({ device: gpu.device, format: gpu.format, alphaMode: 'opaque' });
    this.post = new PostChain(gpu.device, gpu.format);
    this.scenes = createScenes(gpu.device);
  }

  get scene(): GpuScene { return this.scenes[this.idx]; }
  setScene(idOrIndex: string | number): void {
    const i = typeof idOrIndex === 'number' ? idOrIndex : this.scenes.findIndex((s) => s.def.id === idOrIndex);
    if (i >= 0 && i < this.scenes.length) this.idx = i;
  }

  /** An input landed on a tick that may already be simulated: sims rewind and replay. */
  invalidate(tick: number): void { for (const s of this.scenes) s.invalidate?.(tick); }

  /** Render tick `tick`; returns the scene-state hash shown in the HUD. */
  frame(tick: number, F: FeatureSource): string {
    const dpr = devicePixelRatio || 1, c = this.canvas;
    const w = Math.max(1, Math.round(c.clientWidth * dpr)), h = Math.max(1, Math.round(c.clientHeight * dpr));
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    const sc = this.scene, state = sc.def.state(tick, F);
    const d = this.gpu.device, enc = d.createCommandEncoder();
    const target = this.post.sceneTarget(w, h);
    sc.encode(enc, target, state, tick, F);
    this.post.run(enc, this.ctx.getCurrentTexture().createView(), sc.post, this.view);
    d.queue.submit([enc.finish()]);
    return hex8(hashState(state));
  }
}
