// Wire protocol shared by the server and every host. JSON for control, binary for features:
//   binary [1][u32 tick][STRIDE bytes]([WAVE_BYTES])                       one live frame (+ waveform)
//   binary [2][u32 frames][frames * STRIDE]([frames * WAVE_BYTES])        whole track (+ waveform)
// The waveform blocks are optional: a frame/track without them makes the scope synthesize one.
import { FPS, LIVE_DELAY, TICKS_PER_BEAT } from './constants.ts';
import type { Lyric } from './lrc.ts';

/** Inputs are applied this many ticks after the server receives them (100 ms of network slack). */
export const INPUT_DELAY = 6;

export type Mode =
  | { mode: 'idle' }
  /** `paused`: the frame the track is frozen on, or null while playing. */
  | { mode: 'file'; start: number; frames: number; track: number; name: string; paused: number | null; lyrics?: Lyric[] | null }
  /** `delay`: ticks every host renders behind the leader (instrument mode 2, captured audio 6). */
  | { mode: 'live'; start: number; delay: number };

/** Transition effects, in shader order (`kind` = index). `cut` is the plain hard switch. */
export const TRANSITIONS = [
  'cut', 'blend', 'flash', 'wipe', 'iris', 'dissolve', 'luma', 'zoom', 'glitch', 'stutter', 'swirl', 'melt', 'audio', 'pixelate',
] as const;
export type TransType = (typeof TRANSITIONS)[number];
/** Lengths the panel offers, in beats (0 = cut). */
export const TRANS_BEATS = [0, 0.5, 1, 2, 4, 8, 16] as const;

/**
 * A scheduled transition: `ticks` long (fixed when scheduled), `seed` from the server, and the
 * beat length `tpb` at scheduling time, so the beat-stepped effects don't warp on a tempo change.
 */
export interface TransSched { type: TransType; ticks: number; seed: number; tpb: number }
export const CUT: TransSched = { type: 'cut', ticks: 0, seed: 0, tpb: TICKS_PER_BEAT };

/** One switch: `prev` before tick `at`, a transition over [at, at + trans.ticks), `id` after. */
export interface SceneStep { id: string; prev: string; at: number; trans: TransSched }
/**
 * Scene schedule: the most recently scheduled switch, plus the `earlier` ones (oldest first)
 * that were still pending or running when it was queued behind them.
 */
export interface SceneSched extends SceneStep { earlier: SceneStep[] }

/**
 * Beat grid in the current timeline: a bar starts at `origin`, a beat lasts `tpb` ticks (may be
 * fractional). Fixed 28 ticks/beat until a MIDI clock master re-anchors it.
 */
export interface Grid { origin: number; tpb: number }

export interface Playlist { owner: number; names: string[]; index: number }

/** MIDI clock master: a host's beat `n` happened at server time `at` (ms), at tempo `bpm`. */
export interface ClockMsg { t: 'clock'; at: number; bpm: number; n: number }

/** `cap`: the flow particle count this host's benchmark says it can run (null until reported). */
export interface HostInfo { id: number; name: string; view: number | null; cap: number | null }

/** Flow particle budget bounds (powers of two) and the count used before any host reports. */
export const FLOW_N_MIN = 1 << 12, FLOW_N_MAX = 1 << 20, FLOW_N_DEFAULT = 1 << 17;
/**
 * Flow particle count: `n` from tick `at` on (always a reseed boundary), `prev` before. The
 * server sets it to the weakest host's benchmark; a change waits for the next reseed.
 */
export interface FlowN { n: number; prev: number; at: number }
export const flowNAt = (s: FlowN, tick: number): number => (tick >= s.at ? s.n : s.prev);

/** A transition request as the panel sends it. */
export interface TransReq { type: TransType | 'random'; beats: number }

/** Auto-rotation lengths the panel offers, in bars (0 = off). */
export const AUTO_BARS = [0, 4, 8, 16] as const;
/** The rotation a new room starts with, and the default transition length. */
export const DEFAULT_AUTO_BARS = 8;
export const DEFAULT_TRANS_BEATS = 8;
/**
 * Auto-rotation: the server picks a scene by vote weight every `bars` bars, with this transition.
 * `preset`: the room's starting value, which no host has chosen.
 */
export interface AutoRot { bars: number; trans: TransReq; preset?: boolean }

/** Server-authoritative room state, broadcast on every change. */
export type RoomState = Mode & {
  /** Increments on every mode change; ticks and events only compare within one epoch. */
  epoch: number;
  scene: SceneSched;
  presets: string[];
  grid: Grid;
  /** Controller overrides; null = use the host's own ?view= default. */
  hosts: HostInfo[];
  /** Host id of the MIDI clock master, if any. */
  clock: number | null;
  /** Track list of the host that loaded a folder / several files (it uploads each in turn). */
  playlist: Playlist | null;
  flow: FlowN;
  /** Net vote score (ups - downs) per scene that has votes; `presets` leaves out the retired ones. */
  scores: Record<string, number>;
  auto: AutoRot | null;
};

/** An input event, stamped by the server with the tick on which every host applies it. */
export interface TickEvent { tick: number; src: number; type: string; payload?: unknown }

export type Quant = 'now' | 'beat' | 'bar';

export type ClientMsg =
  | { t: 'ping'; c: number }
  | { t: 'hello'; name: string }
  | { t: 'ev'; type: string; payload?: unknown }
  | ClockMsg
  | { t: 'tap' }
  /** Benchmark result: particles this host can run. */
  | { t: 'bench'; n: number }
  /** `id`, or `step` through the list in order, or `weighted`: a random other scene by vote weight. */
  | { t: 'scene'; id?: string; step?: number; weighted?: boolean; quant: Quant; trans?: TransReq }
  /** An owner vote on the scene showing; a live 👎 skips to a weighted pick with `quant` + `trans`. */
  | { t: 'vote'; scene: string; vote: 1 | -1; quant?: Quant; trans?: TransReq }
  | { t: 'auto'; bars: number; trans?: TransReq }
  | { t: 'view'; host: number; view: number | null }
  /** `lyrics`: the track's .lrc lines, if it came with one. */
  | { t: 'play'; name?: string; lyrics?: Lyric[] } | { t: 'live'; delay?: number } | { t: 'stop' }
  | { t: 'pause' } | { t: 'resume' } | { t: 'seek'; frame: number }
  /** Ask the playlist owner to play another track (absolute index, or a step from the current one). */
  | { t: 'track'; index?: number; step?: number }
  | { t: 'playlist'; names: string[]; index: number };

export type ServerMsg =
  | { t: 'pong'; c: number; s: number }
  | { t: 'welcome'; you: number }
  | ({ t: 'state' } & RoomState)
  | { t: 'ev'; ev: TickEvent }
  | { t: 'log'; epoch: number; events: TickEvent[] }
  /** To the playlist owner: play track `index`. */
  | { t: 'track'; index: number }
  /** A vote landed (toast on every host). `host`: who voted (null = the gallery). */
  | { t: 'vote'; scene: string; vote: 1 | -1; score: number; retired: boolean; host: string | null };

/** The tick every host renders at server time `ms` (before its own display offset). */
export const modeTick = (m: Mode, ms: number): number => Math.floor(modeTickF(m, ms));

/** Fractional modeTick, for placing timed inputs (MIDI clock) between ticks. */
export function modeTickF(m: Mode, ms: number): number {
  if (m.mode === 'file') return m.paused !== null ? m.paused : ((ms - m.start) * FPS) / 1000;
  if (m.mode === 'live') return ((ms - m.start) * FPS) / 1000 - (m.delay ?? LIVE_DELAY);
  return (ms * FPS) / 1000;
}

/** First beat/bar boundary at or after `tick`. */
export function nextBoundary(tick: number, grid: Grid, quant: Quant): number {
  if (quant === 'now') return tick;
  const len = quant === 'bar' ? grid.tpb * 4 : grid.tpb;
  return Math.ceil(grid.origin + Math.ceil((tick - grid.origin) / len) * len - 1e-6);
}

/** The switch that has started by `tick` (its transition may still be running), or null before the first. */
export function stepAt(s: SceneSched, tick: number): SceneStep | null {
  if (tick >= s.at) return s;
  for (let i = s.earlier.length - 1; i >= 0; i--) if (tick >= s.earlier[i].at) return s.earlier[i];
  return null;
}

/** The scene switched to by `tick` (the target while its transition runs). */
export function sceneAt(s: SceneSched, tick: number): string {
  const st = stepAt(s, tick);
  return st ? st.id : (s.earlier[0] ?? s).prev;
}

/** A schedule showing `id` with nothing pending. */
export const fixedScene = (id: string): SceneSched => ({ id, prev: id, at: 0, trans: CUT, earlier: [] });

export const DEFAULT_GRID: Grid = { origin: 0, tpb: TICKS_PER_BEAT };
export const DEFAULT_PRESETS = ['radial', 'tunnel', 'scope', 'flow'];
