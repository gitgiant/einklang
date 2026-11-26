// GPU half of a scene graph: runs each node in plan order into pooled textures, then copies the
// output port into the scene's HDR target.
import type { GpuInstance, Palette, ParamValue, PortType } from '../../../lab/api/index.ts';
import { CPU_PORTS, TEX_FORMAT, isTexPort } from '../../../lab/api/index.ts';
import type { Plan, PlanNode, CpuFrame } from '../../core/graph/eval.ts';
import { splitRef } from '../../core/graph/types.ts';
import { shader } from '../gpu/gpu.ts';
import { autoFragment, autoLayout, defaultPalette, writeAuto, type AutoLayout } from './auto.ts';

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

interface AutoRun {
  kind: 'auto'; L: AutoLayout; pipe: GPURenderPipeline; bgl: GPUBindGroupLayout; ubuf: GPUBuffer; data: Float32Array;
  /** Feedback ping-pong (own textures, not pooled). */
  fb: [GPUTexture, GPUTexture] | null; cur: number;
}
interface DriverRun { kind: 'driver'; inst: GpuInstance | null }
interface CpuOnly { kind: 'cpu' }
type Run = AutoRun | DriverRun | CpuOnly;

export class GraphRunner {
  private runs: Run[];
  private pool: TexPool;
  private samp: GPUSampler;
  /** What an unconnected optional image input reads (WebGPU zero-fills it: transparent black). */
  private black: GPUTexture;
  /** Per node, per image output: the index of the last node reading it (Infinity = scene output). */
  private lastUse: Map<string, number>;
  private device: GPUDevice;
  private plan: Plan;

  constructor(device: GPUDevice, plan: Plan) {
    this.device = device; this.plan = plan;
    this.pool = new TexPool(device);
    this.samp = device.createSampler({ magFilter: 'linear', minFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' });
    this.black = device.createTexture({ size: [1, 1], format: 'rgba16float', usage: GPUTextureUsage.TEXTURE_BINDING, label: 'black' });
    this.lastUse = new Map();
    plan.order.forEach((pn, i) => { for (const ref of Object.values(pn.inputs)) this.lastUse.set(ref, Math.max(this.lastUse.get(ref) ?? -1, i)); });
    this.lastUse.set(plan.graph.out, Infinity);
    this.runs = plan.order.map((pn) => this.build(pn));
  }

  private build(pn: PlanNode): Run {
    const m = pn.def.manifest, d = this.device;
    if (m.shader) {
      const L = autoLayout(m), fmt = TEX_FORMAT[Object.values(m.ports.out)[0].type as keyof typeof TEX_FORMAT];
      const mod = shader(d, L.prelude + pn.def.wgsl[m.shader] + autoFragment, m.id);
      const bgl = d.createBindGroupLayout({
        label: m.id,
        entries: [
          { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
          { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
          ...L.textures.map((_, i) => ({ binding: 2 + i, visibility: GPUShaderStage.FRAGMENT, texture: {} })),
        ],
      });
      const pipe = d.createRenderPipeline({
        label: m.id, layout: d.createPipelineLayout({ bindGroupLayouts: [bgl] }),
        vertex: { module: mod, entryPoint: 'vs_full' },
        fragment: { module: mod, entryPoint: 'fs_auto', targets: [{ format: fmt }] },
      });
      const ubuf = d.createBuffer({ label: m.id, size: L.floats * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      return { kind: 'auto', L, pipe, bgl, ubuf, data: new Float32Array(L.floats), fb: null, cur: 0 };
    }
    const g = pn.def.driver?.gpu;
    if (!g) return { kind: 'cpu' };
    const inst = g({
      device: d, formats: TEX_FORMAT,
      shader: (f) => shader(d, pn.def.wgsl[f] ?? '', `${m.id}/${f}`),
      wgsl: (f) => pn.def.wgsl[f] ?? '',
    });
    return { kind: 'driver', inst };
  }

  /** Encode the graph for one frame into `target` (an HDR scene texture with COPY_DST). */
  encode(enc: GPUCommandEncoder, target: GPUTexture, frame: CpuFrame): void {
    const w = target.width, h = target.height;
    if (this.pool.resize(w, h)) for (const r of this.runs) if (r.kind === 'auto' && r.fb) { r.fb.forEach((t) => t.destroy()); r.fb = null; }
    /** Values produced this frame by "node.port": textures, particles, geo. */
    const gpuVals = new Map<string, unknown>();
    const pooled = new Map<string, GPUTexture>();
    const value = (ref: string, type: PortType) => {
      if (CPU_PORTS.includes(type)) { const [n, p] = splitRef(ref); return frame.outs.get(n)?.[p]; }
      return gpuVals.get(ref);
    };

    this.plan.order.forEach((pn, i) => {
      const r = this.runs[i], m = pn.def.manifest, id = pn.node.id;
      const params = frame.params.get(id)!;
      const ins: Record<string, unknown> = {};
      for (const [p, ref] of Object.entries(pn.inputs)) ins[p] = value(ref, m.ports.in![p].type);
      const outTex: Record<string, GPUTexture> = {};
      for (const [p, s] of Object.entries(m.ports.out)) {
        if (!isTexPort(s.type)) continue;
        if (r.kind === 'auto' && m.feedback) {
          r.fb ??= [0, 1].map(() => this.device.createTexture({ size: [w, h], format: TEX_FORMAT[s.type as 'tex'], label: `${id}.fb`, usage: usageOf(TEX_FORMAT[s.type as 'tex']) })) as [GPUTexture, GPUTexture];
          r.cur ^= 1;
          outTex[p] = r.fb[r.cur];
        } else {
          const t = this.pool.get(TEX_FORMAT[s.type], `${id}.${p}`);
          pooled.set(`${id}.${p}`, t);
          outTex[p] = t;
        }
        gpuVals.set(`${id}.${p}`, outTex[p]);
      }

      if (r.kind === 'auto') this.runAuto(enc, r, ins, outTex, params, frame, w, h);
      else if (r.kind === 'driver' && r.inst) {
        const res = r.inst.frame({ ...frame.base, params, in: ins, device: this.device, enc, width: w, height: h, out: outTex, cpu: frame.outs.get(id) ?? {} });
        for (const [p, v] of Object.entries(res ?? {})) if (!isTexPort(m.ports.out[p]?.type)) gpuVals.set(`${id}.${p}`, v);
      }

      // hand textures whose last reader was this node back to the pool
      for (const [ref, t] of pooled) {
        const last = this.lastUse.get(ref) ?? -1;
        if (last <= i && last !== Infinity) { this.pool.put(t); pooled.delete(ref); }
      }
    });

    const out = gpuVals.get(this.plan.graph.out) as GPUTexture | undefined;
    if (out) enc.copyTextureToTexture({ texture: out }, { texture: target }, [w, h]);
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
    rp.setPipeline(r.pipe); rp.setBindGroup(0, bg); rp.draw(3); rp.end();
  }

  destroy(): void {
    this.pool.destroy(); this.black.destroy();
    for (const r of this.runs) {
      if (r.kind === 'auto') { r.ubuf.destroy(); r.fb?.forEach((t) => t.destroy()); }
      else if (r.kind === 'driver') r.inst?.dispose?.();
    }
  }
}
