// Sprite tools (node): everything that becomes a `.spr` sheet (lab/api/sprite.ts) goes through here.
//   import: PNG strips/grids, Aseprite JSON + PNG, GIF, .vox z-slices, code-drawn recipes (*.sprite.json)
//   gen post-processing: background removal, downscale, quantize to a palette
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { encodeSheet, hexToOklab, linearToOklab, parseVox, srgbToLinear, voxWorld, type Sheet, type SpriteTag } from '../../lab/api/index.ts';
import { decodeGif, decodePng, type Rgba } from './png.ts';

export type Rgb = [number, number, number];

/** Frames (each w x h RGBA8) -> an indexed sheet. Alpha < 128 is transparent (index 0). */
export function toSheet(frames: Uint8Array[], w: number, h: number, opts: { palette?: Rgb[]; durations?: number[]; tags?: SpriteTag[]; maxColors?: number } = {}): Sheet {
  if (!frames.length) throw new Error('no frames');
  if (frames.length > 256) throw new Error(`${frames.length} frames: at most 256`);
  let pal: Rgb[];
  if (opts.palette) pal = opts.palette.slice(0, 255);
  else {
    const uniq = new Map<number, Rgb>();
    for (const f of frames) for (let i = 0; i < w * h; i++) if (f[i * 4 + 3] >= 128) uniq.set((f[i * 4] << 16) | (f[i * 4 + 1] << 8) | f[i * 4 + 2], [f[i * 4], f[i * 4 + 1], f[i * 4 + 2]]);
    const k = Math.max(1, Math.min(255, opts.maxColors ?? 255));
    pal = uniq.size <= k ? [...uniq.values()] : medianCut(frames, w * h, k);
  }
  const labs = pal.map(toLab), exact = new Map(pal.map((c, i) => [(c[0] << 16) | (c[1] << 8) | c[2], i + 1]));
  const pixels = new Uint8Array(frames.length * w * h), cache = new Map<number, number>();
  frames.forEach((f, fi) => {
    for (let i = 0; i < w * h; i++) {
      if (f[i * 4 + 3] < 128) continue;
      const key = (f[i * 4] << 16) | (f[i * 4 + 1] << 8) | f[i * 4 + 2];
      let c = exact.get(key) ?? cache.get(key);
      if (c === undefined) { c = nearest(toLab([f[i * 4], f[i * 4 + 1], f[i * 4 + 2]]), labs) + 1; cache.set(key, c); }
      pixels[fi * w * h + i] = c;
    }
  });
  const palette = new Uint8Array((pal.length + 1) * 4);
  pal.forEach((c, i) => palette.set([...c, 255], (i + 1) * 4));
  return { w, h, frames: frames.length, palette, pixels, durations: Uint16Array.from(frames.map((_, i) => Math.min(65535, opts.durations?.[i] ?? 0))), tags: opts.tags ?? [] };
}

const toLab = (c: Rgb) => linearToOklab([srgbToLinear(c[0]), srgbToLinear(c[1]), srgbToLinear(c[2])]);
function nearest(l: Rgb, labs: Rgb[]): number {
  let best = 0, bd = Infinity;
  labs.forEach((m, i) => { const d = (l[0] - m[0]) ** 2 + (l[1] - m[1]) ** 2 + (l[2] - m[2]) ** 2; if (d < bd) { bd = d; best = i; } });
  return best;
}

/** Median-cut palette of the opaque pixels. */
function medianCut(frames: Uint8Array[], n: number, k: number): Rgb[] {
  const px: Rgb[] = [];
  for (const f of frames) for (let i = 0; i < n; i++) if (f[i * 4 + 3] >= 128) px.push([f[i * 4], f[i * 4 + 1], f[i * 4 + 2]]);
  let boxes = [px];
  while (boxes.length < k) {
    let bi = -1, range = 0, axis = 0;
    boxes.forEach((b, i) => { if (b.length < 2) return; for (let a = 0; a < 3; a++) { let lo = 255, hi = 0; for (const p of b) { lo = Math.min(lo, p[a]); hi = Math.max(hi, p[a]); } if (hi - lo > range) { range = hi - lo; bi = i; axis = a; } } });
    if (bi < 0) break;
    const b = boxes[bi].sort((x, y) => x[axis] - y[axis]), mid = b.length >> 1;
    boxes.splice(bi, 1, b.slice(0, mid), b.slice(mid));
  }
  return boxes.filter((b) => b.length).map((b) => [0, 1, 2].map((a) => Math.round(b.reduce((s, p) => s + p[a], 0) / b.length)) as Rgb);
}

/** A grid of equal frames, row-major. */
export function fromStrip(img: Rgba, fw: number, fh: number, count?: number): Uint8Array[] {
  const cols = Math.floor(img.w / fw), rows = Math.floor(img.h / fh), out: Uint8Array[] = [];
  if (!cols || !rows) throw new Error(`frame ${fw}x${fh} is bigger than the ${img.w}x${img.h} image`);
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    if (count !== undefined && out.length >= count) return out;
    out.push(crop(img, c * fw, r * fh, fw, fh));
  }
  return out;
}

export function crop(img: Rgba, x0: number, y0: number, w: number, h: number): Uint8Array {
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const X = x0 + x, Y = y0 + y;
    if (X < 0 || Y < 0 || X >= img.w || Y >= img.h) continue;
    out.set(img.data.subarray((Y * img.w + X) * 4, (Y * img.w + X) * 4 + 4), (y * w + x) * 4);
  }
  return out;
}

interface AseFrame { frame: { x: number; y: number; w: number; h: number }; spriteSourceSize?: { x: number; y: number }; sourceSize?: { w: number; h: number }; duration?: number }
/** Aseprite's JSON export (array or hash frames, trimmed or not) + its sheet image. */
export function fromAseprite(json: { frames: AseFrame[] | Record<string, AseFrame>; meta?: { frameTags?: { name: string; from: number; to: number }[] } }, img: Rgba): Sheet {
  const frames = Array.isArray(json.frames) ? json.frames : Object.values(json.frames);
  if (!frames.length) throw new Error('Aseprite JSON has no frames');
  const w = frames[0].sourceSize?.w ?? frames[0].frame.w, h = frames[0].sourceSize?.h ?? frames[0].frame.h;
  const rgba = frames.map((f) => {
    const out = new Uint8Array(w * h * 4), part = crop(img, f.frame.x, f.frame.y, f.frame.w, f.frame.h), ox = f.spriteSourceSize?.x ?? 0, oy = f.spriteSourceSize?.y ?? 0;
    for (let y = 0; y < f.frame.h; y++) for (let x = 0; x < f.frame.w; x++) if (x + ox < w && y + oy < h) out.set(part.subarray((y * f.frame.w + x) * 4, (y * f.frame.w + x) * 4 + 4), ((y + oy) * w + x + ox) * 4);
    return out;
  });
  return toSheet(rgba, w, h, { durations: frames.map((f) => f.duration ?? 0), tags: (json.meta?.frameTags ?? []).map((t) => ({ name: t.name, from: t.from, to: t.to })) });
}

/** Each z-slice (bottom up) of a .vox scene as a frame, viewed from above. */
export function fromVox(bytes: Uint8Array): Sheet {
  const f = parseVox(bytes), wv = voxWorld(f, false);
  const w = wv.max[0] - wv.min[0] + 1, h = wv.max[1] - wv.min[1] + 1, d = wv.max[2] - wv.min[2] + 1;
  if (w > 256 || h > 256 || d > 256) throw new Error(`vox ${w}x${h}x${d}: slices are at most 256 per side`);
  const frames = Array.from({ length: d }, () => new Uint8Array(w * h * 4));
  for (let i = 0; i < wv.count; i++) {
    const x = wv.pos[i * 3] - wv.min[0], y = wv.max[1] - wv.pos[i * 3 + 1], z = wv.pos[i * 3 + 2] - wv.min[2];
    const [r, g, b] = f.palette[wv.color[i]];
    frames[z].set([r, g, b, 255], (y * w + x) * 4);
  }
  return toSheet(frames, w, h);
}

/**
 * A code-drawn sprite: `{ w, h, palette: { "a": "#ff00aa", ... }, frames: [["....aa..", ...], ...], durations?, tags? }`.
 * '.' and ' ' are transparent; rows shorter than w are padded.
 */
export interface Recipe { w: number; h: number; palette: Record<string, string>; frames: string[][]; durations?: number[]; tags?: SpriteTag[] }
export function fromRecipe(r: Recipe): Sheet {
  const cols = new Map<string, Rgb>();
  for (const [k, hex] of Object.entries(r.palette)) {
    if (k.length !== 1 || k === '.' || k === ' ') throw new Error(`palette key ${JSON.stringify(k)}: one character, not '.' or ' '`);
    if (!hexToOklab(hex)) throw new Error(`palette ${k}: ${hex} is not #rrggbb`);
    const n = parseInt(hex.replace('#', ''), 16);
    cols.set(k, [n >> 16, (n >> 8) & 255, n & 255]);
  }
  const frames = r.frames.map((rows, fi) => {
    if (rows.length > r.h) throw new Error(`frame ${fi}: ${rows.length} rows, h is ${r.h}`);
    const out = new Uint8Array(r.w * r.h * 4);
    rows.forEach((row, y) => [...row].forEach((ch, x) => {
      if (ch === '.' || ch === ' ') return;
      const c = cols.get(ch);
      if (!c) throw new Error(`frame ${fi} row ${y}: '${ch}' is not in the palette`);
      if (x < r.w) out.set([...c, 255], (y * r.w + x) * 4);
    }));
    return out;
  });
  return toSheet(frames, r.w, r.h, { palette: [...cols.values()], durations: r.durations, tags: r.tags });
}

/** Import any supported file. `frame`: WxH for PNG grids (default: the whole image is one frame). */
export function importSprite(file: string, opts: { frame?: [number, number]; count?: number } = {}): Sheet {
  const lower = file.toLowerCase(), bytes = readFileSync(file);
  if (lower.endsWith('.sprite.json')) return fromRecipe(JSON.parse(bytes.toString('utf8')));
  if (lower.endsWith('.json')) {
    const j = JSON.parse(bytes.toString('utf8'));
    const image = j.meta?.image as string | undefined;
    if (!image) throw new Error('Aseprite JSON without meta.image');
    return fromAseprite(j, decodePng(readFileSync(join(dirname(file), image))));
  }
  if (lower.endsWith('.png')) {
    const img = decodePng(bytes), [fw, fh] = opts.frame ?? [img.w, img.h];
    return toSheet(fromStrip(img, fw, fh, opts.count), fw, fh);
  }
  if (lower.endsWith('.gif')) { const g = decodeGif(bytes); return toSheet(g.frames, g.w, g.h, { durations: g.delays }); }
  if (lower.endsWith('.vox')) return fromVox(bytes);
  throw new Error(`can't import ${file}: PNG, Aseprite JSON, GIF, .vox or *.sprite.json`);
}

export const sheetBytes = (s: Sheet) => encodeSheet(s);

// ------------------------------------------------------------------ gen post-processing

/** Make the background transparent: flood fill from the borders over pixels close to the corner colour. */
export function removeBackground(img: Rgba, tolerance = 0.08): Rgba {
  const { w, h } = img, d = img.data.slice();
  const opaque = (() => { for (let i = 3; i < d.length; i += 4) if (d[i] < 250) return false; return true; })();
  if (!opaque) return { w, h, data: d }; // the model already gave us alpha
  const corners = [0, w - 1, (h - 1) * w, h * w - 1].map((i) => toLab([d[i * 4], d[i * 4 + 1], d[i * 4 + 2]]));
  const bg = corners.reduce((a, c) => [a[0] + c[0] / 4, a[1] + c[1] / 4, a[2] + c[2] / 4], [0, 0, 0] as Rgb);
  const near = (i: number) => { const l = toLab([d[i * 4], d[i * 4 + 1], d[i * 4 + 2]]); return Math.hypot(l[0] - bg[0], l[1] - bg[1], l[2] - bg[2]) < tolerance; };
  const seen = new Uint8Array(w * h), stack: number[] = [];
  for (let x = 0; x < w; x++) stack.push(x, (h - 1) * w + x);
  for (let y = 0; y < h; y++) stack.push(y * w, y * w + w - 1);
  while (stack.length) {
    const i = stack.pop()!;
    if (seen[i]) continue;
    seen[i] = 1;
    if (!near(i)) continue;
    d[i * 4 + 3] = 0;
    const x = i % w, y = (i / w) | 0;
    if (x > 0) stack.push(i - 1); if (x < w - 1) stack.push(i + 1); if (y > 0) stack.push(i - w); if (y < h - 1) stack.push(i + w);
  }
  return { w, h, data: d };
}

/** Box-filter downscale (alpha-weighted colour; a pixel is opaque when most of its box is). */
export function downscale(img: Rgba, w: number, h: number): Rgba {
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const x0 = Math.floor((x * img.w) / w), x1 = Math.max(x0 + 1, Math.floor(((x + 1) * img.w) / w));
    const y0 = Math.floor((y * img.h) / h), y1 = Math.max(y0 + 1, Math.floor(((y + 1) * img.h) / h));
    let r = 0, g = 0, b = 0, a = 0, n = 0;
    for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) {
      const i = (yy * img.w + xx) * 4, al = img.data[i + 3] / 255;
      r += img.data[i] * al; g += img.data[i + 1] * al; b += img.data[i + 2] * al; a += al; n++;
    }
    out.set(a ? [r / a, g / a, b / a, (a / n) * 255].map(Math.round) : [0, 0, 0, 0], (y * w + x) * 4);
  }
  return { w, h, data: out };
}

/** '#rrggbb' strings -> RGB triples. */
export function parsePalette(list: string[]): Rgb[] {
  return list.map((hex) => {
    if (!hexToOklab(hex)) throw new Error(`palette: ${hex} is not #rrggbb`);
    const n = parseInt(hex.replace('#', ''), 16);
    return [n >> 16, (n >> 8) & 255, n & 255];
  });
}
