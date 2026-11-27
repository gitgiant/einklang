// The beat grid scene-level timing uses (sections, core-switch, core-step): the fixed 28-tick beat
// from tick 0, the same grid sims reseed on, until beat tracking lands. Integer ticks only.
import { TICKS_PER_BEAT } from '../../src/core/constants.ts';

export { TICKS_PER_BEAT };
export const BAR_TICKS = TICKS_PER_BEAT * 4;
/** Grid units by name: ticks per unit (0 = every tick). */
export const GRID_UNITS = { tick: 0, '1/4 beat': TICKS_PER_BEAT / 4, '1/2 beat': TICKS_PER_BEAT / 2, beat: TICKS_PER_BEAT, bar: BAR_TICKS, '2 bars': 2 * BAR_TICKS, '4 bars': 4 * BAR_TICKS, '8 bars': 8 * BAR_TICKS } as const;
export type GridUnit = keyof typeof GRID_UNITS;
/** The boundary at or before `tick` on a grid of `unit` ticks (unit 0: the tick itself). */
export const gridStart = (tick: number, unit: number): number => (unit > 0 ? Math.floor(tick / unit) * unit : tick);
/** Smoothstep 0..1. */
export const smooth01 = (x: number): number => { const t = Math.max(0, Math.min(1, x)); return t * t * (3 - 2 * t); };
