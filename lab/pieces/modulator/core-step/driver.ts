import { definePiece, GRID_UNITS, smooth01 } from '../../../api/index.ts';

const RATES = [GRID_UNITS['1/4 beat'], GRID_UNITS['1/2 beat'], GRID_UNITS.beat, GRID_UNITS.bar, GRID_UNITS['2 bars'], GRID_UNITS['4 bars']];
const cache = new Map<string, number[]>();
/** "0 0.5 1": numbers, clamped to 0..1. */
function parse(s: string): number[] {
  let v = cache.get(s);
  if (!v) {
    v = s.split(/[\s,]+/).filter(Boolean).map(Number).filter(Number.isFinite).map((x) => Math.max(0, Math.min(1, x)));
    if (!v.length) v = [0, 1];
    if (cache.size > 64) cache.clear();
    cache.set(s, v);
  }
  return v;
}

export default definePiece({
  cpu: ({ tick, sub, params: P }) => {
    const pat = parse(P.pattern as string), n = pat.length, unit = RATES[P.rate as number] ?? RATES[3];
    const k = Math.floor(tick / unit), at = (i: number) => pat[(((i + (P.offset as number)) % n) + n) % n];
    const v = at(k), f = (tick - k * unit + sub / 256) / unit, g = P.glide as number;
    const out = g > 0 && f < g ? at(k - 1) + (v - at(k - 1)) * smooth01(f / g) : v;
    const i = (((k + (P.offset as number)) % n) + n) % n;
    return { out, index: n > 1 ? i / (n - 1) : 0, gate: tick === k * unit && v > 0 ? 1 : 0 };
  },
});
