// Einklang Lab piece API. This is the only module a piece may import (see lab/AGENTS.md).
// A piece is a folder lab/pieces/<kind>/<id>/ with piece.json, optional driver.ts, and *.wgsl.
// Spec: docs/prd-lab.md.

/** What can flow along a graph edge. An edge joins equal types only. */
export type PortType =
  | 'tex' | 'mask' | 'field' | 'particles' | 'geo' | 'camera'
  | 'palette' | 'signal' | 'trigger' | 'spectrum' | 'wave';

export const PORT_TYPES: readonly PortType[] = ['tex', 'mask', 'field', 'particles', 'geo', 'camera', 'palette', 'signal', 'trigger', 'spectrum', 'wave'];
/** Ports that live on the CPU (computed by `cpu()` each tick); the rest are GPU resources. */
export const CPU_PORTS: readonly PortType[] = ['camera', 'palette', 'signal', 'trigger', 'spectrum', 'wave'];
/** GPU image ports and the texture format each one uses. */
export const TEX_FORMAT = { tex: 'rgba16float', mask: 'r16float', field: 'rg16float' } as const;
export type TexPort = keyof typeof TEX_FORMAT;
export const isTexPort = (t: PortType): t is TexPort => t in TEX_FORMAT;

export type PieceKind = 'generator' | 'color' | 'effect' | 'modulator' | 'utility';
export const PIECE_KINDS: readonly PieceKind[] = ['generator', 'color', 'effect', 'modulator', 'utility'];

export interface PortSpec { type: PortType; optional?: boolean; doc?: string }

export type ParamType = 'float' | 'int' | 'bool' | 'enum' | 'color' | 'text';
export interface ParamSpec {
  type: ParamType;
  default: number | boolean | string;
  /** float / int range. A bound signal (0..1) maps onto [min, max] unless the binding says otherwise. */
  min?: number; max?: number;
  /** enum choices; the value is the index into this list. */
  options?: string[];
  doc?: string;
}
export type ParamValue = number | boolean | string;

export interface PieceManifest {
  id: string;
  kind: PieceKind;
  name: string;
  doc?: string;
  ports: { in?: Record<string, PortSpec>; out: Record<string, PortSpec> };
  params?: Record<string, ParamSpec>;
  tags?: string[];
  /** Cost at 1080p; `scales` says what it grows with. Checked by the gate. */
  budget?: { ms: number; scales?: 'res' | 'n' | 'none' };
  author: { vendor: string; model?: string };
  /** State is integer/deterministic and returned from cpu() as `state`: it joins the sync hash. */
  synced?: boolean;
  /** Auto-shader pieces: the WGSL file holding `fn shade(uv: vec2f) -> vec4f`. */
  shader?: string;
  /** Auto-shader pieces: bind this node's previous output as `in_prev` (feedback, trails). */
  feedback?: boolean;
  /**
   * Files the piece reads with `GpuInit.asset(path)`. `assets/...` is the shared lab/assets/ (license must match
   * lab/assets/index.json); any other path is inside the piece folder. Total cap 2 MB per piece, folder included.
   */
  assets?: { path: string; license: string; source?: string }[];
  changelog?: { date: string; by: string; note: string }[];
}

// ---------------------------------------------------------------- CPU values

/** Up to 8 stops in OKLab (L, a, b), evenly spaced 0..1. */
export interface Palette { stops: [number, number, number][] }
export interface Camera { view: Float32Array; proj: Float32Array; pos: [number, number, number] }
/** Count of events on this tick (0 = none). */
export type Trigger = number;

/** Per-tick audio + input frame (see src/core/constants.ts for the raw key layout). */
export interface Audio {
  /** 16 log bands, 0..1. */
  bands: Float32Array;
  rms: number;
  onset: boolean;
  /** Beat phase 0..1 and beat-in-bar 0..3 while a clock runs (MIDI or the fixed grid). */
  phase: number; bar: number; bpm: number;
  /** MIDI note-on this tick: pitch 0..127 and velocity 0..1, or note = -1. */
  note: number; vel: number;
  /** MIDI CC params 0..1 (mod wheel, cutoff, resonance, pan). */
  cc: [number, number, number, number];
  /** Pads' palette step 0..1 (wraps). */
  pal: number;
  /** The room's section cue (keyboard 1-9, pad Select + D-pad left/right): 0 = none / auto. */
  cue: number;
}

/** Raw per-tick feature frames (the room's FeatureSource). */
export interface RawFeatures {
  get(tick: number, key: number): number;
  wave(tick: number): Int8Array | null;
}

/** The pads' live FX at this tick: the same on every host, not part of the hash. uv coordinates. */
export interface PadFx {
  /** 0..1 knobs (L2 trails, R2 bloom), -1..1 drift (R stick). */
  trails: number; bloom: number; rotate: number; zoom: number;
  /** FX center (where the pads point). */
  cx: number; cy: number;
  invert: number; glitch: number; strobe: number; strobeCol: readonly [number, number, number];
  kaleido: number; kx: number; ky: number; blackout: number;
  /** Shockwave rings (r > 0) and pad cursors (r = 0); r in screen heights. */
  marks: { x: number; y: number; r: number; a: number; col: readonly [number, number, number] }[];
}

export interface CpuCtx {
  /** Integer tick (60 Hz) and the display sub-tick 0..255. */
  tick: number; sub: number;
  /** Seconds, fractional: (tick + sub / 256) / 60. Use this for closed-form motion. */
  time: number;
  params: Record<string, ParamValue>;
  /** Connected CPU inputs by port name (unconnected optional inputs are undefined). */
  in: Record<string, unknown>;
  audio: Audio;
  /** Audio frame `ago` ticks back (0 = now, max 600): for followers, envelopes, smoothing. */
  past(ago: number): Audio;
  /** Decimated L/R waveform at this tick (512 interleaved pairs, -1..1), or null if not streamed. */
  wave(): Float32Array | null;
  /** Raw feature bytes (0..255) at any tick, for sims that step or replay: see src/core/constants.ts. */
  raw: RawFeatures;
  /** Seeded hash noise: same on every host. Returns 0..1. */
  rand(a: number, b?: number): number;
  /** The lyric line showing now (`.lrc` next to the playing track), or null. Not part of the sync hash. */
  lyric(): LyricLine | null;
  /**
   * This node's resolved param `name` (bindings applied) at another integer tick: the graph upstream of
   * its binding is evaluated there. Pure, so hosts agree. Sample sparingly (boundaries, a short window).
   */
  paramAt(name: string, tick: number): ParamValue;
  /** This node's CPU input `port` at another integer tick (undefined when unconnected), like paramAt. */
  inputAt(port: string, tick: number): unknown;
  /** Names of this node's connected input ports (any type). */
  wired: readonly string[];
}

/** A timed lyric line: text, index, start and end (s into the track; end null on the last line), progress 0..1. */
export interface LyricLine { text: string; index: number; start: number; end: number | null; progress: number }

/**
 * What cpu() returns: a value per CPU output port, plus `state` for synced pieces. `use` (optional):
 * the GPU inputs this node reads this tick; the others are passed undefined and whatever only feeds
 * them is not rendered (switches and crossfades skip their unselected branches this way).
 */
export type CpuOut = Record<string, unknown> & { state?: Int32Array; use?: string[] };

// ---------------------------------------------------------------- GPU side

export interface GpuInit {
  device: GPUDevice;
  /** Compile a WGSL file from the piece folder (the shared prelude is prepended). */
  shader(file: string): GPUShaderModule;
  /** Raw WGSL text of a file in the piece folder. */
  wgsl(file: string): string;
  /** Fullscreen-triangle vertex entry `vs_full` exists in every module (uv 0,0 = top-left). */
  formats: typeof TEX_FORMAT;
  /** Compile WGSL source (the shared prelude is prepended). */
  compile(code: string, label: string): GPUShaderModule;
  /** Raw WGSL of a shared library file in lab/api (e.g. 'prims.wgsl'). */
  lib(file: string): string;
  /** Particle budget: the room's N at a tick (what the weakest host can run) and this host's own cap. */
  budget: { n(tick: number): number; cap: number | null };
  /** Bytes of a file declared in piece.json `assets` (throws for anything undeclared). Parse .vox with `parseVox`. */
  asset(path: string): Uint8Array;
  /** The visual media picked on this host (image / video / camera): per host, not hashed. See lab/api/media.ts. */
  media: MediaInput;
}

/** A GPU input: textures for tex/mask/field, `Particles` for particles, `Geo` for geo. */
export interface Particles { buffer: GPUBuffer; count: number; /** bytes per particle; layout pos.xy vel.xy color.rgba age size: 48 */ stride: number }
export interface Geo { encode(enc: GPUCommandEncoder, color: GPUTexture, depth: GPUTexture, cam: Camera): void }

export interface GpuCtx extends CpuCtx {
  device: GPUDevice;
  enc: GPUCommandEncoder;
  width: number; height: number;
  /** Inputs: GPUTexture for image ports, Particles, Geo, or CPU values. */
  in: Record<string, unknown>;
  /** Image outputs, allocated by the runtime at width x height: render into these. */
  out: Record<string, GPUTexture>;
  /** CPU outputs of this node's own cpu(), if it has one. */
  cpu: CpuOut;
  /** Pad FX at this tick (cursor positions, shockwaves, held buttons): react to them if you like. */
  pads: PadFx;
}

export interface GpuInstance {
  /** Encode this frame. Return non-image outputs (particles, geo). */
  frame(ctx: GpuCtx): Record<string, unknown> | void;
  dispose?(): void;
  /** Sims: how many particles this GPU can run in its budget (the room takes the weakest host's). */
  bench?(): Promise<number>;
  /** Sims: inputs for ticks >= tick changed after the fact (a late event): rewind and replay. */
  invalidate?(tick: number): void;
  /** One line for the HUD. */
  status?(): string;
}

export interface PieceDriver {
  /** Pure function of (tick, audio, params, inputs): no state between calls. */
  cpu?(ctx: CpuCtx): CpuOut;
  gpu?(init: GpuInit): GpuInstance;
}

/** Identity helper so drivers get type checking: `export default definePiece({ ... })`. */
export const definePiece = (d: PieceDriver): PieceDriver => d;

// ---------------------------------------------------------------- helpers

export { NO_MEDIA, FIT_MODES, CYCLE_OPTIONS, CYCLE_BARS, BarCounter, fitScale, fitUv, pickItem, type MediaInput, type MediaFrame, type MediaKind, type FitMode } from './media.ts';
import type { MediaInput } from './media.ts';
export { mixPass, MIX_MODES, type MixPass } from './mixpass.ts';
export { TICKS_PER_BEAT, BAR_TICKS, GRID_UNITS, gridStart, smooth01, type GridUnit } from './grid.ts';
export { parseVox, voxSurface, voxWorld, type VoxFile, type VoxModel, type VoxInstance, type VoxWorld } from './vox.ts';
export { parseSheet, encodeSheet, sheetRgba, sheetTexture, frameAt, type Sheet, type SpriteTag } from './sprite.ts';
export { parseFont, encodeFont, fontTexture, layoutText, MSDF_WGSL, type Font, type FontInfo, type Glyph, type Quad, type Layout } from './font.ts';

/** OKLab -> linear sRGB (Björn Ottosson). */
export function oklabToLinear([L, a, b]: [number, number, number]): [number, number, number] {
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.291485548 * b;
  const l = l_ ** 3, m = m_ ** 3, s = s_ ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

/** Linear sRGB -> OKLab (Björn Ottosson). */
export function linearToOklab([r, g, b]: [number, number, number]): [number, number, number] {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
}
/** 8-bit sRGB -> linear. */
export const srgbToLinear = (c: number): number => { const x = c / 255; return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; };
/** '#rrggbb' -> OKLab, or null when it isn't one. */
export function hexToOklab(hex: string): [number, number, number] | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return linearToOklab([srgbToLinear(n >> 16), srgbToLinear((n >> 8) & 255), srgbToLinear(n & 255)]);
}

/** OKLCh (lightness 0..1, chroma ~0..0.37, hue in turns) -> OKLab. */
export const oklch = (L: number, C: number, h: number): [number, number, number] =>
  [L, C * Math.cos(h * 2 * Math.PI), C * Math.sin(h * 2 * Math.PI)];
