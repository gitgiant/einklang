// One fullscreen pass. Which way every tile faces is closed-form: the shader replays the hits of the
// last two bars (found here in the onset history) on top of the bar wipes, so there is no state.
import { definePiece, oklabToLinear, oklch, BAR_TICKS, TICKS_PER_BEAT, type Palette } from '../../../api/index.ts';

const MAX_EV = 32, HEAD = 24, PAL = 8;
/** wipe option -> bars per cycle (0 = off) */
const WIPE = [4, 2, 0];
/** faces option -> the backs a flip can show (1 duotone, 2 dots, 3 neon, 4 mosaic) */
const FACES = [[1, 2, 3, 4], [1, 2], [3, 4]];

type Rand = (a: number, b?: number) => number;

/** The face the whole wall turns to on bar `b` (0 = the picture). */
function baseFace(b: number, every: number, faces: number[], rand: Rand): number {
  if (!every || b < 0 || b % every !== every - 1) return 0;
  return faces[Math.floor(rand(b, 11) * faces.length) % faces.length];
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
  gpu: ({ device, shader, formats }) => {
    const mod = shader('flips.wgsl');
    const pipe = device.createRenderPipeline({
      layout: 'auto', label: 'claude-media-flips',
      vertex: { module: mod, entryPoint: 'vs_full' },
      fragment: { module: mod, entryPoint: 'fs_flips', targets: [{ format: formats.tex }] },
    });
    const samp = device.createSampler({ magFilter: 'linear', minFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' });
    const data = new Float32Array(HEAD + PAL * 4 + MAX_EV * 4);
    const ubuf = device.createBuffer({ size: data.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    return {
      frame({ enc, in: ins, out, params: P, tick, sub, past, rand, audio, time }) {
        const w = out.out.width, h = out.out.height, aspect = w / h;
        const cols = Math.round(P.tiles as number), rows = Math.max(2, Math.round(cols / aspect));
        const every = WIPE[P.wipe as number] ?? 4, faces = FACES[P.faces as number] ?? FACES[0];
        const fs = sub / 256, sec = (t: number) => t / 60;
        // the bar grid (fixed, from tick 0, like sections)
        const b = Math.floor(tick / BAR_TICKS), inBar = tick - b * BAR_TICKS;
        // hits: an onset with none in the `space` beats before it; newest first, back to the previous bar's start
        const space = Math.max(1, Math.round((P.space as number) * TICKS_PER_BEAT));
        const reach = Math.min(600 - space - 1, inBar + BAR_TICKS + 30);
        const on: boolean[] = [];
        for (let ago = 0; ago <= reach + space; ago++) on.push(past(ago).onset);
        const ev: number[][] = [];
        for (let ago = 0; ago <= reach && ev.length < MAX_EV; ago++) {
          if (!on[ago]) continue;
          let lone = true;
          for (let j = 1; j <= space; j++) if (on[ago + j]) { lone = false; break; }
          if (!lone) continue;
          const born = tick - ago;
          const face = faces[Math.floor(rand(born, 2) * faces.length) % faces.length];
          const pattern = Math.floor(rand(born, 3) * 6) % 6;
          const loud = Math.min(1, past(ago).rms * 3);
          ev.push([sec(ago + fs), rand(born, 1), face + 8 * pattern, 0.45 + 0.55 * loud]);
        }
        ev.reverse(); // oldest first: the shader replays them in order
        let bass = 0;
        for (let i = 0; i < 3; i++) bass += audio.bands[i] / 3;
        const stops = (ins.palette as Palette | undefined)?.stops ?? Array.from({ length: 6 }, (_, i) => oklch(0.3 + i * 0.1, 0.14, audio.pal + i / 7));
        data.fill(0);
        data.set([
          w, h, time, aspect,
          cols, rows, P.gap as number, P.flip as number,
          sec(inBar + fs), sec(BAR_TICKS), baseFace(b, every, faces, rand), baseFace(b - 1, every, faces, rand),
          Math.floor(rand(b, 12) * 4), Math.floor(rand(b - 1, 12) * 4), sec(TICKS_PER_BEAT) * 0.9, ev.length,
          bass * (P.bass as number), audio.phase, P.depth as number, P.glow as number,
          PAL, P.density as number, 0, 0,
        ]);
        palColours(stops.slice(0, PAL)).forEach((c, i) => data.set(c, HEAD + i * 4));
        ev.forEach((e, i) => data.set(e, HEAD + PAL * 4 + i * 4));
        device.queue.writeBuffer(ubuf, 0, data);
        const bg = device.createBindGroup({
          layout: pipe.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: { buffer: ubuf } },
            { binding: 1, resource: samp },
            { binding: 2, resource: (ins.in as GPUTexture).createView() },
          ],
        });
        const rp = enc.beginRenderPass({ colorAttachments: [{ view: out.out.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }] });
        rp.setPipeline(pipe); rp.setBindGroup(0, bg); rp.draw(3); rp.end();
      },
      dispose: () => ubuf.destroy(),
    };
  },
});
