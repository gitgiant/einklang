import { definePiece, oklch, type Audio, type Palette } from '../../../api/index.ts';

// Metaballs. Everything is closed-form in (time, audio history): blobs orbit on seeded Lissajous
// paths, their radius follows a smoothed spectrum band, and each recent onset sends out a ring
// from the blob it picked, which swells that blob as it leaves.

const MAX_BLOBS = 16, MAX_PULSES = 4, PULSE_TICKS = 90;
const FLOATS = 12 + MAX_BLOBS * 4 + MAX_PULSES * 4 + 8 * 4;

export default definePiece({
  gpu: ({ device, shader }) => {
    const mod = shader('blobs.wgsl');
    const pipe = device.createRenderPipeline({
      label: 'claude-metaballs', layout: 'auto',
      vertex: { module: mod, entryPoint: 'vs_full' },
      fragment: { module: mod, entryPoint: 'fs_blobs', targets: [{ format: 'rgba16float' }] },
    });
    const ubuf = device.createBuffer({ label: 'claude-metaballs u', size: FLOATS * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const bg = device.createBindGroup({ layout: pipe.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: ubuf } }] });
    const data = new Float32Array(FLOATS);
    let shownN = 0;

    return {
      frame({ enc, out, in: ins, params, audio, time, tick, sub, past, rand, width, height }) {
        const aspect = width / height;
        const n = Math.min(MAX_BLOBS, Math.max(1, Math.round(params.count as number)));
        shownN = n;
        const sp = params.speed as number, size = params.size as number;
        const orbit = (i: number, t: number): [number, number] => {
          const a1 = rand(i, 101), a2 = rand(i, 102), a3 = rand(i, 103), a4 = rand(i, 104), a5 = rand(i, 105);
          const dir = a2 < 0.5 ? -1 : 1;
          const ang = t * sp * (0.15 + 0.35 * a1) * dir + a3 * 6.283;
          const rx = (0.12 + 0.6 * a4) * Math.min(aspect, 2) * 0.45, ry = 0.08 + 0.3 * a5;
          return [Math.cos(ang) * rx + 0.06 * Math.sin(t * 0.21 * sp + i), Math.sin(ang * (1 + Math.round(a1 * 2) * 0.5) + a5) * ry];
        };

        // pulses: the newest onsets within the last 1.5 s, at least 6 ticks apart
        const pulses: { src: number; age: number; s: number; c: [number, number] }[] = [];
        let lastAgo = -100;
        for (let ago = 0; ago < PULSE_TICKS && pulses.length < MAX_PULSES; ago++) {
          if (!past(ago).onset || ago - lastAgo < 6) continue;
          lastAgo = ago;
          const age = (ago + sub / 256) / 60, src = Math.floor(rand(tick - ago, 7) * n);
          pulses.push({ src, age, s: (1 - age / 1.5) ** 2, c: orbit(src, time - age) });
        }
        const kick = pulses.length && pulses[0].age < 0.4 ? (1 - pulses[0].age / 0.4) ** 2 : 0;

        // band levels smoothed over 6 ticks
        const frames: Audio[] = Array.from({ length: 6 }, (_, ago) => past(ago));
        const lvl = (b: number) => frames.reduce((a, f) => a + f.bands[b], 0) / frames.length;

        data.fill(0);
        data.set([width, height, time, aspect], 0);
        data.set([n, params.glow as number, params.edge as number, kick], 4);
        const pal = (ins.palette as Palette | undefined)?.stops ?? Array.from({ length: 6 }, (_, i) => oklch(0.45 + i * 0.07, 0.17, audio.pal + i / 8));
        data.set([Math.min(8, pal.length), audio.rms, params.depth as number, 0], 8);
        for (let i = 0; i < n; i++) {
          const [x, y] = orbit(i, time);
          const band = Math.floor((i * 16) / n);
          let swell = 0;
          for (const p of pulses) if (p.src === i) swell = Math.max(swell, p.s);
          const r = size * (0.55 + (params.react as number) * lvl(band)) * (1 + 0.6 * swell);
          data.set([x, y, r, n > 1 ? i / (n - 1) : 0.5], 12 + i * 4);
        }
        const amt = params.pulse as number;
        pulses.forEach((p, k) => data.set([p.c[0], p.c[1], 0.03 + p.age * 0.7 * amt, p.s * Math.min(1, amt)], 12 + MAX_BLOBS * 4 + k * 4));
        pal.slice(0, 8).forEach((s, i) => data.set(s, 12 + MAX_BLOBS * 4 + MAX_PULSES * 4 + i * 4));
        device.queue.writeBuffer(ubuf, 0, data);

        const rp = enc.beginRenderPass({ colorAttachments: [{ view: out.out.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }] });
        rp.setPipeline(pipe); rp.setBindGroup(0, bg); rp.draw(3); rp.end();
      },
      dispose: () => ubuf.destroy(),
      status: () => `${shownN} blobs`,
    };
  },
});
