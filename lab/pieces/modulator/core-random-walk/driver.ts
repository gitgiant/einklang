import { definePiece, GRID_UNITS, smooth01 } from '../../../api/index.ts';

const RATES = [GRID_UNITS['1/4 beat'], GRID_UNITS['1/2 beat'], GRID_UNITS.beat, GRID_UNITS.bar, GRID_UNITS['2 bars'], GRID_UNITS['4 bars']];
/** Steps summed: a bounded window keeps it a pure function of the step index. */
const W = 16;
/** Fold into 0..1 (a triangle wave: reflects at both ends). */
const fold = (x: number) => { const t = ((x % 2) + 2) % 2; return t > 1 ? 2 - t : t; };

export default definePiece({
  cpu: ({ tick, sub, rand, params: P }) => {
    const unit = RATES[P.rate as number] ?? RATES[2], k = Math.floor(tick / unit), seed = (P.seed as number) + 0x9a11;
    const at = (i: number) => { let s = 0.5; for (let j = 0; j < W; j++) s += (rand(i - j, seed) - 0.5) * 2 * (P.size as number); return fold(s); };
    const f = (tick - k * unit + sub / 256) / unit, g = P.glide as number, v = at(k);
    return { out: g > 0 && f < g ? at(k - 1) + (v - at(k - 1)) * smooth01(f / g) : v, step: tick === k * unit ? 1 : 0 };
  },
});
