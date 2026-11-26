// Font baker (node): TrueType outlines -> MSDF atlas, and the code-drawn pixel font -> bitmap atlas.
// Output is the `.efont` format (lab/api/font.ts). MSDF after Chlumsky's msdfgen: edges coloured so each
// corner sits between two channels, per-channel signed pseudo-distance, then a fix-up pass where the
// median disagrees with the true inside/outside.
import type { Font, Glyph } from '../../lab/api/index.ts';
import { PIXEL_5x8 } from './pixelfont.ts';

/** Printable ASCII. */
export const ASCII = Array.from({ length: 95 }, (_, i) => 32 + i);

// ------------------------------------------------------------------ TrueType

type Pt = [number, number];
/** A contour as segments: line [p0, p1] or quadratic [p0, c, p1], font units, y up. */
type Seg = Pt[];
interface TtfGlyph { contours: Seg[][]; adv: number; xMin: number; yMin: number; xMax: number; yMax: number }
export interface Ttf { upm: number; ascent: number; descent: number; lineGap: number; glyph(code: number): TtfGlyph | null }

export function parseTtf(buf: Uint8Array): Ttf {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const tables = new Map<string, number>();
  const n = dv.getUint16(4);
  for (let i = 0; i < n; i++) { const p = 12 + i * 16; tables.set(String.fromCharCode(...buf.subarray(p, p + 4)), dv.getUint32(p + 8)); }
  const t = (name: string) => { const o = tables.get(name); if (o === undefined) throw new Error(`TTF: no ${name} table (CFF/OTF outlines are not supported)`); return o; };
  const head = t('head'), hhea = t('hhea'), maxp = t('maxp'), hmtx = t('hmtx'), loca = t('loca'), glyf = t('glyf'), cmap = t('cmap');
  const upm = dv.getUint16(head + 18), longLoca = dv.getInt16(head + 50) === 1;
  const ascent = dv.getInt16(hhea + 4), descent = dv.getInt16(hhea + 6), lineGap = dv.getInt16(hhea + 8), nh = dv.getUint16(hhea + 34);
  const numGlyphs = dv.getUint16(maxp + 4);
  const locaAt = (g: number) => (longLoca ? dv.getUint32(loca + g * 4) : dv.getUint16(loca + g * 2) * 2);
  const advance = (g: number) => dv.getUint16(hmtx + Math.min(g, nh - 1) * 4);

  // cmap: format 4 (BMP) from a Unicode subtable
  let sub = -1;
  for (let i = 0; i < dv.getUint16(cmap + 2); i++) {
    const p = cmap + 4 + i * 8, plat = dv.getUint16(p), enc = dv.getUint16(p + 2), off = cmap + dv.getUint32(p + 4);
    if (dv.getUint16(off) === 4 && (plat === 0 || (plat === 3 && enc === 1))) { sub = off; break; }
  }
  if (sub < 0) throw new Error('TTF: no Unicode format 4 cmap');
  const segX2 = dv.getUint16(sub + 6), ends = sub + 14, starts = ends + segX2 + 2, deltas = starts + segX2, ranges = deltas + segX2;
  const glyphIndex = (c: number): number => {
    for (let i = 0; i < segX2 / 2; i++) {
      if (dv.getUint16(ends + i * 2) < c) continue;
      const s = dv.getUint16(starts + i * 2);
      if (s > c) return 0;
      const ro = dv.getUint16(ranges + i * 2), delta = dv.getInt16(deltas + i * 2);
      if (!ro) return (c + delta) & 0xffff;
      const gi = dv.getUint16(ranges + i * 2 + ro + (c - s) * 2);
      return gi ? (gi + delta) & 0xffff : 0;
    }
    return 0;
  };

  const outline = (g: number, depth = 0): Seg[][] => {
    if (g >= numGlyphs || depth > 8) return [];
    const off = glyf + locaAt(g);
    if (locaAt(g + 1) === locaAt(g)) return [];
    const nc = dv.getInt16(off);
    if (nc < 0) {
      // composite: components with offsets (scale ignored except a plain uniform one)
      const out: Seg[][] = [];
      let p = off + 10, more = true;
      while (more) {
        const flags = dv.getUint16(p), gi = dv.getUint16(p + 2); p += 4;
        let dx = 0, dy = 0;
        if (flags & 1) { dx = dv.getInt16(p); dy = dv.getInt16(p + 2); p += 4; } else { dx = dv.getInt8(p); dy = dv.getInt8(p + 1); p += 2; }
        let sc = 1;
        if (flags & 8) { sc = dv.getInt16(p) / 16384; p += 2; } else if (flags & 0x40) p += 4; else if (flags & 0x80) p += 8;
        for (const c of outline(gi, depth + 1)) out.push(c.map((s) => s.map(([x, y]) => [x * sc + dx, y * sc + dy] as Pt)));
        more = (flags & 0x20) !== 0;
      }
      return out;
    }
    const endPts: number[] = [];
    for (let i = 0; i < nc; i++) endPts.push(dv.getUint16(off + 10 + i * 2));
    const np = nc ? endPts[nc - 1] + 1 : 0;
    let p = off + 10 + nc * 2;
    p += 2 + dv.getUint16(p); // instructions
    const flags: number[] = [];
    while (flags.length < np) { const f = buf[p++]; flags.push(f); if (f & 8) { let r = buf[p++]; while (r--) flags.push(f); } }
    const xs: number[] = [], ys: number[] = [];
    for (const [arr, short, same] of [[xs, 2, 16], [ys, 4, 32]] as const) {
      let v = 0;
      for (const f of flags) {
        if (f & short) { const d = buf[p++]; v += f & same ? d : -d; } else if (!(f & same)) { v += dv.getInt16(p); p += 2; }
        arr.push(v);
      }
    }
    const contours: Seg[][] = [];
    let s = 0;
    for (const e of endPts) {
      const pts: { p: Pt; on: boolean }[] = [];
      for (let i = s; i <= e; i++) pts.push({ p: [xs[i], ys[i]], on: (flags[i] & 1) === 1 });
      s = e + 1;
      if (pts.length < 2) continue;
      // expand implied on-curve points between consecutive off-curve ones; start on an on-curve point
      const full: { p: Pt; on: boolean }[] = [];
      for (let i = 0; i < pts.length; i++) {
        const a = pts[i], b = pts[(i + 1) % pts.length];
        full.push(a);
        if (!a.on && !b.on) full.push({ p: [(a.p[0] + b.p[0]) / 2, (a.p[1] + b.p[1]) / 2], on: true });
      }
      const k = full.findIndex((q) => q.on);
      const ring = [...full.slice(k), ...full.slice(0, k)];
      const segs: Seg[] = [];
      for (let i = 0; i < ring.length;) {
        const a = ring[i], b = ring[(i + 1) % ring.length];
        if (b.on) { if (a.p[0] !== b.p[0] || a.p[1] !== b.p[1]) segs.push([a.p, b.p]); i++; }
        else { segs.push([a.p, b.p, ring[(i + 2) % ring.length].p]); i += 2; }
      }
      if (segs.length) contours.push(segs);
    }
    return contours;
  };

  return {
    upm, ascent, descent, lineGap,
    glyph(code) {
      const g = glyphIndex(code);
      if (!g && code !== 32) return null;
      const contours = outline(g);
      let xMin = Infinity, yMin = Infinity, xMax = -Infinity, yMax = -Infinity;
      for (const c of contours) for (const s of c) for (const [x, y] of s) { xMin = Math.min(xMin, x); yMin = Math.min(yMin, y); xMax = Math.max(xMax, x); yMax = Math.max(yMax, y); }
      if (!contours.length) xMin = yMin = xMax = yMax = 0;
      return { contours, adv: advance(g), xMin, yMin, xMax, yMax };
    },
  };
}

// ------------------------------------------------------------------ MSDF

const sub = (a: Pt, b: Pt): Pt => [a[0] - b[0], a[1] - b[1]];
const dot = (a: Pt, b: Pt) => a[0] * b[0] + a[1] * b[1];
const cross = (a: Pt, b: Pt) => a[0] * b[1] - a[1] * b[0];
const len = (a: Pt) => Math.hypot(a[0], a[1]);
const at = (s: Seg, t: number): Pt => s.length === 2
  ? [s[0][0] + (s[1][0] - s[0][0]) * t, s[0][1] + (s[1][1] - s[0][1]) * t]
  : [(1 - t) ** 2 * s[0][0] + 2 * (1 - t) * t * s[1][0] + t * t * s[2][0], (1 - t) ** 2 * s[0][1] + 2 * (1 - t) * t * s[1][1] + t * t * s[2][1]];
const tangent = (s: Seg, t: number): Pt => {
  if (s.length === 2) return sub(s[1], s[0]);
  const d: Pt = [2 * (1 - t) * (s[1][0] - s[0][0]) + 2 * t * (s[2][0] - s[1][0]), 2 * (1 - t) * (s[1][1] - s[0][1]) + 2 * t * (s[2][1] - s[1][1])];
  return len(d) ? d : sub(s[2], s[0]);
};
const norm = (a: Pt): Pt => { const l = len(a) || 1; return [a[0] / l, a[1] / l]; };

/** Closest point on a segment: parameter (unclamped hint) and distance. */
function closest(s: Seg, p: Pt): { t: number; d: number } {
  if (s.length === 2) {
    const d = sub(s[1], s[0]), t = dot(sub(p, s[0]), d) / (dot(d, d) || 1), tc = Math.max(0, Math.min(1, t));
    return { t, d: len(sub(p, at(s, tc))) };
  }
  let bt = 0, bd = Infinity;
  for (let i = 0; i <= 8; i++) { const d = len(sub(p, at(s, i / 8))); if (d < bd) { bd = d; bt = i / 8; } }
  // Newton on the squared distance
  for (let k = 0; k < 6; k++) {
    const q = at(s, bt), d1 = tangent(s, bt), d2: Pt = [2 * (s[2][0] - 2 * s[1][0] + s[0][0]), 2 * (s[2][1] - 2 * s[1][1] + s[0][1])];
    const r = sub(q, p), f = dot(r, d1), fp = dot(d1, d1) + dot(r, d2);
    if (!fp) break;
    bt = Math.max(0, Math.min(1, bt - f / fp));
  }
  // extension parameter for pseudo-distance at the ends
  const d = len(sub(p, at(s, bt)));
  let t = bt;
  if (bt === 0) { const tg = tangent(s, 0); if (dot(sub(p, s[0]), tg) < 0) t = -1; }
  if (bt === 1) { const e = s[s.length - 1], tg = tangent(s, 1); if (dot(sub(p, e), tg) > 0) t = 2; }
  return { t, d };
}

/** Signed pseudo-distance (positive = left of the direction of travel) and the orthogonality for ties. */
function signedDist(s: Seg, p: Pt): { true: number; pseudo: number; ortho: number } {
  const c = closest(s, p), tc = Math.max(0, Math.min(1, c.t)), q = at(s, tc), tg = norm(tangent(s, tc)), r = sub(p, q);
  const side = Math.sign(cross(tg, r)) || 1;
  let pseudo = side * c.d;
  if (c.t < 0 || c.t > 1) {
    // beyond an end: distance to the tangent line there
    const perp = cross(tg, r);
    if (Math.abs(perp) <= c.d) pseudo = perp;
  }
  return { true: side * c.d, pseudo, ortho: Math.abs(cross(tg, norm(r))) };
}

/** Winding number of p (non-zero = inside), quads flattened. */
function winding(contours: Seg[][], p: Pt): number {
  let w = 0;
  for (const c of contours) for (const s of c) {
    const steps = s.length === 2 ? 1 : 8;
    for (let i = 0; i < steps; i++) {
      const a = at(s, i / steps), b = at(s, (i + 1) / steps);
      if (a[1] <= p[1]) { if (b[1] > p[1] && cross(sub(b, a), sub(p, a)) > 0) w++; }
      else if (b[1] <= p[1] && cross(sub(b, a), sub(p, a)) < 0) w--;
    }
  }
  return w;
}

const RED = 1, GREEN = 2, BLUE = 4, WHITE = 7;

/** Colour each contour's edges so every corner sits between two different two-channel colours. */
function colourEdges(contours: Seg[][]): number[][] {
  return contours.map((c) => {
    const corners: number[] = [];
    for (let i = 0; i < c.length; i++) {
      const a = norm(tangent(c[(i + c.length - 1) % c.length], 1)), b = norm(tangent(c[i], 0));
      if (dot(a, b) <= 0 || Math.abs(cross(a, b)) > Math.sin(3)) corners.push(i);
    }
    if (!corners.length) return c.map(() => WHITE);
    if (corners.length === 1) {
      // teardrop: three colours around the one corner
      const k = corners[0], cols = [RED | BLUE, WHITE, GREEN | BLUE];
      return c.map((_, i) => cols[Math.min(2, Math.floor((((i - k + c.length) % c.length) * 3) / c.length))]);
    }
    const out = new Array<number>(c.length);
    const palette = [RED | GREEN, GREEN | BLUE, RED | BLUE];
    corners.forEach((start, ci) => {
      const end = corners[(ci + 1) % corners.length];
      let col = palette[ci % 2];
      if (ci === corners.length - 1 && corners.length % 2 === 1) col = palette[2];
      for (let i = start; i !== end; i = (i + 1) % c.length) out[i] = col;
    });
    return out;
  });
}

/** Bake an MSDF atlas. `size`: em in atlas pixels; `range`: distance range in atlas pixels. */
export function bakeMsdf(ttf: Ttf, opts: { name: string; size?: number; range?: number; codes?: number[] }): Font {
  const size = opts.size ?? 48, range = opts.range ?? 4, sc = size / ttf.upm, pad = Math.ceil(range);
  const codes = opts.codes ?? ASCII;
  const cells: { code: number; g: TtfGlyph; w: number; h: number; ox: number; oy: number }[] = [];
  for (const code of codes) {
    const g = ttf.glyph(code);
    if (!g) continue;
    const empty = !g.contours.length;
    const x0 = Math.floor(g.xMin * sc) - pad, x1 = Math.ceil(g.xMax * sc) + pad, y0 = Math.floor(g.yMin * sc) - pad, y1 = Math.ceil(g.yMax * sc) + pad;
    cells.push({ code, g, w: empty ? 0 : x1 - x0, h: empty ? 0 : y1 - y0, ox: x0, oy: -y1 });
  }
  const { atlasW, atlasH, pos } = pack(cells.map((c) => [c.w, c.h]));
  const px = new Uint8Array(atlasW * atlasH * 4), glyphs: Record<string, Glyph> = {};
  cells.forEach((c, gi) => {
    const [X, Y] = pos[gi];
    glyphs[c.code] = { x: X, y: Y, w: c.w, h: c.h, ox: c.ox, oy: c.oy, adv: c.g.adv * sc };
    if (!c.w) return;
    const cols = colourEdges(c.g.contours);
    const edges = c.g.contours.flatMap((ct, ci) => ct.map((s, si) => ({ s: s.map(([x, y]) => [x * sc, y * sc] as Pt), col: cols[ci][si] })));
    const flat = c.g.contours.map((ct) => ct.map((s) => s.map(([x, y]) => [x * sc, y * sc] as Pt)));
    for (let j = 0; j < c.h; j++) for (let i = 0; i < c.w; i++) {
      const p: Pt = [c.ox + i + 0.5, -(c.oy + j + 0.5)];
      const best = [RED, GREEN, BLUE].map(() => ({ d: Infinity, o: 0, pseudo: 0 }));
      let trueMin = Infinity;
      for (const e of edges) {
        const sd = signedDist(e.s, p), ad = Math.abs(sd.true);
        trueMin = Math.min(trueMin, ad);
        [RED, GREEN, BLUE].forEach((ch, k) => {
          if (!(e.col & ch)) return;
          const b = best[k];
          if (ad < b.d - 1e-9 || (Math.abs(ad - b.d) <= 1e-9 && sd.ortho > b.o)) { b.d = ad; b.o = sd.ortho; b.pseudo = sd.pseudo; }
        });
      }
      // TrueType outer contours run clockwise (y up): inside is to the right, i.e. negative cross. Flip to inside-positive.
      let ch = best.map((b) => -b.pseudo);
      const inside = winding(flat, p) !== 0, med = Math.max(Math.min(ch[0], ch[1]), Math.min(Math.max(ch[0], ch[1]), ch[2]));
      if ((med > 0) !== inside) ch = [0, 1, 2].map(() => (inside ? trueMin : -trueMin)); // fix-up: fall back to the true distance here
      const o = ((Y + j) * atlasW + X + i) * 4;
      for (let k = 0; k < 3; k++) px[o + k] = Math.max(0, Math.min(255, Math.round((0.5 + ch[k] / (2 * range)) * 255)));
      px[o + 3] = Math.max(0, Math.min(255, Math.round((0.5 + (inside ? trueMin : -trueMin) / (2 * range)) * 255)));
    }
  });
  return {
    name: opts.name, mode: 'msdf', size, range: 2 * range,
    lineHeight: Math.ceil((ttf.ascent - ttf.descent + ttf.lineGap) * sc), ascent: Math.ceil(ttf.ascent * sc),
    atlasW, atlasH, glyphs, pixels: px,
  };
}

/** Shelf-pack rects into a power-of-two-wide atlas. */
function pack(rects: [number, number][]): { atlasW: number; atlasH: number; pos: [number, number][] } {
  const area = rects.reduce((a, [w, h]) => a + (w + 1) * (h + 1), 0);
  let atlasW = 64;
  while (atlasW * atlasW < area * 1.3) atlasW *= 2;
  const order = rects.map((_, i) => i).sort((a, b) => rects[b][1] - rects[a][1]), pos: [number, number][] = rects.map(() => [0, 0]);
  let x = 0, y = 0, row = 0;
  for (const i of order) {
    const [w, h] = rects[i];
    if (!w) continue;
    if (x + w > atlasW) { x = 0; y += row + 1; row = 0; }
    pos[i] = [x, y]; x += w + 1; row = Math.max(row, h);
  }
  return { atlasW, atlasH: Math.max(1, y + row + 1), pos };
}

/** The code-drawn pixel font as a bitmap atlas (1 byte per pixel). */
export function bakePixelFont(name = 'pixel5x8'): Font {
  const codes = [...PIXEL_5x8.keys()], cols = 16, rows = Math.ceil(codes.length / cols);
  const atlasW = cols * 6, atlasH = rows * 9, px = new Uint8Array(atlasW * atlasH), glyphs: Record<string, Glyph> = {};
  codes.forEach((code, i) => {
    const X = (i % cols) * 6, Y = Math.floor(i / cols) * 9;
    PIXEL_5x8.get(code)!.forEach((row, y) => [...row].forEach((ch, x) => { if (ch === '#') px[(Y + y) * atlasW + X + x] = 255; }));
    glyphs[code] = { x: X, y: Y, w: 5, h: 8, ox: 0, oy: -7, adv: 6 };
  });
  return { name, mode: 'bitmap', size: 8, range: 0, lineHeight: 10, ascent: 7, atlasW, atlasH, glyphs, pixels: px };
}
