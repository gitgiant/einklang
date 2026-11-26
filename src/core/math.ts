// Integer-only helpers. Everything here is bit-identical across JS engines (and mirrored in WGSL).

const LN = 4096;
const SIN = new Int16Array(LN);
{
  // Taylor series with IEEE-exact ops only (+ - * / round); Math.sin varies by engine.
  const PI = 3.141592653589793, step = (2 * PI) / LN;
  for (let i = 0; i < LN; i++) {
    const x = (i < LN / 2 ? i : i - LN) * step, x2 = x * x;
    let term = x, s = x;
    for (let k = 1; k < 13; k++) { term = (-term * x2) / ((2 * k) * (2 * k + 1)); s += term; }
    SIN[i] = Math.round(s * 32767);
  }
}
/** Angle in 1/4096 turns -> sin * 32767. */
export const isin = (a: number): number => SIN[a & 4095];
export const icos = (a: number): number => SIN[(a + 1024) & 4095];
export const SIN_LUT: Readonly<Int16Array> = SIN;

/** 32-bit integer hash of two ints -> u32. Mirrored in WGSL as `h32`. */
export function h32(a: number, b: number): number {
  let x = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul((b + 0x632be5ab) | 0, 0xc2b2ae35);
  x ^= x >>> 16; x = Math.imul(x, 0x7feb352d); x ^= x >>> 15; x = Math.imul(x, 0x846ca68b); x ^= x >>> 16;
  return x >>> 0;
}

/** h: 0..1535 (wraps), s, v: 0..255 -> 0xRRGGBB */
export function hsv(h: number, s: number, v: number): number {
  h = ((h % 1536) + 1536) % 1536;
  const i = h >> 8, f = h & 255;
  const p = ((v * (255 - s)) / 255) | 0;
  const q = ((v * (255 - ((s * f) >> 8))) / 255) | 0;
  const t = ((v * (255 - ((s * (255 - f)) >> 8))) / 255) | 0;
  const rgb = [[v, t, p], [q, v, p], [p, v, t], [p, q, v], [t, p, v], [v, p, q]][i];
  return (rgb[0] << 16) | (rgb[1] << 8) | rgb[2];
}

export const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

/** FNV-1a over int32 words, chainable. */
export const FNV0 = 0x811c9dc5;
export function fnv(h: number, ints: ArrayLike<number>): number {
  for (let i = 0; i < ints.length; i++) { h ^= ints[i]; h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}
export const hex8 = (h: number): string => (h >>> 0).toString(16).padStart(8, '0');
