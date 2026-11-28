// One fullscreen pass. Everything is closed-form from the tick: the panel layout is a pure function of
// the layout index (re-rolled every bar, 2 or 4), the slide-in eases from the previous layout's cuts,
// and the bursts are the last few hits found in the onset history. No state.
import { definePiece, oklabToLinear, oklch, BAR_TICKS, TICKS_PER_BEAT, type Palette } from '../../../api/index.ts';

const MAX_BURST = 4, CUTS = 7, PAL = 8, HEAD = 32;
const EVERY = [1, 2, 4];

type Rand = (a: number, b?: number) => number;
/** A cut per heap node (0 root, children 2n+1 / 2n+2, depth 3): axis (-1 none, 0 x, 1 y), pos 0..1, slant. */
type Cut = [number, number, number];

/** The panel cuts of layout `l`: `k` cuts, the biggest panels split first, mostly across their long side. */
export function layout(l: number, k: number, slant: number, aspect: number, rand: Rand): Cut[] {
  const cuts: Cut[] = Array.from({ length: CUTS }, () => [-1, 0.5, 0] as Cut);
  const rect: [number, number, number, number][] = [[0, 0, 1, 1]];
  let leaves = [0];
  for (let s = 0; s < k; s++) {
    const open = leaves.filter((n) => n < CUTS);
    if (!open.length) break;
    // weighted by area, so the page splits evenly with a seeded twist
    let best = open[0], score = -1;
    for (const n of open) {
      const [x0, y0, x1, y1] = rect[n];
      const sc = (x1 - x0) * (y1 - y0) * (0.5 + rand(l * 31 + s, n + 3));
      if (sc > score) { score = sc; best = n; }
    }
    const [x0, y0, x1, y1] = rect[best];
    const w = (x1 - x0) * aspect, h = y1 - y0;
    let axis = w > h * 1.15 ? 0 : h > w * 1.15 ? 1 : rand(l, 40 + s) < 0.5 ? 0 : 1;
    if (rand(l, 50 + s) < 0.15) axis = 1 - axis;
    const pos = 0.34 + 0.32 * rand(l, 60 + s);
    cuts[best] = [axis, pos, (rand(l, 70 + s) * 2 - 1) * slant];
    const a = 2 * best + 1, b = 2 * best + 2;
    if (axis === 0) { const xm = x0 + (x1 - x0) * pos; rect[a] = [x0, y0, xm, y1]; rect[b] = [xm, y0, x1, y1]; }
    else { const ym = y0 + (y1 - y0) * pos; rect[a] = [x0, y0, x1, ym]; rect[b] = [x0, ym, x1, y1]; }
    leaves = leaves.filter((n) => n !== best).concat([a, b]);
  }
  return cuts;
}

/** Ease out with a little overshoot (back), 0..1. */
function back(t: number): number {
  const x = Math.min(1, Math.max(0, t)) - 1, c = 1.6;
  return 1 + (c + 1) * x * x * x + c * x * x;
}

function hex(s: unknown, dflt: [number, number, number]): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(s ?? ''));
  if (!m) return dflt;
  const v = parseInt(m[1], 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255].map((c) => (c / 255) ** 2.2) as [number, number, number];
}

/** 8 linear-RGB colours along the palette (OKLab-interpolated), for a plain lerp in the shader. */
function palColours(stops: [number, number, number][]): number[][] {
  const n = stops.length;
  return Array.from({ length: PAL }, (_, i) => {
    const f = (i / (PAL - 1)) * (n - 1), j = Math.min(Math.floor(f), n - 1), k = Math.min(j + 1, n - 1), t = f - j;
    const lab = [0, 1, 2].map((c) => stops[j][c] + (stops[k][c] - stops[j][c]) * t) as [number, number, number];
    return oklabToLinear(lab);
  });
}

export default definePiece({
  gpu: ({ device, shader, formats, media }) => {
    const mod = shader('comic.wgsl');
    const pipe = device.createRenderPipeline({
      layout: 'auto', label: 'claude-cel-comic',
      vertex: { module: mod, entryPoint: 'vs_full' },
      fragment: { module: mod, entryPoint: 'fs_comic', targets: [{ format: formats.tex }] },
    });
    const samp = device.createSampler({ magFilter: 'linear', minFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' });
    const data = new Float32Array(HEAD + PAL * 4 + CUTS * 4 + MAX_BURST * 8);
    const ubuf = device.createBuffer({ size: data.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST, label: 'claude-cel-comic' });
    let shown = '';
    return {
      frame({ enc, in: ins, out, params: P, tick, sub, past, rand, audio, time, paramAt }) {
        const w = out.out.width, h = out.out.height, aspect = w / h, fs = sub / 256;
        // the page layout: re-rolled every `relayout` bars on the fixed bar grid
        const every = (EVERY[P.relayout as number] ?? 1) * BAR_TICKS;
        const l = Math.floor(tick / every), into = tick - l * every;
        const kAt = (li: number) => Math.round(Number(paramAt('panels', Math.max(0, li * every))));
        const sl = P.slant as number;
        const cur = layout(l, kAt(l), sl, aspect, rand), prev = l > 0 ? layout(l - 1, kAt(l - 1), sl, aspect, rand) : cur;
        const e = back((into + fs) / (Math.max(0.1, P.slide as number) * TICKS_PER_BEAT));
        const cuts = cur.map((c, n): Cut => {
          if (c[0] < 0) return c;
          const p = prev[n];
          // a cut the last page also had slides over; a new one opens out of an edge
          const from = p[0] === c[0] ? p[1] : rand(l, 90 + n) < 0.5 ? 0 : 1;
          const fromSl = p[0] === c[0] ? p[2] : 0;
          return [c[0], from + (c[1] - from) * e, fromSl + (c[2] - fromSl) * e];
        });
        // hits: an onset with none in the `space` beats before it; the newest few that still show
        const space = Math.max(1, Math.round((P.space as number) * TICKS_PER_BEAT));
        const life = P.life as number, reach = Math.min(600 - space - 1, Math.ceil(life * 60) + 1);
        const on: boolean[] = [];
        for (let ago = 0; ago <= reach + space; ago++) on.push(past(ago).onset);
        const bursts: number[][] = [];
        let hit = 0;
        for (let ago = 0; ago <= reach && bursts.length < MAX_BURST; ago++) {
          if (!on[ago]) continue;
          let lone = true;
          for (let j = 1; j <= space; j++) if (on[ago + j]) { lone = false; break; }
          if (!lone) continue;
          const born = tick - ago, age = (ago + fs) / 60;
          const loud = Math.min(1, past(ago).rms * 3);
          if (!bursts.length) hit = Math.exp(-age * 7) * (0.5 + 0.5 * loud);
          bursts.push([
            0.14 + 0.72 * rand(born, 1), 0.16 + 0.68 * rand(born, 2), age, (0.13 + 0.11 * loud) * (P.bursts as number),
            (rand(born, 3) * 2 - 1) * 0.6, 9 + Math.floor(rand(born, 4) * 8), Math.floor(rand(born, 5) * 65536), loud,
          ]);
        }
        let bass = 0;
        for (let i = 0; i < 3; i++) bass += audio.bands[i] / 3;
        bass = Math.min(1, bass * (P.bass as number));
        const beat = (1 - audio.phase) ** 3;
        const stops = (ins.palette as Palette | undefined)?.stops
          ?? [oklch(0.2, 0.05, 0.75), oklch(0.45, 0.16, 0.7), oklch(0.6, 0.2, 0.08), oklch(0.85, 0.17, 0.25), oklch(0.96, 0.03, 0.25)];
        const s = 1080 / h; // params are in 1080p pixels
        data.fill(0);
        data.set([
          w, h, time, aspect,
          P.bands as number, (P.ink as number) * (1 + 0.6 * bass + 0.3 * hit) / s, (P.dots as number) * (1 + 0.35 * bass + 0.15 * beat) / s, P.shade as number,
          P.sat as number, P.tint as number, P.benday as number, P.blacks as number,
          P.gutter as number, 0.0042 + (P.gutter as number) * 0.25, l % 65536, bursts.length,
          hit * (P.punch as number), bass, P.wobble as number, (into + fs) / every,
          P.detail as number, P.lines as number, life, Math.min(PAL, stops.length),
        ]);
        data.set([...hex(P.paper, [0.88, 0.8, 0.62]), 1], 24);
        data.set([...hex(P.inkc, [0.004, 0.003, 0.008]), 1], 28);
        palColours(stops.slice(0, PAL)).forEach((c, i) => data.set(c, HEAD + i * 4));
        cuts.forEach((c, i) => data.set(c, HEAD + PAL * 4 + i * 4));
        bursts.forEach((b, i) => data.set(b, HEAD + PAL * 4 + CUTS * 4 + i * 8));
        device.queue.writeBuffer(ubuf, 0, data);
        // nothing picked on this host: ink the generator instead of the media fallback
        const subj = ins.subject as GPUTexture | undefined;
        const src = media.count() === 0 && subj ? subj : (ins.in as GPUTexture);
        shown = src === subj ? 'comic: subject (no media)' : 'comic: picture';
        const bg = device.createBindGroup({
          layout: pipe.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: { buffer: ubuf } },
            { binding: 1, resource: samp },
            { binding: 2, resource: src.createView() },
          ],
        });
        const rp = enc.beginRenderPass({ colorAttachments: [{ view: out.out.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }] });
        rp.setPipeline(pipe); rp.setBindGroup(0, bg); rp.draw(3); rp.end();
      },
      status: () => shown,
      dispose: () => ubuf.destroy(),
    };
  },
});
