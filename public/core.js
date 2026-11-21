// Deterministic scene core. Integer-only math: same (frame, features) -> same display list on every engine.
export const FPS = 60, NB = 16, STRIDE = 18; // 16 bands, [16]=rms, [17]=onset(0|255)
export const W = 1280, H = 720, LIVE_DELAY = 6; // live: render 6 frames (100 ms) behind to absorb network jitter

// Sine LUT built with IEEE-exact ops only (+,-,*,/,round) — no Math.sin, whose output varies by engine.
const LN = 4096;
const SIN = new Int16Array(LN);
{
  const PI = 3.141592653589793, step = (2 * PI) / LN;
  for (let i = 0; i < LN; i++) {
    const x = (i < LN / 2 ? i : i - LN) * step, x2 = x * x;
    let term = x, s = x;
    for (let k = 1; k < 13; k++) { term = (-term * x2) / ((2 * k) * (2 * k + 1)); s += term; }
    SIN[i] = Math.round(s * 32767);
  }
}
export const isin = (a) => SIN[a & 4095];
export const icos = (a) => SIN[(a + 1024) & 4095];

export function h32(a, b) {
  let x = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul((b + 0x632be5ab) | 0, 0xc2b2ae35);
  x ^= x >>> 16; x = Math.imul(x, 0x7feb352d); x ^= x >>> 15; x = Math.imul(x, 0x846ca68b); x ^= x >>> 16;
  return x >>> 0;
}

// h: 0..1535 (wraps), s,v: 0..255 -> 0xRRGGBB
export function hsv(h, s, v) {
  h = ((h % 1536) + 1536) % 1536;
  const i = h >> 8, f = h & 255;
  const p = ((v * (255 - s)) / 255) | 0;
  const q = ((v * (255 - ((s * f) >> 8))) / 255) | 0;
  const t = ((v * (255 - ((s * (255 - f)) >> 8))) / 255) | 0;
  const [r, g, b] = [[v, t, p], [q, v, p], [p, v, t], [p, q, v], [t, p, v], [v, p, q]][i];
  return (r << 16) | (g << 8) | b;
}

// Display list ops, 8 ints each: [op, a, b, c, d, rgb, alpha, width]
export const OP_CLEAR = 0, OP_CIRCLE = 1, OP_RING = 2, OP_LINE = 3;

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

// Stateless: frame f depends only on features in [f-600, f]. Late joiners / dropped frames stay in lockstep.
// F(frame, k) -> 0..255 (0 for unknown frames).
export function scene(f, F) {
  const L = [];
  const push = (op, a, b, c, d, rgb, al, w) => L.push(op, a, b, c, d, rgb, al, w);
  const cx = W >> 1, cy = H >> 1;

  const smooth = (fr, k, n) => { let s = 0, w = 0; for (let i = 0; i < n; i++) { s += F(fr - i, k) * (n - i); w += n - i; } return (s / w) | 0; };
  const S = new Int32Array(NB);
  for (let b = 0; b < NB; b++) S[b] = smooth(f, b, 8);
  const E = smooth(f, 16, 16);
  const bass = ((S[0] + S[1] + S[2]) / 3) | 0;
  let onsets = 0;
  for (let i = 0; i < 600; i++) if (F(f - i, 17)) onsets++;
  const hue = f * 2 + onsets * 96;

  push(OP_CLEAR, 0, 0, 0, 0, hsv(hue + 768, 200, 10 + (E >> 4)), 255, 0);

  // spokes: 64, mirrored band map, constant rotation
  const rot = (f * 3) & 4095, r0 = 90 + (bass >> 2);
  for (let i = 0; i < 64; i++) {
    const b = (i < 32 ? i : 63 - i) >> 1, a = (rot + i * 64) & 4095, s = S[b];
    const r1 = r0 + 20 + ((s * 220) / 255 | 0);
    push(OP_LINE,
      cx + ((icos(a) * r0) >> 15), cy + ((isin(a) * r0) >> 15),
      cx + ((icos(a) * r1) >> 15), cy + ((isin(a) * r1) >> 15),
      hsv(hue + b * 48, 220, 255), clamp(110 + (s >> 1), 0, 255), 3 + (s >> 5));
  }

  // onset pulse rings + particle bursts (closed-form in age, no sim state)
  for (let g = f - 90; g <= f; g++) {
    if (!F(g, 17)) continue;
    const age = f - g;
    if (age < 40) push(OP_RING, cx, cy, r0 + age * 12, 0, hsv(hue + 256, 120, 255), 255 - age * 6, 4);
    const gb = ((F(g, 0) + F(g, 1)) >> 1);
    const n = 8 + (F(g, 16) >> 4);
    for (let j = 0; j < n; j++) {
      const hh = h32(g, j), a = hh & 4095;
      const dist = 100 + (2 + ((hh >>> 12) & 7) + (gb >> 6)) * age;
      push(OP_CIRCLE, cx + ((icos(a) * dist) >> 15), cy + ((isin(a) * dist) >> 15), 2 + ((hh >>> 20) & 3), 0,
        hsv(hue + ((hh >>> 24) & 255), 160, 255), 255 - ((age * 255) / 90 | 0), 0);
    }
  }

  push(OP_CIRCLE, cx, cy, 40 + ((E / 3) | 0), 0, hsv(hue, 180, 60 + (E >> 1)), 255, 0);

  // rms history strip
  let px = 0, py = H - 20 - ((F(f - 127, 16) * 80) / 255 | 0);
  for (let i = 1; i < 128; i++) {
    const x = i * 10, y = H - 20 - ((F(f - 127 + i, 16) * 80) / 255 | 0);
    push(OP_LINE, px, py, x, y, hsv(hue + 512, 140, 220), 180, 2);
    px = x; py = y;
  }
  return Int32Array.from(L);
}

export function hashList(L) {
  let h = 0x811c9dc5;
  for (let i = 0; i < L.length; i++) { h ^= L[i]; h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16).padStart(8, '0');
}
