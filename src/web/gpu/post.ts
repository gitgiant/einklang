// Post chain: scene (HDR) -> feedback trails (ping-pong) -> bloom at 1/4 res -> tonemap to canvas.
// Trails are GPU pixel state: after a join or stutter they converge within ~1 s (accepted by spec).
import src from './shaders/post.wgsl?raw';
import { HDR, shader } from './gpu.ts';
import { MAX_MARKS, NO_FX, type Fx } from '../../core/fx.ts';

/** One uniform slot per pass; the Post struct in post.wgsl is 496 bytes. */
const SLOT = 512, POST_FLOATS = 124;

export interface PostParams {
  decay: number; zoom: number; rotate: number;
  bloom: number; threshold: number; exposure: number;
}

/** Per-host views: same scene state, different framing of it. Index = view number. */
export const VIEWS = ['normal', 'mirror', 'flip', 'rotate 180', 'zoom', 'kaleido'] as const;

export const POST_DEFAULT: PostParams = { decay: 0, zoom: 0, rotate: 0, bloom: 0.6, threshold: 0.7, exposure: 1 };

interface Targets {
  w: number; h: number; scene: GPUTexture; trail: [GPUTexture, GPUTexture]; bloomA: GPUTexture; bloomB: GPUTexture;
  /** The two scenes of a transition, allocated on first use. */
  pair: [GPUTexture, GPUTexture] | null;
}

export class PostChain {
  private pipes: Record<'feedback' | 'bright' | 'blur' | 'composite', GPURenderPipeline>;
  private samp: GPUSampler;
  private bgl: GPUBindGroupLayout;
  private ubuf: GPUBuffer;
  private t: Targets | null = null;
  private cur = 0;
  private device: GPUDevice;

  constructor(device: GPUDevice, outFormat: GPUTextureFormat) {
    this.device = device;
    const mod = shader(device, src, 'post');
    this.bgl = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform', hasDynamicOffset: true } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: {} },
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: {} },
      ],
    });
    const layout = device.createPipelineLayout({ bindGroupLayouts: [this.bgl] });
    const mk = (entry: string, format: GPUTextureFormat) => device.createRenderPipeline({
      layout, label: entry,
      vertex: { module: mod, entryPoint: 'vs_full' },
      fragment: { module: mod, entryPoint: entry, targets: [{ format }] },
    });
    this.pipes = { feedback: mk('fs_feedback', HDR), bright: mk('fs_bright', HDR), blur: mk('fs_blur', HDR), composite: mk('fs_composite', outFormat) };
    this.samp = device.createSampler({ magFilter: 'linear', minFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' });
    this.ubuf = device.createBuffer({ size: SLOT * 5, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  }

  /** HDR scene target for this frame, (re)allocated to the canvas size. */
  sceneTarget(w: number, h: number): GPUTexture {
    if (!this.t || this.t.w !== w || this.t.h !== h) {
      this.t?.scene.destroy(); this.t?.trail.forEach((x) => x.destroy()); this.t?.bloomA.destroy(); this.t?.bloomB.destroy();
      this.t?.pair?.forEach((x) => x.destroy());
      const qw = Math.ceil(w / 4), qh = Math.ceil(h / 4);
      this.t = { w, h, scene: this.tex(w, h, 'scene'), trail: [this.tex(w, h, 'trailA'), this.tex(w, h, 'trailB')], bloomA: this.tex(qw, qh, 'bloomA'), bloomB: this.tex(qw, qh, 'bloomB'), pair: null };
    }
    return this.t.scene;
  }

  /** HDR targets for a transition's two scenes, the same size as the scene target. */
  pairTargets(): [GPUTexture, GPUTexture] {
    const t = this.t!;
    return (t.pair ??= [this.tex(t.w, t.h, 'transFrom'), this.tex(t.w, t.h, 'transTo')]);
  }

  private tex(tw: number, th: number, label: string): GPUTexture {
    return this.device.createTexture({
      size: [Math.max(1, tw), Math.max(1, th)], format: HDR, label,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST, // COPY_DST: graph scenes copy their output in
    });
  }

  run(enc: GPUCommandEncoder, out: GPUTextureView, p: PostParams, view = 0, fx: Fx = NO_FX, tick = 0): void {
    const t = this.t!, d = this.device;
    const prev = t.trail[this.cur], next = t.trail[this.cur ^ 1];
    this.cur ^= 1;
    const qw = t.bloomA.width, qh = t.bloomA.height;
    // one uniform slot per pass
    const slots = new ArrayBuffer(SLOT * 5);
    const marks = fx.marks.slice(0, MAX_MARKS);
    const put = (slot: number, texel: [number, number], dir: [number, number]) => {
      const f = new Float32Array(slots, slot * SLOT, POST_FLOATS);
      f.set([p.decay, p.zoom, p.rotate, p.bloom, p.threshold, p.exposure, t.w / t.h, view, ...texel, ...dir,
        fx.cx, fx.cy, fx.kaleido, fx.invert, fx.strobe, fx.blackout, fx.glitch, marks.length,
        ...fx.strobeCol, 1, fx.kx, fx.ky, tick % 4096, 0]);
      marks.forEach((m, i) => { f.set([m.x, m.y, m.r, m.a], 28 + i * 4); f.set([...m.col, 1], 28 + MAX_MARKS * 4 + i * 4); });
    };
    put(0, [1 / t.w, 1 / t.h], [0, 0]);
    put(1, [1 / t.w, 1 / t.h], [0, 0]);
    put(2, [1 / qw, 1 / qh], [1, 0]);
    put(3, [1 / qw, 1 / qh], [0, 1]);
    put(4, [1 / t.w, 1 / t.h], [0, 0]);
    d.queue.writeBuffer(this.ubuf, 0, slots);

    const pass = (pipe: GPURenderPipeline, slot: number, target: GPUTextureView, a: GPUTexture, b: GPUTexture) => {
      const bg = d.createBindGroup({
        layout: this.bgl,
        entries: [
          { binding: 0, resource: { buffer: this.ubuf, size: POST_FLOATS * 4 } },
          { binding: 1, resource: this.samp },
          { binding: 2, resource: a.createView() },
          { binding: 3, resource: b.createView() },
        ],
      });
      const rp = enc.beginRenderPass({ colorAttachments: [{ view: target, loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }] });
      rp.setPipeline(pipe); rp.setBindGroup(0, bg, [slot * SLOT]); rp.draw(3); rp.end();
    };
    pass(this.pipes.feedback, 0, next.createView(), t.scene, prev);
    pass(this.pipes.bright, 1, t.bloomA.createView(), next, next);
    pass(this.pipes.blur, 2, t.bloomB.createView(), t.bloomA, t.bloomA);
    pass(this.pipes.blur, 3, t.bloomA.createView(), t.bloomB, t.bloomB);
    pass(this.pipes.composite, 4, out, next, t.bloomA);
  }
}
