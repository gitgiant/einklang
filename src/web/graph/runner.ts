// GPU half of a scene graph: runs each node in plan order into pooled textures, then copies the
// output port into the scene's HDR target. One runner can hold several plans (a scene's sections):
// nodes with the same definition and the same upstream are one instance shared by all of them, the
// others get their own, all built (pipelines included) when the runner is made. Each frame runs only
// what the requested plans' outputs need: a node whose cpu() returns `use` (core-switch,
// core-crossfade) only pulls the inputs it lists, so unselected branches don't render.
import type { GpuInit, GpuInstance, PadFx, Palette, ParamValue } from '../../../lab/api/index.ts';
import type { PieceDef } from '../../core/graph/types.ts';
import { NO_FX } from '../../core/fx.ts';
import { CPU_PORTS, TEX_FORMAT, isTexPort } from '../../../lab/api/index.ts';
import { strHash, type Plan, type PlanNode, type CpuFrame } from '../../core/graph/eval.ts';
import { splitRef } from '../../core/graph/types.ts';
import { shader } from '../gpu/gpu.ts';
import { autoFragment, autoLayout, defaultPalette, writeAuto, type AutoLayout } from './auto.ts';
import { LIB } from './registry.ts';
import { MEDIA } from '../media.ts';

export type Budget = GpuInit['budget'];

/** Start a driver piece's GPU side (null when it has none). */
export function instantiate(device: GPUDevice, def: PieceDef, budget: Budget): GpuInstance | null {
  const g = def.driver?.gpu, id = def.manifest.id;
  if (!g) return null;
  return g({
    device, formats: TEX_FORMAT, budget,
    shader: (f) => shader(device, def.wgsl[f] ?? '', `${id}/${f}`, { name: f, skip: 0 }),
    wgsl: (f) => def.wgsl[f] ?? '',
    compile: (code, label) => shader(device, code, label),
    lib: (f) => LIB[f] ?? '',
    media: MEDIA.input(device),
    asset: (p) => {
      const b = def.assets?.[p];
      if (!b) throw new Error(`${id}: asset ${p} is not declared in piece.json (or missing)`);
      return b;
    },
  });
}

const usageOf = (f: GPUTextureFormat) =>
  GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC | GPUTextureUsage.COPY_DST
  | (f === 'rgba16float' ? GPUTextureUsage.STORAGE_BINDING : 0);

/** Same-size textures reused across nodes once their last reader has run. */
class TexPool {
  private free = new Map<GPUTextureFormat, GPUTexture[]>();
  private all: GPUTexture[] = [];
  w = 0; h = 0;
  private device: GPUDevice;
  constructor(device: GPUDevice) { this.device = device; }
  resize(w: number, h: number): boolean {
    if (w === this.w && h === this.h) return false;
    for (const t of this.all) t.destroy();
    this.all = []; this.free.clear(); this.w = w; this.h = h;
    return true;
  }
  get(format: GPUTextureFormat, label: string): GPUTexture {
    const t = this.free.get(format)?.pop();
    if (t) return t;
    const n = this.device.createTexture({ size: [this.w, this.h], format, label, usage: usageOf(format) });
    this.all.push(n);
    return n;
  }
  put(t: GPUTexture): void { const l = this.free.get(t.format as GPUTextureFormat) ?? []; l.push(t); this.free.set(t.format as GPUTextureFormat, l); }
  destroy(): void { for (const t of this.all) t.destroy(); this.all = []; this.free.clear(); this.w = this.h = 0; }
}

/** An auto-shader piece's pipeline, one per piece and device, compiled in the background (createRenderPipelineAsync). */
interface AutoPipe { bgl: GPUBindGroupLayout; desc: GPURenderPipelineDescriptor; ready: GPURenderPipeline | null }
const PIPES = new WeakMap<GPUDevice, Map<string, AutoPipe>>();
function autoPipe(d: GPUDevice, def: PieceDef, L: AutoLayout): AutoPipe {
  const m = def.manifest;
  let per = PIPES.get(d);
  if (!per) PIPES.set(d, (per = new Map()));
  let e = per.get(m.id);
  if (e) return e;
  const fmt = TEX_FORMAT[Object.values(m.ports.out)[0].type as keyof typeof TEX_FORMAT];
  const mod = shader(d, L.prelude + def.wgsl[m.shader!] + autoFragment, m.id, { name: m.shader!, skip: L.prelude.split('\n').length - 1 });
  const bgl = d.createBindGroupLayout({
    label: m.id,
    entries: [
      { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
      ...L.textures.map((_, i) => ({ binding: 2 + i, visibility: GPUShaderStage.FRAGMENT, texture: {} })),
    ],
  });
  const desc: GPURenderPipelineDescriptor = {
    label: m.id, layout: d.createPipelineLayout({ bindGroupLayouts: [bgl] }),
    vertex: { module: mod, entryPoint: 'vs_full' },
    fragment: { module: mod, entryPoint: 'fs_auto', targets: [{ format: fmt }] },
  };
  const ent: AutoPipe = { bgl, desc, ready: null };
  per.set(m.id, ent);
  d.createRenderPipelineAsync(desc).then((p) => { ent.ready ??= p; }).catch((x: Error) => console.error(`[${m.id}] ${x.message}`));
  return ent;
}
/** The compiled pipeline, or (a stall) made on the spot when its background compile hasn't finished. */
const pipeOf = (d: GPUDevice, e: AutoPipe) => (e.ready ??= d.createRenderPipeline(e.desc));

interface AutoRun {
  kind: 'auto'; L: AutoLayout; pipe: AutoPipe; bgl: GPUBindGroupLayout; ubuf: GPUBuffer; data: Float32Array;
  /** Feedback ping-pong (own textures, not pooled). */
  fb: [GPUTexture, GPUTexture] | null; cur: number;
}
interface DriverRun { kind: 'driver'; inst: GpuInstance | null }
interface CpuOnly { kind: 'cpu' }
type Run = AutoRun | DriverRun | CpuOnly;

/** A node of the merged graph: `key` = node id + a hash of its definition and everything upstream. */
interface MNode { key: string; pn: PlanNode; run: Run; /** input port -> "sourceKey.port" */ inputs: Record<string, string> }
/** One plan to draw this frame: its CPU frame and the HDR target its output is copied into. */
export interface Job { plan: number; target: GPUTexture; frame: CpuFrame }

/** Keys of every plan's nodes: equal keys = same piece, params, bindings and inputs, recursively. */
function nodeKeys(plan: Plan): Map<string, string> {
  const keys = new Map<string, string>();
  const src = (ref: string) => { const [n, p] = splitRef(ref); return `${keyOf(n)}.${p}`; };
  const keyOf = (id: string): string => {
    let k = keys.get(id);
    if (k) return k;
    const pn = plan.byId.get(id);
    if (!pn) return `?${id}`;
    const n = pn.node, bind = Object.entries(n.bind ?? {}).sort().map(([p, b]) => [p, src(b.from), b.range ?? null]);
    const ins = Object.entries(pn.inputs).sort().map(([p, r]) => [p, src(r)]);
    const params = Object.entries(n.params ?? {}).sort();
    k = `${id}#${(strHash(JSON.stringify([n.piece, params, bind, ins])) >>> 0).toString(36)}`;
    keys.set(id, k);
    return k;
  };
  for (const pn of plan.order) keyOf(pn.node.id);
  return keys;
}

export class GraphRunner {
  /** The union of every plan's nodes, dependencies first. */
  private nodes: MNode[] = [];
  /** Per plan: node id -> merged node index; its output as "key.port". */
  private plans: { plan: Plan; at: Map<string, number>; out: string }[] = [];
  private pool: TexPool;
  private samp: GPUSampler;
  /** What an unconnected optional image input reads (WebGPU zero-fills it: transparent black). */
  private black: GPUTexture;
  /** Per "key.port" image output: the merged index of the last node reading it (Infinity = a plan's output). */
  private lastUse: Map<string, number>;
  private device: GPUDevice;

  private budget: Budget;
  /** The size the pool holds textures for (set by encode or prepare). */
  private sized = '';
  constructor(device: GPUDevice, plans: Plan | Plan[], budget: Budget) {
    this.device = device; this.budget = budget;
    this.pool = new TexPool(device);
    this.samp = device.createSampler({ magFilter: 'linear', minFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' });
    this.black = device.createTexture({ size: [1, 1], format: 'rgba16float', usage: GPUTextureUsage.TEXTURE_BINDING, label: 'black' });
    const index = new Map<string, number>();
    for (const plan of Array.isArray(plans) ? plans : [plans]) {
      const keys = nodeKeys(plan), at = new Map<string, number>();
      const ref = (r: string) => { const [n, p] = splitRef(r); return `${keys.get(n)}.${p}`; };
      for (const pn of plan.order) {
        const key = keys.get(pn.node.id)!;
        let i = index.get(key);
        if (i === undefined) {
          i = this.nodes.length;
          index.set(key, i);
          this.nodes.push({ key, pn, run: this.build(pn), inputs: Object.fromEntries(Object.entries(pn.inputs).map(([p, r]) => [p, ref(r)])) });
        }
        at.set(pn.node.id, i);
      }
      this.plans.push({ plan, at, out: ref(plan.graph.out) });
    }
    this.lastUse = new Map();
    this.nodes.forEach((mn, i) => { for (const r of Object.values(mn.inputs)) this.lastUse.set(r, Math.max(this.lastUse.get(r) ?? -1, i)); });
    for (const p of this.plans) this.lastUse.set(p.out, Infinity);
  }

  /** Distinct node instances across the plans (shared ones count once). */
  get instanceCount(): number { return this.nodes.length; }

  private build(pn: PlanNode): Run {
    const m = pn.def.manifest, d = this.device;
    if (m.shader) {
      const L = autoLayout(m), pipe = autoPipe(d, pn.def, L);
      const ubuf = d.createBuffer({ label: m.id, size: L.floats * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      return { kind: 'auto', L, pipe, bgl: pipe.bgl, ubuf, data: new Float32Array(L.floats), fb: null, cur: 0 };
    }
    const inst = instantiate(d, pn.def, this.budget);
    return inst ? { kind: 'driver', inst } : { kind: 'cpu' };
  }

  /** Size the pool for w x h (a new size drops every texture, feedback included). */
  private size(w: number, h: number): void {
    this.sized = `${w}x${h}`;
    if (this.pool.resize(w, h)) for (const { run: r } of this.nodes) if (r.kind === 'auto' && r.fb) { r.fb.forEach((t) => t.destroy()); r.fb = null; }
  }

  /** Node i's image outputs for this frame: its feedback texture (flipped when `flip`) or pooled ones (recorded in `pooled`). */
  private outputs(i: number, w: number, h: number, pooled: Map<string, GPUTexture>, flip: boolean): Record<string, GPUTexture> {
    const { run: r, pn, key } = this.nodes[i], m = pn.def.manifest, id = pn.node.id;
    const outTex: Record<string, GPUTexture> = {};
    for (const [p, s] of Object.entries(m.ports.out)) {
      if (!isTexPort(s.type)) continue;
      if (r.kind === 'auto' && m.feedback) {
        r.fb ??= [0, 1].map(() => this.device.createTexture({ size: [w, h], format: TEX_FORMAT[s.type as 'tex'], label: `${id}.fb`, usage: usageOf(TEX_FORMAT[s.type as 'tex']) })) as [GPUTexture, GPUTexture];
        if (flip) r.cur ^= 1;
        outTex[p] = r.fb[r.cur];
      } else {
        const t = this.pool.get(TEX_FORMAT[s.type], `${id}.${p}`);
        pooled.set(`${key}.${p}`, t);
        outTex[p] = t;
      }
    }
    return outTex;
  }

  /** Hand textures whose last reader was node i back to the pool. */
  private release(i: number, pooled: Map<string, GPUTexture>): void {
    for (const [ref, t] of pooled) {
      const last = this.lastUse.get(ref) ?? -1;
      if (last <= i && last !== Infinity) { this.pool.put(t); pooled.delete(ref); }
    }
  }

  /**
   * Allocate the textures a w x h frame needs (pool and feedback), without encoding anything: the
   * engine calls it while a switch to this scene is pending, so its first frame doesn't allocate.
   * Pieces that allocate inside frame() still do that on their first frame.
   */
  prepare(w: number, h: number): void {
    if (this.sized === `${w}x${h}`) return;
    this.size(w, h);
    const pooled = new Map<string, GPUTexture>();
    this.nodes.forEach((_, i) => { this.outputs(i, w, h, pooled, false); this.release(i, pooled); });
    for (const t of pooled.values()) this.pool.put(t);
  }

  /** Encode plan 0 for one frame into `target` (an HDR scene texture with COPY_DST). */
  encode(enc: GPUCommandEncoder, target: GPUTexture, frame: CpuFrame, pads: PadFx = NO_FX): void {
    this.encodeJobs(enc, [{ plan: 0, target, frame }], pads);
  }

  /** The merged nodes the jobs need this frame, each with the CPU frame (and plan) it draws from. */
  private live(jobs: Job[]): Map<number, Job> {
    const need = new Map<number, Job>();
    for (const job of jobs) {
      const P = this.plans[job.plan], stack = [P.at.get(splitRef(P.plan.graph.out)[0])!];
      while (stack.length) {
        const i = stack.pop()!;
        if (need.has(i)) continue;
        need.set(i, job);
        const { pn } = this.nodes[i], use = job.frame.outs.get(pn.node.id)?.use;
        for (const [p, ref] of Object.entries(pn.inputs)) {
          if (CPU_PORTS.includes(pn.def.manifest.ports.in![p].type) || (use && !use.includes(p))) continue;
          const j = P.at.get(splitRef(ref)[0]);
          if (j !== undefined) stack.push(j);
        }
      }
    }
    return need;
  }

  /** Encode one frame of each job's plan into its target; nodes the plans share run once. */
  encodeJobs(enc: GPUCommandEncoder, jobs: Job[], pads: PadFx = NO_FX): void {
    const w = jobs[0].target.width, h = jobs[0].target.height;
    this.size(w, h);
    const need = this.live(jobs);
    /** Values produced this frame by "key.port": textures, particles, geo. */
    const gpuVals = new Map<string, unknown>();
    const pooled = new Map<string, GPUTexture>();

    this.nodes.forEach((mn, i) => {
      const job = need.get(i);
      if (!job) return;
      const { run: r, pn } = mn, m = pn.def.manifest, id = pn.node.id, frame = job.frame;
      const params = frame.params.get(id)!, cpu = frame.outs.get(id), use = cpu?.use;
      const ins: Record<string, unknown> = {};
      for (const [p, ref] of Object.entries(pn.inputs)) {
        if (CPU_PORTS.includes(m.ports.in![p].type)) { const [n, q] = splitRef(ref); ins[p] = frame.outs.get(n)?.[q]; }
        else if (!use || use.includes(p)) ins[p] = gpuVals.get(mn.inputs[p]);
      }
      const outTex = this.outputs(i, w, h, pooled, true);
      for (const [p, t] of Object.entries(outTex)) gpuVals.set(`${mn.key}.${p}`, t);

      if (r.kind === 'auto') this.runAuto(enc, r, ins, outTex, params, frame, w, h);
      else if (r.kind === 'driver' && r.inst) {
        const res = r.inst.frame({ ...frame.base, ...frame.helpers.get(id)!, params, in: ins, device: this.device, enc, width: w, height: h, out: outTex, cpu: cpu ?? {}, pads });
        for (const [p, v] of Object.entries(res ?? {})) if (!isTexPort(m.ports.out[p]?.type)) gpuVals.set(`${mn.key}.${p}`, v);
      }

      this.release(i, pooled);
    });

    for (const job of jobs) {
      const out = gpuVals.get(this.plans[job.plan].out) as GPUTexture | undefined;
      if (out) enc.copyTextureToTexture({ texture: out }, { texture: job.target }, [w, h]);
    }
    for (const t of pooled.values()) this.pool.put(t);
  }

  private runAuto(enc: GPUCommandEncoder, r: AutoRun, ins: Record<string, unknown>, out: Record<string, GPUTexture>, params: Record<string, ParamValue>, frame: CpuFrame, w: number, h: number): void {
    const b = frame.base, pal = (r.L.palette && (ins[r.L.palette] as Palette | undefined)) || defaultPalette(b.audio);
    writeAuto(r.L, r.data, w, h, b.time, b.sub, b.audio, b.tick, params, pal);
    this.device.queue.writeBuffer(r.ubuf, 0, r.data);
    const target = Object.values(out)[0];
    const texOf = (n: string) => (n === 'prev' ? r.fb![r.cur ^ 1] : (ins[n] as GPUTexture | undefined) ?? this.black);
    const bg = this.device.createBindGroup({
      layout: r.bgl,
      entries: [
        { binding: 0, resource: { buffer: r.ubuf } },
        { binding: 1, resource: this.samp },
        ...r.L.textures.map((n, i) => ({ binding: 2 + i, resource: texOf(n).createView() })),
      ],
    });
    const rp = enc.beginRenderPass({ colorAttachments: [{ view: target.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }] });
    rp.setPipeline(pipeOf(this.device, r.pipe)); rp.setBindGroup(0, bg); rp.draw(3); rp.end();
  }

  private get instances(): GpuInstance[] { return this.nodes.flatMap(({ run: r }) => (r.kind === 'driver' && r.inst ? [r.inst] : [])); }
  /** The first sim's benchmark (particles this GPU can run), or null without a sim. */
  async bench(): Promise<number | null> { const i = this.instances.find((x) => x.bench); return i ? i.bench!() : null; }
  get hasBench(): boolean { return this.instances.some((x) => x.bench); }
  invalidate(tick: number): void { for (const i of this.instances) i.invalidate?.(tick); }
  status(): string { return this.instances.map((i) => i.status?.()).filter(Boolean).join('  ·  '); }

  destroy(): void {
    this.pool.destroy(); this.black.destroy();
    for (const { run: r } of this.nodes) {
      if (r.kind === 'auto') { r.ubuf.destroy(); r.fb?.forEach((t) => t.destroy()); }
      else if (r.kind === 'driver') r.inst?.dispose?.();
    }
  }
}
