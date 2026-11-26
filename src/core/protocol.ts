// Wire protocol shared by the server and every host. JSON for control, binary for features:
//   binary [1][u32 tick][STRIDE bytes]          one live feature frame
//   binary [2][u32 frames][frames * STRIDE]     whole-track features (file mode)
import { FPS, LIVE_DELAY, TICKS_PER_BEAT } from './constants.ts';

/** Inputs are applied this many ticks after the server receives them (100 ms of network slack). */
export const INPUT_DELAY = 6;

export type Mode =
  | { mode: 'idle' }
  | { mode: 'file'; start: number; frames: number; track: number }
  | { mode: 'live'; start: number };

/** Scene schedule: `id` is active from tick `at` on, `prev` before it. */
export interface SceneSched { id: string; prev: string; at: number }

/** Beat grid in the current timeline. Until MIDI clock / beat tracking land it is a fixed grid. */
export interface Grid { origin: number; tpb: number }

export interface HostInfo { id: number; name: string; view: number | null }

/** Server-authoritative room state, broadcast on every change. */
export type RoomState = Mode & {
  /** Increments on every mode change; ticks and events only compare within one epoch. */
  epoch: number;
  scene: SceneSched;
  presets: string[];
  grid: Grid;
  /** Controller overrides; null = use the host's own ?view= default. */
  hosts: HostInfo[];
};

/** An input event, stamped by the server with the tick on which every host applies it. */
export interface TickEvent { tick: number; src: number; type: string; payload?: unknown }

export type Quant = 'now' | 'beat' | 'bar';

export type ClientMsg =
  | { t: 'ping'; c: number }
  | { t: 'hello'; name: string }
  | { t: 'ev'; type: string; payload?: unknown }
  | { t: 'scene'; id?: string; step?: number; quant: Quant }
  | { t: 'view'; host: number; view: number | null }
  | { t: 'play' } | { t: 'live' } | { t: 'stop' };

export type ServerMsg =
  | { t: 'pong'; c: number; s: number }
  | { t: 'welcome'; you: number }
  | ({ t: 'state' } & RoomState)
  | { t: 'ev'; ev: TickEvent }
  | { t: 'log'; epoch: number; events: TickEvent[] };

/** The tick every host renders at server time `ms` (before its own display offset). */
export function modeTick(m: Mode, ms: number): number {
  if (m.mode === 'file') return Math.floor(((ms - m.start) * FPS) / 1000);
  if (m.mode === 'live') return Math.floor(((ms - m.start) * FPS) / 1000) - LIVE_DELAY;
  return Math.floor((ms * FPS) / 1000);
}

/** First beat/bar boundary at or after `tick`. */
export function nextBoundary(tick: number, grid: Grid, quant: Quant): number {
  if (quant === 'now') return tick;
  const len = quant === 'bar' ? grid.tpb * 4 : grid.tpb;
  return grid.origin + Math.ceil((tick - grid.origin) / len) * len;
}

export const sceneAt = (s: SceneSched, tick: number): string => (tick >= s.at ? s.id : s.prev);

export const DEFAULT_GRID: Grid = { origin: 0, tpb: TICKS_PER_BEAT };
export const DEFAULT_PRESETS = ['radial', 'tunnel', 'scope', 'flow'];
