export const FPS = 60;
/** Feature frame layout: 16 log bands, [16] = RMS, [17] = onset (0 | 255). */
export const NB = 16, K_RMS = 16, K_ONSET = 17, STRIDE = 18;
/** Virtual canvas that scene coordinates live in; the renderer letterboxes it. */
export const W = 1280, H = 720;
/** Live mode renders this many ticks behind the leader to absorb network jitter. */
export const LIVE_DELAY = 6;
/** Stateless scenes may look at most this many ticks into the past. */
export const LOOKBACK = 600;
/** Decimated waveform: WAVE_N interleaved L/R int8 pairs per tick. */
export const WAVE_N = 512;
/** Sims reseed on this grid (8 bars of the 28-tick beat used until beat tracking lands). */
export const TICKS_PER_BEAT = 28, RESEED_TICKS = TICKS_PER_BEAT * 4 * 8;
