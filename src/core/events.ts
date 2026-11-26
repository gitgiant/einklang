// Tick-stamped inputs as seen by a host. Events are applied on their stamped tick on every host,
// so they're part of the deterministic input alongside the audio features.
//
// Event types (payloads are sanitized ints by the server):
//   hit                                   manual trigger
//   note       { n: 0..127, v: 1..127 }   MIDI note-on
//   cc         { c: 0..127, v: 0..127 }   MIDI control change (any channel)
//   beat       { bpm: bpm*100, n }        clock beat n, stamped by the server from the clock master
//   transport  { op: 'start'|'stop'|'continue' }
import { BEAT_HOLD, CC_PARAMS, FPS, K_BAR, K_BEAT, K_BPM, K_NOTE, K_ONSET, K_P0, K_PHASE, K_VEL, N_PARAMS, STRIDE } from './constants.ts';
import type { FeatureSource } from './features.ts';
import type { TickEvent } from './protocol.ts';

interface Num { [k: string]: number }
const pay = (e: TickEvent) => (e.payload ?? {}) as Num;

export class EventLog {
  private byTick = new Map<number, TickEvent[]>();
  /** cc number -> its events in tick order, for "latest value at tick" lookups. */
  private ccs = new Map<number, TickEvent[]>();
  private beatMemo = { tick: NaN, ev: null as TickEvent | null };

  reset(events: TickEvent[] = []): void {
    this.byTick.clear(); this.ccs.clear(); this.beatMemo.tick = NaN;
    for (const e of events) this.add(e);
  }

  add(e: TickEvent): void {
    const list = this.byTick.get(e.tick);
    if (list) list.push(e); else this.byTick.set(e.tick, [e]);
    // keep a stable order within a tick so every host sees the same sequence
    list?.sort((a, b) => a.src - b.src);
    if (e.type === 'cc') {
      const c = pay(e).c, arr = this.ccs.get(c) ?? [];
      let i = arr.length;
      while (i > 0 && (arr[i - 1].tick > e.tick || (arr[i - 1].tick === e.tick && arr[i - 1].src > e.src))) i--;
      arr.splice(i, 0, e);
      this.ccs.set(c, arr);
    }
    this.beatMemo.tick = NaN;
  }

  at(tick: number): readonly TickEvent[] { return this.byTick.get(tick) ?? []; }

  has(tick: number, type: string): boolean { return this.at(tick).some((e) => e.type === type); }

  /** Drop events before `before`, except the latest value of each CC (params persist). */
  prune(before: number): void {
    for (const t of this.byTick.keys()) if (t < before) this.byTick.delete(t);
    for (const arr of this.ccs.values()) {
      let i = 0;
      while (i + 1 < arr.length && arr[i + 1].tick < before) i++;
      if (i) arr.splice(0, i);
    }
  }

  /** Value of CC `c` in effect at `tick` (0..127), or -1 if never set. */
  cc(tick: number, c: number): number {
    const arr = this.ccs.get(c);
    if (!arr) return -1;
    let lo = 0, hi = arr.length; // first index with tick > `tick`
    while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m].tick <= tick) lo = m + 1; else hi = m; }
    return lo ? pay(arr[lo - 1]).v : -1;
  }

  /** Most recent clock beat at or before `tick`, within BEAT_HOLD ticks. */
  lastBeat(tick: number): TickEvent | null {
    if (this.beatMemo.tick === tick) return this.beatMemo.ev;
    let ev: TickEvent | null = null;
    for (let i = 0; i < BEAT_HOLD && !ev; i++) for (const e of this.at(tick - i)) if (e.type === 'beat') ev = e;
    this.beatMemo.tick = tick; this.beatMemo.ev = ev;
    return ev;
  }

  /** The input-derived feature keys (K_NOTE ...), see constants.ts. */
  input(tick: number, k: number): number {
    if (k === K_NOTE || k === K_VEL) {
      let best: Num | null = null;
      for (const e of this.at(tick)) if (e.type === 'note' && (!best || pay(e).v > best.v)) best = pay(e);
      return best ? (k === K_NOTE ? best.n + 1 : best.v * 2) : 0;
    }
    if (k === K_BEAT) return this.has(tick, 'beat') ? 255 : 0;
    if (k === K_PHASE || k === K_BAR || k === K_BPM) {
      const b = this.lastBeat(tick);
      if (!b) return 0;
      const { bpm, n } = pay(b), age = tick - b.tick;
      if (k === K_BPM) return Math.min(255, Math.round(bpm / 100));
      const beats256 = Math.floor((age * bpm * 256) / (6000 * FPS)); // beats since b, in 1/256
      return k === K_PHASE ? beats256 & 255 : (n + (beats256 >> 8)) & 3;
    }
    if (k >= K_P0 && k < K_P0 + N_PARAMS) return Math.max(0, this.cc(tick, CC_PARAMS[k - K_P0]) * 2);
    return 0;
  }
}

/** Features plus inputs: a manual `hit` or a MIDI note counts as an onset on its tick. */
export function withEvents(F: FeatureSource, log: EventLog): FeatureSource {
  return {
    get: (t, k) => {
      if (k === K_ONSET) return log.has(t, 'hit') || log.has(t, 'note') ? 255 : F.get(t, k);
      return k < STRIDE ? F.get(t, k) : log.input(t, k);
    },
    wave: (t) => F.wave(t),
  };
}
