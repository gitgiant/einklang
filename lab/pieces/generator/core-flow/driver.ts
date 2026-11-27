// Fixed-point flow field: GPU sim stepped once per tick, fast-forwarded after a reseed or join.
// N comes from the room; a host stronger than N adds closed-form dust (decorative, not simulated),
// and one weaker than N (it joined mid-period) shows dust only until N drops at the next reseed.
import { definePiece } from '../../../api/index.ts';
import { letterbox } from '../../../api/prims.ts';
import { flow, epochOf, seedOf, stepParams } from '../../../../src/core/scenes/flow.ts';
import { v1Cpu } from '../../../../src/core/graph/v1.ts';
import { RESEED_TICKS } from '../../../../src/core/constants.ts';
import { FLOW_N_DEFAULT, FLOW_N_MAX, FLOW_N_MIN } from '../../../../src/core/protocol.ts';
import { hex8 } from '../../../../src/core/math.ts';
import { FlowCheck } from './check.ts';

/** Most dust a strong host adds on top of the sim. */
const DUST_MAX = 1 << 18;
/** Benchmark: particles per probe, and the share of a 60 Hz frame one step + draw may take. */
const BENCH_N = 1 << 16, BENCH_BUDGET_MS = 4;
const MAX_STEPS = 50, CHECK_N = 1024, CHECK_MS = 2000, SLOT = 256;
const HDR: GPUTextureFormat = 'rgba16float';
const ADD: GPUBlendState = { color: { srcFactor: 'one', dstFactor: 'one' }, alpha: { srcFactor: 'one', dstFactor: 'one' } };

export default definePiece({
  cpu: v1Cpu(flow),
  gpu: ({ device, shader, budget }) => {
    const clearPass = (enc: GPUCommandEncoder, target: GPUTexture) =>
      enc.beginRenderPass({ colorAttachments: [{ view: target.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }] });
    const csMod = shader('flow.wgsl');
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
    const params = device.createBuffer({ size: SLOT * (MAX_STEPS + 2), usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const hashBuf = device.createBuffer({ size: 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST });
    const readback = device.createBuffer({ size: 4, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });

    const drawMod = shader('flow_draw.wgsl');
    const drawPipe = device.createRenderPipeline({
      layout: 'auto', label: 'flow_draw',
      vertex: { module: drawMod, entryPoint: 'vs_flow' },
      fragment: { module: drawMod, entryPoint: 'fs_flow', targets: [{ format: HDR, blend: ADD }] },
    });
    const dustPipe = device.createRenderPipeline({
      layout: 'auto', label: 'flow_dust',
      vertex: { module: drawMod, entryPoint: 'vs_dust' },
      fragment: { module: drawMod, entryPoint: 'fs_flow', targets: [{ format: HDR, blend: ADD }] },
    });
    const dbuf = device.createBuffer({ size: 48, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const dustBg = device.createBindGroup({ layout: dustPipe.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: dbuf } }] });

    // CPU reference over the first CHECK_N particles, compared against the GPU every ~2 s. It follows the
    // GPU a time-boxed slice per frame (check.ts), so a check never replays a long gap in one frame.
    const cpu = new FlowCheck(CHECK_N);
    let simTick = -Infinity, simN = 0, lastCheck = 0, mapAt: number | null = null, check = 'pending', shown = '-';

    // particle storage grows to the largest N seen (a regrow drops the sim: it reseeds + replays)
    let capacity = 0, particles: GPUBuffer | null = null, csBg!: GPUBindGroup, drawBg!: GPUBindGroup;
    const ensure = (n: number) => {
      if (n <= capacity) return;
      particles?.destroy();
      capacity = n;
      particles = device.createBuffer({ size: n * 16, usage: GPUBufferUsage.STORAGE });
      csBg = device.createBindGroup({
        layout: bgl,
        entries: [{ binding: 0, resource: { buffer: params, size: 32 } }, { binding: 1, resource: { buffer: particles } }, { binding: 2, resource: { buffer: hashBuf } }],
      });
      drawBg = device.createBindGroup({ layout: drawPipe.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: dbuf } }, { binding: 1, resource: { buffer: particles } }] });
      simTick = -Infinity;
    };
    ensure(FLOW_N_DEFAULT);

    const writeDraw = (target: GPUTexture, u: Int32Array, tick: number, sub: number, n: number, dustGain = 1) => {
      const lb = letterbox(target.width, target.height);
      const hue = ((u[1] % 1536) + 1536) % 1536 / 1536;
      device.queue.writeBuffer(dbuf, 0, new Float32Array([
        target.width, target.height, lb.ox, lb.oy, lb.scale, hue, u[2] / 255, Math.max(1.2, lb.scale * 1.1),
        (((tick % 36000) + 36000) % 36000) + sub / 256, FLOW_N_DEFAULT / n, dustGain, 0,
      ]));
    };

    return {
      invalidate(tick) { if (tick <= simTick) simTick = -Infinity; },
      status: () => `sim ${simTick === -Infinity ? '-' : simTick}  N ${shown}  gpu≡cpu ${check}`,
      frame({ enc, out, cpu: c, tick, sub, raw: F }) {
        const target = out.out, u = c.u as Int32Array;
        if (mapAt !== null) {
          // the hash copy was submitted with the last frame: map it now
          const at = mapAt;
          mapAt = null;
          readback.mapAsync(GPUMapMode.READ).then(() => {
            const h = new Uint32Array(readback.getMappedRange().slice(0))[0];
            readback.unmap();
            cpu.gpuHash(at, h);
          });
        }
        const n = budget.n(tick), cap = budget.cap;
        const simulate = cap === null || n <= cap;
        const dust = cap === null ? 0 : simulate ? Math.min(DUST_MAX, cap - n) : cap;
        shown = simulate ? `${n}${dust ? ` + dust ${dust}` : ''}` : `dust ${dust} only (room N ${n} > this host's ${cap}, until the next reseed)`;
        writeDraw(target, u, tick, sub, n, simulate ? 1 : 4);
        if (!simulate) {
          const rp = clearPass(enc, target);
          rp.setPipeline(dustPipe); rp.setBindGroup(0, dustBg); rp.draw(6, dust); rp.end();
          return;
        }

        ensure(n);
        if (n !== simN) { simTick = -Infinity; simN = n; } // N only changes on a reseed boundary
        const groups = Math.ceil(n / 256);
        const slots = new ArrayBuffer(SLOT * (MAX_STEPS + 2));
        let used = 0;
        const slot = (v: Int32Array, count: number) => {
          const w = new Int32Array(slots, used * SLOT, 8);
          w.set(v); w[6] = count; w[7] = 0;
          return used++ * SLOT;
        };
        const e0 = epochOf(tick) * RESEED_TICKS;
        const reseed = simTick < e0 || simTick > tick;
        const now = performance.now();
        // any tick works, also one mid fast-forward: right after a reseed the CPU is then only <= MAX_STEPS behind
        const doCheck = !cpu.busy && mapAt === null && now - lastCheck > CHECK_MS;
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
          lastCheck = now;
          cpu.start(simTick);
          mapAt = simTick; // mapped next frame (frame returns before the engine submits)
        }
        const r = cpu.step(simTick, F);
        if (r) {
          const ms = `cpu ≤${r.worst.toFixed(1)} ms/frame`;
          check = r.gpu === r.cpu ? `✓ ${hex8(r.gpu)} (${ms})` : `✗ gpu ${hex8(r.gpu)} cpu ${hex8(r.cpu)} (${ms})`;
        }
        const rp = clearPass(enc, target);
        rp.setPipeline(drawPipe); rp.setBindGroup(0, drawBg); rp.draw(6, n);
        if (dust > 0) { rp.setPipeline(dustPipe); rp.setBindGroup(0, dustBg); rp.draw(6, dust); }
        rp.end();
      },

      /**
       * Particles this GPU can step and draw within BENCH_BUDGET_MS of a frame: times BENCH_N-particle
       * step + draw rounds into a 1280x720 target, scales linearly, floors to a power of two.
       */
      async bench() {
        ensure(BENCH_N);
        const target = device.createTexture({ size: [1280, 720], format: HDR, usage: GPUTextureUsage.RENDER_ATTACHMENT });
        const round = (steps: number) => {
          const enc = device.createCommandEncoder(), slots = new ArrayBuffer(SLOT * (MAX_STEPS + 2));
          new Int32Array(slots, 0, 8).set([0, 1, 0, 0, 0, 0, BENCH_N, 0]);
          const c = enc.beginComputePass();
          c.setPipeline(pSeed); c.setBindGroup(0, csBg, [0]); c.dispatchWorkgroups(BENCH_N / 256); c.end();
          for (let k = 1; k <= steps; k++) {
            new Int32Array(slots, k * SLOT, 8).set([k, 1, 40, 0, 640, 360, BENCH_N, 0]);
            const cs = enc.beginComputePass();
            cs.setPipeline(pStep); cs.setBindGroup(0, csBg, [k * SLOT]); cs.dispatchWorkgroups(BENCH_N / 256); cs.end();
            const rp = clearPass(enc, target);
            rp.setPipeline(drawPipe); rp.setBindGroup(0, drawBg); rp.draw(6, BENCH_N); rp.end();
          }
          device.queue.writeBuffer(params, 0, slots, 0, SLOT * (steps + 1));
          writeDraw(target, Int32Array.of(0, 0, 128), 0, 0, BENCH_N);
          device.queue.submit([enc.finish()]);
          return device.queue.onSubmittedWorkDone();
        };
        await round(4); // warm-up: pipelines, caches, clocks
        const steps = MAX_STEPS - 2, t0 = performance.now();
        await round(steps);
        const perStep = (performance.now() - t0) / steps;
        target.destroy();
        simTick = -Infinity; // the probe overwrote the particles
        const n = (BENCH_N * BENCH_BUDGET_MS) / Math.max(perStep, 1e-3);
        return 2 ** Math.max(Math.log2(FLOW_N_MIN), Math.min(Math.log2(FLOW_N_MAX), Math.floor(Math.log2(n))));
      },
    };
  },
});
