// GPU drivers for the v1 scenes. Each turns the integer SceneState from core into draw calls.
import primsSrc from './gpu/shaders/prims.wgsl?raw';
import tunnelSrc from './gpu/shaders/tunnel.wgsl?raw';
import flowSrc from './gpu/shaders/flow.wgsl?raw';
import flowDrawSrc from './gpu/shaders/flow_draw.wgsl?raw';
import { HDR, letterbox, shader } from './gpu/gpu.ts';
import { POST_DEFAULT, type PostParams } from './gpu/post.ts';
import type { FeatureSource } from '../core/features.ts';
import type { SceneDef, SceneState } from '../core/scene.ts';
import { radial } from '../core/scenes/radial.ts';
import { tunnel } from '../core/scenes/tunnel.ts';
import { scope } from '../core/scenes/scope.ts';
import { flow, FlowSim, epochOf, seedOf, stepParams } from '../core/scenes/flow.ts';
import { RESEED_TICKS } from '../core/constants.ts';
import { PRIM_INTS } from '../core/prims.ts';
import { hex8 } from '../core/math.ts';

export interface GpuScene {
  readonly def: SceneDef;
  readonly post: PostParams;
  /** Encode the work that renders `state` into the HDR scene target. */
  encode(enc: GPUCommandEncoder, target: GPUTexture, state: SceneState, tick: number, F: FeatureSource): void;
  /** Inputs for ticks >= `tick` changed after the fact (stateful sims must replay). */
  invalidate?(tick: number): void;
  /** Extra HUD line (e.g. sim status). */
  status?(): string;
}

const ADD: GPUBlendState = { color: { srcFactor: 'one', dstFactor: 'one' }, alpha: { srcFactor: 'one', dstFactor: 'one' } };
const OVER: GPUBlendState = { color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' }, alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' } };

const clearPass = (enc: GPUCommandEncoder, target: GPUTexture, load: GPULoadOp = 'clear') =>
  enc.beginRenderPass({ colorAttachments: [{ view: target.createView(), loadOp: load, storeOp: 'store', clearValue: [0, 0, 0, 1] }] });

/** Renders a core display list (prims.ts) with SDF quads. */
class PrimDrawer {
  private pipe: GPURenderPipeline;
  private ubuf: GPUBuffer;
  private lbuf: GPUBuffer | null = null;
  private device: GPUDevice;
  private gain: number;
  constructor(device: GPUDevice, blend: GPUBlendState, gain: number) {
    this.device = device; this.gain = gain;
    const mod = shader(device, primsSrc, 'prims');
    this.pipe = device.createRenderPipeline({
      layout: 'auto', label: 'prims',
      vertex: { module: mod, entryPoint: 'vs_prim' },
      fragment: { module: mod, entryPoint: 'fs_prim', targets: [{ format: HDR, blend }] },
    });
    this.ubuf = device.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  }
  draw(enc: GPUCommandEncoder, target: GPUTexture, prims: Int32Array): void {
    const d = this.device, bytes = Math.max(prims.byteLength, 32);
    if (!this.lbuf || this.lbuf.size < bytes) {
      this.lbuf?.destroy();
      this.lbuf = d.createBuffer({ size: Math.max(bytes * 2, 64 * 1024), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    }
    d.queue.writeBuffer(this.lbuf, 0, prims);
    const lb = letterbox(target.width, target.height);
    d.queue.writeBuffer(this.ubuf, 0, new Float32Array([target.width, target.height, lb.ox, lb.oy, lb.scale, this.gain, 0, 0]));
    const bg = d.createBindGroup({ layout: this.pipe.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: this.ubuf } }, { binding: 1, resource: { buffer: this.lbuf } }] });
    const rp = clearPass(enc, target);
    rp.setPipeline(this.pipe); rp.setBindGroup(0, bg); rp.draw(6, prims.length / PRIM_INTS); rp.end();
  }
}

function primScene(device: GPUDevice, def: SceneDef, post: PostParams, blend: GPUBlendState, gain: number): GpuScene {
  const drawer = new PrimDrawer(device, blend, gain);
  return { def, post, encode: (enc, target, s) => drawer.draw(enc, target, s.prims!) };
}

function tunnelScene(device: GPUDevice): GpuScene {
  const mod = shader(device, tunnelSrc, 'tunnel');
  const pipe = device.createRenderPipeline({
    layout: 'auto', label: 'tunnel',
    vertex: { module: mod, entryPoint: 'vs_full' },
    fragment: { module: mod, entryPoint: 'fs_tunnel', targets: [{ format: HDR }] },
  });
  const ubuf = device.createBuffer({ size: 16 + 96, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const bg = device.createBindGroup({ layout: pipe.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: ubuf } }] });
  return {
    def: tunnel,
    post: { ...POST_DEFAULT, decay: 0.7, zoom: 0.02, rotate: 0.003, bloom: 0.7, threshold: 0.7 },
    encode(enc, target, s) {
      const buf = new ArrayBuffer(16 + 96);
      new Float32Array(buf, 0, 2).set([target.width, target.height]);
      new Int32Array(buf, 16, 24).set(s.u);
      device.queue.writeBuffer(ubuf, 0, buf);
      const rp = clearPass(enc, target);
      rp.setPipeline(pipe); rp.setBindGroup(0, bg); rp.draw(3); rp.end();
    },
  };
}

/** Fixed-point flow field: GPU sim stepped once per tick, fast-forwarded after a reseed or join. */
function flowScene(device: GPUDevice, n = 1 << 17): GpuScene {
  const MAX_STEPS = 50, CHECK_N = 1024, SLOT = 256;
  const csMod = shader(device, flowSrc, 'flow');
  const bgl = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform', hasDynamicOffset: true } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
      { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
    ],
  });
  const layout = device.createPipelineLayout({ bindGroupLayouts: [bgl] });
  const cp = (entryPoint: string) => device.createComputePipeline({ layout, label: entryPoint, compute: { module: csMod, entryPoint } });
  const pStep = cp('cs_step'), pSeed = cp('cs_seed'), pHash = cp('cs_hash');
  const particles = device.createBuffer({ size: n * 16, usage: GPUBufferUsage.STORAGE });
  const params = device.createBuffer({ size: SLOT * (MAX_STEPS + 2), usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const hashBuf = device.createBuffer({ size: 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST });
  const readback = device.createBuffer({ size: 4, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
  const csBg = device.createBindGroup({
    layout: bgl,
    entries: [{ binding: 0, resource: { buffer: params, size: 32 } }, { binding: 1, resource: { buffer: particles } }, { binding: 2, resource: { buffer: hashBuf } }],
  });

  const drawMod = shader(device, flowDrawSrc, 'flow_draw');
  const drawPipe = device.createRenderPipeline({
    layout: 'auto', label: 'flow_draw',
    vertex: { module: drawMod, entryPoint: 'vs_flow' },
    fragment: { module: drawMod, entryPoint: 'fs_flow', targets: [{ format: HDR, blend: ADD }] },
  });
  const dbuf = device.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const drawBg = device.createBindGroup({ layout: drawPipe.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: dbuf } }, { binding: 1, resource: { buffer: particles } }] });

  // CPU reference over the first CHECK_N particles, compared against the GPU every ~2 s.
  const cpu = new FlowSim(CHECK_N);
  let simTick = -Infinity, checking = false, lastCheck = 0, check = 'pending';

  return {
    def: flow,
    post: { ...POST_DEFAULT, decay: 0.93, bloom: 0.7, threshold: 0.6, exposure: 1.1 },
    invalidate(tick) { if (tick <= simTick) simTick = -Infinity; },
    status: () => `sim ${simTick === -Infinity ? '-' : simTick}  N ${n}  gpu≡cpu ${check}`,
    encode(enc, target, s, tick, F) {
      const groups = Math.ceil(n / 256);
      const slots = new ArrayBuffer(SLOT * (MAX_STEPS + 2));
      let used = 0;
      const slot = (u: Int32Array, count: number) => {
        const v = new Int32Array(slots, used * SLOT, 8);
        v.set(u); v[6] = count; v[7] = 0;
        return used++ * SLOT;
      };
      const e0 = epochOf(tick) * RESEED_TICKS;
      const reseed = simTick < e0 || simTick > tick;
      const willReach = (reseed ? e0 : simTick) + MAX_STEPS >= tick;
      const now = performance.now();
      const doCheck = !checking && willReach && now - lastCheck > 2000;
      if (doCheck) enc.clearBuffer(hashBuf);
      const cpass = enc.beginComputePass();
      if (reseed) {
        cpass.setPipeline(pSeed);
        cpass.setBindGroup(0, csBg, [slot(Int32Array.of(e0, seedOf(epochOf(tick)), 0, 0, 0, 0, 0, 0), n)]);
        cpass.dispatchWorkgroups(groups);
        simTick = e0;
      }
      cpass.setPipeline(pStep);
      for (let k = 0; k < MAX_STEPS && simTick < tick; k++) {
        cpass.setBindGroup(0, csBg, [slot(stepParams(++simTick, F), n)]);
        cpass.dispatchWorkgroups(groups);
      }
      if (doCheck) {
        cpass.setPipeline(pHash);
        cpass.setBindGroup(0, csBg, [slot(new Int32Array(8), CHECK_N)]);
        cpass.dispatchWorkgroups(Math.ceil(CHECK_N / 256));
      }
      cpass.end();
      device.queue.writeBuffer(params, 0, slots, 0, used * SLOT);
      if (doCheck) {
        enc.copyBufferToBuffer(hashBuf, 0, readback, 0, 4);
        checking = true; lastCheck = now;
        const at = simTick;
        // map after this frame's submit (encode returns before the engine submits)
        setTimeout(async () => {
          await readback.mapAsync(GPUMapMode.READ);
          const gpuHash = new Uint32Array(readback.getMappedRange().slice(0))[0];
          readback.unmap();
          cpu.seekTo(at, F);
          const cpuHash = cpu.hash();
          check = gpuHash === cpuHash ? `✓ ${hex8(gpuHash)}` : `✗ gpu ${hex8(gpuHash)} cpu ${hex8(cpuHash)}`;
          checking = false;
        }, 0);
      }

      const lb = letterbox(target.width, target.height);
      const hue = ((s.u[1] % 1536) + 1536) % 1536 / 1536;
      device.queue.writeBuffer(dbuf, 0, new Float32Array([target.width, target.height, lb.ox, lb.oy, lb.scale, hue, s.u[2] / 255, Math.max(1.2, lb.scale * 1.1)]));
      const rp = clearPass(enc, target);
      rp.setPipeline(drawPipe); rp.setBindGroup(0, drawBg); rp.draw(6, n); rp.end();
    },
  };
}

export function createScenes(device: GPUDevice): GpuScene[] {
  return [
    primScene(device, radial, { ...POST_DEFAULT, decay: 0.55, bloom: 0.55, threshold: 0.75 }, OVER, 1.3),
    tunnelScene(device),
    primScene(device, scope, { ...POST_DEFAULT, decay: 0.9, bloom: 1.1, threshold: 0.35, exposure: 1.2 }, ADD, 1.6),
    flowScene(device),
  ];
}
