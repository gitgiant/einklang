// What drives the gallery: the synthetic demo track, a live input or an audio file, all local. Each
// one is a feature source plus its own clock (fractional ticks).
import { demoSource, sectionAt } from '../core/demo.ts';
import { FPS } from '../core/constants.ts';
import { fileSource, mapSource, type FeatureSource } from '../core/features.ts';
import { parseLrc } from '../core/lrc.ts';
import { LiveAnalyzer } from './capture.ts';
import type { Player } from './player.ts';

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

export function liveInput(stream: MediaStream, name: string, ended: () => void): Input {
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

/** Decode, analyze and loop the first track of `player`. `blocked`: the browser wants a tap before it plays. */
export async function fileInput(player: Player, progress: (p: number) => void, blocked: () => void): Promise<Input> {
  const p = await player.prepare(0, progress), name = player.names[0];
  const lrc = await player.lyrics(0).catch(() => null), lyrics = lrc ? parseLrc(lrc) : [];
  const au = new Audio(URL.createObjectURL(new Blob([p.bytes], { type: p.type })));
  au.loop = true;
  const play = () => au.play().then(() => removeEventListener('pointerup', play), () => { blocked(); addEventListener('pointerup', play, { once: true }); });
  play();
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
    stop: () => { removeEventListener('pointerup', play); au.pause(); URL.revokeObjectURL(au.src); },
  };
}
