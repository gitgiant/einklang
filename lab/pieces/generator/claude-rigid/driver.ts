import { definePiece, oklch, type Audio, type Palette } from '../../../api/index.ts';
import { Stage } from './stage.ts';

// Rigid-body knockdown. The physics is a small Box2D-lite world on the CPU (stage.ts, physics.ts:
// ~30 bodies, two 120 Hz steps per tick), kept in this instance (not synced). Per elapsed tick: a
// bass-heavy onset kicks the most intact structure up and apart, harder the louder it is; a light
// onset rattles what stands; long quiet spells get a soft kick of their own. Bodies are drawn on the
// GPU as instanced SDF shapes (floor reflection, shadow, body), over a backdrop with kick rings.

const DRAW_BYTES = (16 + 16 + 32) * 4, INST = 12, MAX_CATCHUP = 4, SUBSTEPS = 2;

const bassOf = (f: Audio) => (f.bands[0] + f.bands[1] + f.bands[2]) / 3;

export default definePiece({
  gpu: ({ device, shader }) => {
    const mod = shader('draw.wgsl');
    const blend: GPUBlendState = {
      color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
      alpha: { srcFactor: 'zero', dstFactor: 'one', operation: 'add' },
    };
    const bg = device.createRenderPipeline({
      label: 'claude-rigid backdrop', layout: 'auto',
      vertex: { module: mod, entryPoint: 'vs_full' },
      fragment: { module: mod, entryPoint: 'fs_bg', targets: [{ format: 'rgba16float' }] },
    });
    const shapes = device.createRenderPipeline({
      label: 'claude-rigid bodies', layout: 'auto',
      vertex: { module: mod, entryPoint: 'vs_body' },
      fragment: { module: mod, entryPoint: 'fs_body', targets: [{ format: 'rgba16float', blend }] },
    });
    const drawU = device.createBuffer({ label: 'claude-rigid draw u', size: DRAW_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const df = new Float32Array(DRAW_BYTES / 4);
    const stage = new Stage();
    const N = stage.count;
    const inst = device.createBuffer({ label: 'claude-rigid bodies', size: N * INST * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    const id = new Float32Array(N * INST);
    const bgBg = device.createBindGroup({ layout: bg.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: drawU } }] });
    const shapeBg = device.createBindGroup({ layout: shapes.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: drawU } }, { binding: 1, resource: { buffer: inst } }] });

    let lastTick = -Infinity, lastKick = 0;

    return {
      frame({ enc, out, in: ins, params, audio, time, tick, past, rand, width, height }) {
        let ticks = tick - lastTick;
        if (ticks < 0 || ticks > 120) { stage.reset(); ticks = 1; lastKick = stage.t; }
        ticks = Math.min(ticks, MAX_CATCHUP);
        lastTick = tick;
        stage.restack = params.restack as number;
        const impulse = params.impulse as number, rattle = params.rattle as number, idle = params.idle as number;
        const speed = params.speed as number;
        for (let k = ticks - 1; k >= 0; k--) {
          const f = past(k), t0 = tick - k, bass = bassOf(f);
          // a kick knocks a structure that stands (mostly rebuilt); with none standing it rattles
          const g = stage.pick(rand(t0, 21)), up = stage.intact(g) > 0.6;
          if (f.onset && bass > 0.5 && impulse > 0 && up) {
            stage.kick(g, stage.groupX(g) + (rand(t0, 22) - 0.5) * 0.2, impulse * (0.6 + 2.2 * f.rms) * (0.5 + 0.5 * bass), (i) => rand(t0, 30 + i) - 0.5);
            lastKick = stage.t;
          } else if (f.onset && rattle > 0) {
            stage.rattle(rattle * (0.3 + 1.2 * f.rms) * (bass > 0.5 ? 1.5 : 1), (k) => rand(t0, 200 + k));
          } else if (idle > 0 && stage.t - lastKick > idle && f.rms > 0.06 && up) {
            stage.kick(g, stage.groupX(g) + (rand(t0, 24) - 0.5) * 0.2, impulse * (0.5 + 1.5 * f.rms), (i) => rand(t0, 60 + i) - 0.5);
            lastKick = stage.t;
          }
          for (let s = 0; s < SUBSTEPS; s++) stage.step(speed / (60 * SUBSTEPS));
        }

        for (let i = 0; i < N; i++) {
          const b = stage.body(i), s = stage.slots[i], o = i * INST;
          id[o] = b.x; id[o + 1] = b.y; id[o + 2] = b.a; id[o + 3] = b.shape;
          id[o + 4] = b.hx; id[o + 5] = b.hy; id[o + 6] = s.tone; id[o + 7] = Math.min(1.5, stage.glow[i]);
          id[o + 8] = b.ghost ? 1 : 0; id[o + 9] = stage.hold(i); id[o + 10] = 0; id[o + 11] = 0;
        }
        device.queue.writeBuffer(inst, 0, id);

        let bass = 0, kick = 0;
        for (let ago = 0; ago < 6; ago++) bass += bassOf(past(ago)) / 6;
        for (const k of stage.kicks) { const age = stage.t - k.t; if (age < 0.5) kick = Math.max(kick, Math.min(1, k.amp / 3) * Math.exp(-age * 8)); }
        const aspect = width / height, vh = (params.view as number) * Math.max(1, 1.82 / aspect);
        // the camera punches in and shakes on each kick
        const shake = kick * 0.012 * (params.shake as number);
        const cx = shake * Math.sin(time * 71), cy = 0.4 * vh / 0.95 + shake * Math.cos(time * 53);
        const pal = (ins.palette as Palette | undefined)?.stops ?? Array.from({ length: 7 }, (_, i) => oklch(0.12 + i * 0.13, 0.13, audio.pal + 0.05 + i / 9));
        const bps = (audio.bpm > 0 ? audio.bpm : 120) / 60;
        df.fill(0);
        df.set([cx, cy, vh * (1 - 0.025 * kick), aspect], 0);
        df.set([vh / height, time, params.glow as number, params.bg as number], 4);
        df.set([0.06 * Math.sin(((time * bps) / 16) * (params.cycle as number) * Math.PI * 2), Math.min(8, pal.length), bass, N], 8);
        df.set([params.reflect as number, kick, 0, 0], 12);
        stage.kicks.slice(-4).forEach((k, j) => df.set([k.x, stage.t - k.t, k.amp, 0], 16 + j * 4));
        pal.slice(0, 8).forEach((st, i) => df.set(st, 32 + i * 4));
        device.queue.writeBuffer(drawU, 0, df);

        const rp = enc.beginRenderPass({ colorAttachments: [{ view: out.out.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }] });
        rp.setPipeline(bg); rp.setBindGroup(0, bgBg); rp.draw(3);
        rp.setPipeline(shapes); rp.setBindGroup(0, shapeBg); rp.draw(6, N * 3);
        rp.end();
      },
      dispose: () => { drawU.destroy(); inst.destroy(); },
      status: () => `${N} bodies`,
    };
  },
});
