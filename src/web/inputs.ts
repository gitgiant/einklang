// What drives the gallery: the synthetic demo track, a live input or a playlist track, all local. Each
// one is a feature source plus its own clock (fractional ticks).
import { demoSource, sectionAt } from '../core/demo.ts';
import { FPS } from '../core/constants.ts';
import { fileSource, mapSource, type FeatureSource } from '../core/features.ts';
import { parseLrc } from '../core/lrc.ts';
import { LiveAnalyzer, type LiveSource } from './capture.ts';
import type { Prepared } from './player.ts';

export interface Input {
  F: FeatureSource;
  /** Fractional tick to draw at `now` (performance.now()). */
  tick(now: number): number;
  /** For the info text. */
  label(tick: number): string;
  stop(): void;
}

export function demoInput(startTick: number): Input {
  let t0: number | null = null;
  return {
    F: demoSource(),
    tick: (now) => startTick + ((now - (t0 ??= now)) * FPS) / 1000,
    label: (t) => `demo ${(t / FPS).toFixed(2)}s  ${sectionAt(t)}`,
    stop: () => {},
  };
}

/** Ticks the picture runs behind the analysis, so a drawn tick (and the next, for interpolation) exists. */
const LIVE_LAG = 2;

/** A capture stream, or a playing video's sound (it keeps playing; stop() silences it). */
export function liveInput(stream: LiveSource, name: string, ended: () => void): Input {
  const an = new LiveAnalyzer(stream, ended), frames = new Map<number, Uint8Array>(), t0 = performance.now();
  const timer = setInterval(() => {
    const cur = Math.floor(((performance.now() - t0) * FPS) / 1000);
    an.pull(cur, (t, m) => frames.set(t, m.slice(5)));
    for (const k of frames.keys()) { if (k >= cur - 2000) break; frames.delete(k); }
  }, 8);
  return {
    F: mapSource(frames),
    tick: (now) => Math.max(0, ((now - t0) * FPS) / 1000 - LIVE_LAG),
    label: (t) => `${name} ${(t / FPS).toFixed(2)}s`,
    stop: () => { clearInterval(timer); an.close(); },
  };
}

/**
 * A playlist track on `au` (the gallery's one audio element, already loaded with its sound): the
 * analysis `p`, the element's clock. `owns()`: it is still the element's track (stop() then pauses it).
 */
export function trackInput(au: HTMLMediaElement, p: Prepared, name: string, lrc: string | null, owns: () => boolean): Input {
  const lyrics = lrc ? parseLrc(lrc) : [];
  // currentTime advances in coarse steps: run on the page clock and resync when the two drift apart
  let at = 0, time = 0;
  return {
    F: { ...fileSource(p.feat.slice(5), p.frames), lyrics },
    tick: (now) => {
      const est = time + (now - at) / 1000;
      if (au.paused || Math.abs(est - au.currentTime) > 0.05) { at = now; time = au.currentTime; return time * FPS; }
      return est * FPS;
    },
    label: (t) => `${name} ${(t / FPS).toFixed(2)}s`,
    stop: () => { if (owns()) au.pause(); },
  };
}
