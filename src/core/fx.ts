// Pad FX layers: a pure function of (event log, tick), so every host draws the same effects.
// Each pad (slot) has its own color: a cursor at its FX center plus the shockwaves it fires.
// Effects only touch the post chain, so they don't enter the scene hash; freeze does, through
// the tick the scene is evaluated at.
import { pay, type EventLog } from './events.ts';

/** Standard-mapping buttons (Gamepad API): ✕ ○ □ △, L1 R1 L2 R2, share options, L3 R3, D-pad. */
export const BTN = { CROSS: 0, CIRCLE: 1, SQUARE: 2, TRIANGLE: 3, L1: 4, R1: 5, L2: 6, R2: 7, SHARE: 8, OPTIONS: 9, L3: 10, R3: 11, UP: 12, DOWN: 13, LEFT: 14, RIGHT: 15 } as const;
const FX_BITS = (1 << BTN.CROSS) | (1 << BTN.CIRCLE) | (1 << BTN.SQUARE) | (1 << BTN.TRIANGLE) | (1 << BTN.SHARE);

export const PAD_COLORS: readonly [number, number, number][] = [
  [0.2, 0.8, 1], [1, 0.3, 0.6], [0.5, 1, 0.3], [1, 0.75, 0.2], [0.7, 0.4, 1], [1, 0.45, 0.2], [0.3, 1, 0.85], [0.95, 0.95, 0.95],
];
export const RING_LIFE = 45, RING_EVERY = 15, MAX_MARKS = 12;

export interface Mark { x: number; y: number; r: number; a: number; col: readonly [number, number, number] }
export interface PadView { slot: number; x: number; y: number; held: number; age: number }
export interface Fx {
  /** 0..1 knobs (L2 trails, R2 bloom), -1..1 drift (R stick). */
  trails: number; bloom: number; rotate: number; zoom: number;
  /** FX center in uv (feedback zoom/rotate, kaleido). */
  cx: number; cy: number;
  invert: number; glitch: number; strobe: number; strobeCol: readonly [number, number, number];
  kaleido: number; kx: number; ky: number; blackout: number;
  /** Shockwave rings (r > 0) and pad cursors (r = 0), uv coordinates, r in screen heights. */
  marks: Mark[];
  /** Scene time is held at this tick (freeze), or null. */
  frozenAt: number | null;
  pads: PadView[];
}

export const NO_FX: Fx = {
  trails: 0, bloom: 0, rotate: 0, zoom: 0, cx: 0.5, cy: 0.5, invert: 0, glitch: 0, strobe: 0, strobeCol: [1, 1, 1],
  kaleido: 0, kx: 0.5, ky: 0.5, blackout: 0, marks: [], frozenAt: null, pads: [],
};

const center = (a: number[]) => [0.5 + (a[0] / 100) * 0.45, 0.5 + (a[1] / 100) * 0.45] as const;
const isOn = (b: number, bit: number) => ((b >> bit) & 1) === 1;

export function fxAt(log: EventLog, t: number): Fx {
  const fx: Fx = { ...NO_FX, marks: [], pads: [] };
  const fz = log.latest('freeze', t);
  if (fz && pay(fz).on) fx.frozenAt = fz.tick;

  let ncx = 0, sx = 0, sy = 0;
  const rings: Mark[] = [], cursors: Mark[] = [];
  for (const key of log.keys('pad:')) {
    const { list, i } = log.history(key, t);
    if (i < 0) continue;
    const e = list[i], p = e.payload as { s: number; b: number; a: number[]; t: number[]; gone?: number };
    if (p.gone) continue;
    const col = PAD_COLORS[p.s % PAD_COLORS.length], [x, y] = center(p.a);
    /** Tick the bit's current run started (it's held at list[j]), walking back through the pad's events. */
    const since = (j: number, bit: number) => { while (j > 0 && isOn((list[j - 1].payload as { b: number }).b, bit)) j--; return list[j].tick; };
    const at = (g: number) => log.history(key, g).i;

    fx.trails = Math.max(fx.trails, p.t[0] / 100);
    fx.bloom = Math.max(fx.bloom, p.t[1] / 100);
    fx.rotate += p.a[2] / 100;
    fx.zoom -= p.a[3] / 100;
    const deflected = p.a[0] !== 0 || p.a[1] !== 0;
    if (deflected) { sx += x; sy += y; ncx++; }
    if (isOn(p.b, BTN.CIRCLE) && !fx.strobe && (t - since(i, BTN.CIRCLE)) % 6 < 2) { fx.strobe = 1; fx.strobeCol = col; }
    if (isOn(p.b, BTN.SQUARE)) { fx.invert = 1; fx.glitch = Math.max(fx.glitch, 1); }
    if (isOn(p.b, BTN.TRIANGLE) && !fx.kaleido) { fx.kaleido = 1; fx.kx = x; fx.ky = y; }
    if (isOn(p.b, BTN.SHARE)) fx.blackout = 1;

    // shockwaves: one when ✕ goes down, then one every RING_EVERY ticks while it's held
    for (let g = t - RING_LIFE + 1; g <= t; g++) {
      const j = at(g);
      if (j < 0) continue;
      const pj = list[j].payload as { b: number; a: number[] };
      if (!isOn(pj.b, BTN.CROSS) || (g - since(j, BTN.CROSS)) % RING_EVERY !== 0) continue;
      const age = t - g, [rx, ry] = center(pj.a);
      rings.push({ x: rx, y: ry, r: 0.02 + age * 0.03, a: 1 - age / RING_LIFE, col });
    }
    // the pad's own layer: a cursor at its FX center, bright while used, fading when idle
    const age = t - e.tick, held = p.b & FX_BITS;
    const a = deflected || held ? 1 : Math.max(0, 1 - age / 120) * 0.7;
    if (a > 0) cursors.push({ x, y, r: 0, a, col });
    fx.pads.push({ slot: p.s, x, y, held, age });
  }
  if (ncx) { fx.cx = sx / ncx; fx.cy = sy / ncx; }
  fx.rotate = Math.max(-1, Math.min(1, fx.rotate));
  fx.zoom = Math.max(-1, Math.min(1, fx.zoom));
  // newest rings first so a crowded screen drops the faintest ones
  rings.sort((p, q) => q.a - p.a);
  fx.marks = [...cursors, ...rings].slice(0, MAX_MARKS);
  return fx;
}
