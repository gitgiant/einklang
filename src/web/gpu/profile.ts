// Frame profiler for the lab's profile mode (and anyone who wants per-section numbers): CPU ms per
// engine section (a, b, mix, post, ...) and, when the device has 'timestamp-query', GPU ms per
// section from timestamps on every render/compute pass. Passes are tagged by patching
// GPUCommandEncoder.beginRenderPass/beginComputePass once, so no piece has to know about it; a pass
// that brings its own timestampWrites is left alone (and not counted).

const MAX_PASSES = 512;

let active: FrameProfiler | null = null;
let patched = false;

function patch(): void {
  if (patched || typeof GPUCommandEncoder === 'undefined') return;
  patched = true;
  const P = GPUCommandEncoder.prototype;
  const rp = P.beginRenderPass, cp = P.beginComputePass;
  P.beginRenderPass = function (this: GPUCommandEncoder, d: GPURenderPassDescriptor) {
    const tw = active?.writes(this, d.timestampWrites);
    return rp.call(this, tw ? { ...d, timestampWrites: tw } : d);
  };
  P.beginComputePass = function (this: GPUCommandEncoder, d?: GPUComputePassDescriptor) {
    const tw = active?.writes(this, d?.timestampWrites);
    return cp.call(this, tw ? { ...(d ?? {}), timestampWrites: tw } : d);
  };
}

export interface FrameProfile {
  /** CPU ms per section (JS: state evaluation + encoding). */
  cpu: Record<string, number>;
  /** GPU ms per section (sum of its passes), null without timestamp-query. */
  gpu: Record<string, number> | null;
  /** Passes per section. */
  passes: Record<string, number>;
}

export class FrameProfiler {
  readonly timestamps: boolean;
  private qs: GPUQuerySet | null = null;
  private resolveBuf: GPUBuffer | null = null;
  private readBuf: GPUBuffer | null = null;
  private enc: GPUCommandEncoder | null = null;
  private labels: string[] = [];
  private cur = '';
  private t0 = 0;
  private cpu: Record<string, number> = {};

  constructor(device: GPUDevice) {
    this.timestamps = device.features.has('timestamp-query');
    if (this.timestamps) {
      this.qs = device.createQuerySet({ type: 'timestamp', count: MAX_PASSES * 2 });
      this.resolveBuf = device.createBuffer({ size: MAX_PASSES * 16, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC });
      this.readBuf = device.createBuffer({ size: MAX_PASSES * 16, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    }
    patch();
  }

  /** Start a frame recorded into `enc` (one encoder per frame). */
  begin(enc: GPUCommandEncoder): void {
    this.enc = enc; this.labels = []; this.cpu = {}; this.cur = ''; active = this;
  }
  /** Everything from here to the next section() / end() counts as `name`. */
  section(name: string): void {
    const now = performance.now();
    if (this.cur) this.cpu[this.cur] = (this.cpu[this.cur] ?? 0) + now - this.t0;
    this.cur = name; this.t0 = now;
  }
  /** @internal timestampWrites for the next pass on `enc`, if this frame records it. */
  writes(enc: GPUCommandEncoder, own: unknown): GPURenderPassTimestampWrites | undefined {
    if (own || enc !== this.enc || !this.qs || this.labels.length >= MAX_PASSES) return undefined;
    const i = this.labels.push(this.cur || '?') - 1;
    return { querySet: this.qs, beginningOfPassWriteIndex: 2 * i, endOfPassWriteIndex: 2 * i + 1 };
  }
  /** Close the frame: resolve the timestamps into `enc` (before it is finished). */
  end(enc: GPUCommandEncoder): void {
    this.section('');
    active = null; this.enc = null;
    const n = this.labels.length;
    if (this.qs && n) {
      enc.resolveQuerySet(this.qs, 0, 2 * n, this.resolveBuf!, 0);
      enc.copyBufferToBuffer(this.resolveBuf!, 0, this.readBuf!, 0, 16 * n);
    }
  }
  /** After the frame's submit: the numbers (waits for the GPU when timestamps are on). */
  async read(): Promise<FrameProfile> {
    const cpu = this.cpu, labels = this.labels, passes: Record<string, number> = {};
    for (const l of labels) passes[l] = (passes[l] ?? 0) + 1;
    if (!this.readBuf || !labels.length) return { cpu, gpu: this.timestamps ? {} : null, passes };
    await this.readBuf.mapAsync(GPUMapMode.READ, 0, 16 * labels.length);
    const ts = new BigInt64Array(this.readBuf.getMappedRange(0, 16 * labels.length).slice(0));
    this.readBuf.unmap();
    const gpu: Record<string, number> = {};
    labels.forEach((l, i) => {
      const d = Number(ts[2 * i + 1] - ts[2 * i]) / 1e6;
      // a pass the driver didn't time (or a counter wrap) reads as 0 or negative: skip it
      if (d > 0 && d < 1000) gpu[l] = (gpu[l] ?? 0) + d;
    });
    return { cpu, gpu, passes };
  }
  destroy(): void { this.qs?.destroy(); this.resolveBuf?.destroy(); this.readBuf?.destroy(); }
}
