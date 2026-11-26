export const FPS = 60;
/** Feature frame layout: 16 log bands, [16] = RMS, [17] = onset (0 | 255). */
export const NB = 16, K_RMS = 16, K_ONSET = 17, STRIDE = 18;
/** Virtual canvas that scene coordinates live in; the renderer letterboxes it. */
export const W = 1280, H = 720;
/** Live mode renders this many ticks behind the leader to absorb network jitter. */
export const LIVE_DELAY = 6;
/** Stateless scenes may look at most this many ticks into the past. */
export const LOOKBACK = 600;
/** Decimated waveform: WAVE_N interleaved L/R int8 pairs per tick (WAVE_BYTES), covering one tick of audio. */
export const WAVE_N = 512, WAVE_BYTES = WAVE_N * 2;
/** Sims reseed on this grid (8 bars of the 28-tick beat used until beat tracking lands). */
export const TICKS_PER_BEAT = 28, RESEED_TICKS = TICKS_PER_BEAT * 4 * 8;
/**
 * Input-derived keys past the audio frame, served by `withEvents` (0 from plain sources):
 * note pitch+1 / velocity*2 on a note-on tick, 255 on a MIDI beat tick, beat phase 0..255 and
 * beat-in-bar 0..3 while a clock runs, tempo (bpm, 0 = no clock), CC params 0..254 (see CC_PARAMS).
 */
export const K_NOTE = 18, K_VEL = 19, K_BEAT = 20, K_PHASE = 21, K_BAR = 22, K_BPM = 23, K_P0 = 24, N_PARAMS = 4;
/** Palette step from the pads' D-pad (0..255, wraps); every scene rotates its hues by it. */
export const K_PAL = 28;
/** Which CC number drives each param (any channel): mod wheel, cutoff, resonance, pan. */
export const CC_PARAMS = [1, 74, 71, 10] as const;
/** A clock beat is "current" for this many ticks; longer gaps read as no clock. */
export const BEAT_HOLD = 120;
