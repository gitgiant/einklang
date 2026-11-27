// Visual media input (an image, a video or the camera picked on this host). Per host and not part
// of the sync hash: pieces read it through `GpuInit.media`, never from the DOM. The pure helpers
// here (fit, cycling) are shared by core-media and the unit tests.

export type MediaKind = 'image' | 'video' | 'camera';

/** One picked item as a texture (rgba8unorm-srgb: samples come out linear). */
export interface MediaFrame {
  texture: GPUTexture;
  /** Source pixels (the texture's size). */
  width: number; height: number;
  kind: MediaKind;
  /** The source is a selfie camera: show it mirrored by default. */
  mirror: boolean;
}

export interface MediaInput {
  /** How many items are picked (0 = nothing: draw a fallback so the scene never breaks). */
  count(): number;
  /**
   * Item `i` (wraps) as a texture on this piece's device. Images upload once; videos and the camera
   * copy a frame only when a new one exists. Null while it is still loading.
   */
  frame(i: number): MediaFrame | null;
}

/** An input with nothing picked (Node, tests, a host without media). */
export const NO_MEDIA: MediaInput = { count: () => 0, frame: () => null };

export const FIT_MODES = ['cover', 'contain', 'stretch'] as const;
export type FitMode = (typeof FIT_MODES)[number];

/**
 * Scale from screen uv to source uv around the centre: `src = (uv - 0.5) * scale + 0.5`.
 * `cover` fills the screen and crops, `contain` shows all of it with bars (src outside 0..1),
 * `stretch` ignores the aspect. Aspects are width / height.
 */
export function fitScale(srcAspect: number, dstAspect: number, mode: FitMode | number): [number, number] {
  const m = typeof mode === 'number' ? FIT_MODES[Math.max(0, Math.min(FIT_MODES.length - 1, Math.round(mode)))] : mode;
  if (m === 'stretch' || !(srcAspect > 0) || !(dstAspect > 0)) return [1, 1];
  const r = srcAspect / dstAspect; // > 1: the source is wider than the screen
  if (m === 'cover') return r >= 1 ? [1 / r, 1] : [1, r];
  return r >= 1 ? [1, r] : [1 / r, 1];
}

/** Map a screen uv to the source uv (see fitScale), zoomed in by `zoom` (1 = none) and optionally mirrored. */
export function fitUv(uv: [number, number], scale: [number, number], zoom = 1, mirror = false): [number, number] {
  const x = mirror ? 1 - uv[0] : uv[0];
  return [(x - 0.5) * (scale[0] / zoom) + 0.5, (uv[1] - 0.5) * (scale[1] / zoom) + 0.5];
}

/** The `cycle` param's options and the bars each one holds an item for (0 = no cycling). */
export const CYCLE_OPTIONS = ['off', 'every bar', 'every 2 bars', 'every 4 bars (phrase)', 'every 8 bars'] as const;
export const CYCLE_BARS = [0, 1, 2, 4, 8] as const;

/**
 * Counts bars on this host from the beat-in-bar value (0..3) each frame: a bar ends when it wraps.
 * Media is per host, so this needs no sync; a rewind (tick going back) keeps the count.
 */
export class BarCounter {
  bars = 0;
  private bar = -1;
  step(bar: number): number {
    if (this.bar >= 0 && bar < this.bar) this.bars++;
    this.bar = bar;
    return this.bars;
  }
}

/**
 * Which item shows: -1 when nothing is picked (the fallback), else item `offset` advanced by one
 * every `per` bars (per 0 = stay on `offset`), wrapping.
 */
export function pickItem(count: number, bars: number, per: number, offset = 0): number {
  if (count <= 0) return -1;
  const step = per > 0 ? Math.floor(bars / per) : 0;
  return (((step + Math.round(offset)) % count) + count) % count;
}
