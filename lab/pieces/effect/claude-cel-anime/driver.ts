// Two passes: the picture through the action-cut camera (or a drawn landscape when nothing is picked)
// into a scratch texture, then the cel pass over it. Every event (kicks, onsets, impact frames) is
// found in the onset history here, so the look is a pure function of the tick: no state.
import { definePiece, oklabToLinear, oklch, BAR_TICKS, TICKS_PER_BEAT, type Audio, type Palette } from '../../../api/index.ts';

const HEAD = 32, PAL = 8;
/** How far back the history is scanned for kicks and onsets (ticks). */
const REACH = 150;

/** 8 linear-RGB colours along the palette (OKLab-interpolated), for a plain lerp in the shader. */
function palColours(stops: [number, number, number][]): number[][] {
  const n = stops.length;
  return Array.from({ length: PAL }, (_, i) => {
    const f = (i / (PAL - 1)) * (n - 1), j = Math.min(Math.floor(f), n - 1), k = Math.min(j + 1, n - 1), t = f - j;
    return oklabToLinear([0, 1, 2].map((c) => stops[j][c] + (stops[k][c] - stops[j][c]) * t) as [number, number, number]);
  });
}

const bassOf = (a: Audio) => (a.bands[0] + a.bands[1] + a.bands[2]) / 3;

export default definePiece({
  gpu: ({ device, shader, formats, media }) => {
    const mod = shader('cel.wgsl');
    const mk = (entry: string, label: string) => device.createRenderPipeline({
      layout: 'auto', label,
      vertex: { module: mod, entryPoint: 'vs_full' },
      fragment: { module: mod, entryPoint: entry, targets: [{ format: formats.tex }] },
    });
    const srcPipe = mk('fs_src', 'claude-cel-anime src'), celPipe = mk('fs_cel', 'claude-cel-anime cel');
    const samp = device.createSampler({ magFilter: 'linear', minFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' });
    const data = new Float32Array(HEAD + PAL * 4);
    const ubuf = device.createBuffer({ size: data.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST, label: 'claude-cel-anime' });
    let scratch: GPUTexture | null = null;
    return {
      frame({ enc, in: ins, out, params: P, tick, sub, past, rand, audio, time }) {
        const w = out.out.width, h = out.out.height;
        if (!scratch || scratch.width !== w || scratch.height !== h) {
          scratch?.destroy();
          scratch = device.createTexture({ size: [w, h], format: formats.tex, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING, label: 'claude-cel-anime scratch' });
        }
        const subject = P.subject as number;
        const has = subject === 1 || (subject === 0 && media.count() > 0);
        const fs = sub / 256;
        // history, oldest first: kicks are bassy onsets at least `space` beats apart
        const space = Math.max(1, Math.round((P.space as number) * TICKS_PER_BEAT));
        let lastKick = -1e9, kick = -1, hit = -1, rate = 0;
        const barStart = Math.floor(tick / BAR_TICKS) * BAR_TICKS;
        let firstKickInBar = -1;
        for (let ago = REACH; ago >= 0; ago--) {
          const a = past(ago);
          if (!a.onset) continue;
          const t = tick - ago;
          hit = t;
          if (ago < 3 * TICKS_PER_BEAT) rate += 1 - ago / (3 * TICKS_PER_BEAT);
          if (bassOf(a) >= 0.3 && t - lastKick >= space) {
            lastKick = t; kick = t;
            if (t >= barStart && firstKickInBar < 0) firstKickInBar = t;
          }
        }
        const age = (t: number) => (t < 0 ? 99 : (tick - t + fs) / 60);
        const kAge = age(kick), hAge = age(hit);
        const loud = hit >= 0 ? Math.min(1, past(tick - hit).rms * 3) : 0;
        // the action cut: snap in at once, hold, ease out; a short shake on the hit
        const kEnv = kick >= 0 ? Math.exp(-kAge * 2.2) : 0;
        const zoom = 1 + (P.punch as number) * kEnv;
        const cx = kick >= 0 ? 0.5 + (rand(kick, 1) - 0.5) * 0.36 : 0.5;
        const cy = kick >= 0 ? 0.5 + (rand(kick, 2) - 0.5) * 0.26 : 0.5;
        const shake = (P.punch as number) * 0.08 * Math.exp(-kAge * 14);
        const sx = shake * Math.sin(kAge * 95), sy = shake * Math.cos(kAge * 71);
        // impact frame: the first kick of a bar, on some bars
        let impact = 0;
        if (firstKickInBar >= 0 && rand(Math.floor(tick / BAR_TICKS), 7) < (P.impact as number)) {
          const ia = age(firstKickInBar);
          impact = ia < 0.06 ? 1 : Math.max(0, 1 - (ia - 0.06) / 0.08);
        }
        const bass = bassOf(audio);
        const beat = (1 - audio.phase) ** 3;
        const light = (P.light as number) * (1 + (P.pump as number) * (0.35 * bass + 0.12 * kEnv - 0.1));
        const petals = (P.petals as number) * (0.4 + 0.6 * Math.min(1, rate / 4));
        const stops = (ins.palette as Palette | undefined)?.stops ?? Array.from({ length: 6 }, (_, i) => oklch(0.25 + i * 0.13, 0.12, 0.62 + audio.pal + i * 0.07));
        data.fill(0);
        data.set([
          w, h, time, w / h,
          has ? 1 : 0, P.bands as number, P.soft as number, light,
          P.sat as number, P.grade as number, (P.ink as number) * (1 + 0.5 * kEnv), P.ink_sense as number,
          zoom, cx, cy, P.ink_amt as number,
          hAge, hit >= 0 ? hit % 100000 : 0, loud, P.lines as number,
          petals, P.sparkle as number, P.drop as number, P.flare as number,
          bass, beat, impact, Math.min(stops.length, PAL),
          sx, sy, P.shadow as number, P.shine as number,
        ]);
        palColours(stops.slice(0, PAL)).forEach((c, i) => data.set(c, HEAD + i * 4));
        device.queue.writeBuffer(ubuf, 0, data);
        const pass = (pipe: GPURenderPipeline, from: GPUTexture, to: GPUTexture) => {
          const bg = device.createBindGroup({
            layout: pipe.getBindGroupLayout(0),
            entries: [{ binding: 0, resource: { buffer: ubuf } }, { binding: 1, resource: samp }, { binding: 2, resource: from.createView() }],
          });
          const rp = enc.beginRenderPass({ colorAttachments: [{ view: to.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }] });
          rp.setPipeline(pipe); rp.setBindGroup(0, bg); rp.draw(3); rp.end();
        };
        pass(srcPipe, ins.in as GPUTexture, scratch);
        pass(celPipe, scratch, out.out);
      },
      status: () => (media.count() > 0 ? 'cel: media' : 'cel: drawn landscape'),
      dispose: () => { ubuf.destroy(); scratch?.destroy(); },
    };
  },
});
