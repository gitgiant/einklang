// Timed lyrics: `.lrc` files that sit next to a track ("song.mp3" + "song.lrc"). The host that loads the
// track sends the lines with it; every host gets them in the room state and pieces read them with
// `ctx.lyric()`.
import type { LyricLine } from '../../lab/api/index.ts';

/** One line: start time in seconds into the track. */
export interface Lyric { t: number; text: string }

/** At most this many lines, each at most this long (server-side limits too). */
export const LRC_MAX_LINES = 2000, LRC_MAX_TEXT = 200;

/**
 * Parse LRC: `[mm:ss.xx]text` (several stamps per line allowed), `[offset:+/-ms]`; metadata tags
 * (`[ar:..]`, `[ti:..]`) and enhanced word stamps (`<mm:ss.xx>`) are dropped. Sorted by time.
 */
export function parseLrc(src: string): Lyric[] {
  let offset = 0;
  const out: Lyric[] = [];
  for (const raw of src.replace(/^﻿/, '').split(/\r?\n/)) {
    const off = /^\[offset:\s*([+-]?\d+)\s*\]/i.exec(raw.trim());
    if (off) { offset = +off[1] / 1000; continue; }
    const stamps: number[] = [];
    let rest = raw.trim();
    for (let m; (m = /^\[(\d{1,3}):(\d{1,2}(?:[.:]\d{1,3})?)\]/.exec(rest)); rest = rest.slice(m[0].length)) stamps.push(+m[1] * 60 + +m[2].replace(':', '.'));
    if (!stamps.length) continue;
    const text = rest.replace(/<\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?>/g, '').trim().slice(0, LRC_MAX_TEXT);
    for (const s of stamps) out.push({ t: s, text });
  }
  // a positive offset shows lyrics sooner
  return out.map((l) => ({ t: Math.max(0, l.t - offset), text: l.text })).sort((a, b) => a.t - b.t).slice(0, LRC_MAX_LINES);
}

/** Clean untrusted lines (from a client). */
export function cleanLyrics(x: unknown): Lyric[] | null {
  if (!Array.isArray(x)) return null;
  const out: Lyric[] = [];
  for (const l of x.slice(0, LRC_MAX_LINES)) {
    const o = l as Lyric;
    if (o && Number.isFinite(o.t) && o.t >= 0 && typeof o.text === 'string') out.push({ t: Math.round(o.t * 1000) / 1000, text: o.text.slice(0, LRC_MAX_TEXT) });
  }
  return out.length ? out.sort((a, b) => a.t - b.t) : null;
}

/** The line showing at `time` seconds: text, index, start, end (next line's start or null) and progress through it. */
export function lyricAt(lines: readonly Lyric[] | null | undefined, time: number): LyricLine | null {
  if (!lines?.length || time < lines[0].t) return null;
  let lo = 0, hi = lines.length - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (lines[mid].t <= time) lo = mid; else hi = mid - 1; }
  const l = lines[lo], end = lines[lo + 1]?.t ?? null;
  return { text: l.text, index: lo, start: l.t, end, progress: end === null ? 0 : Math.min(1, (time - l.t) / Math.max(0.001, end - l.t)) };
}
