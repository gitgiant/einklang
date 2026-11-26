// Tick-stamped inputs as seen by a host. Events are applied on their stamped tick on every host,
// so they're part of the deterministic input alongside the audio features.
import { K_ONSET } from './constants.ts';
import type { FeatureSource } from './features.ts';
import type { TickEvent } from './protocol.ts';

export class EventLog {
  private byTick = new Map<number, TickEvent[]>();

  reset(events: TickEvent[] = []): void { this.byTick.clear(); for (const e of events) this.add(e); }

  add(e: TickEvent): void {
    const list = this.byTick.get(e.tick);
    if (list) list.push(e); else this.byTick.set(e.tick, [e]);
    // keep a stable order within a tick so every host sees the same sequence
    list?.sort((a, b) => a.src - b.src);
  }

  at(tick: number): readonly TickEvent[] { return this.byTick.get(tick) ?? []; }

  has(tick: number, type: string): boolean { return this.at(tick).some((e) => e.type === type); }

  prune(before: number): void { for (const t of this.byTick.keys()) if (t < before) this.byTick.delete(t); }
}

/** Features plus inputs: a manual `hit` counts as an onset on its tick. */
export function withEvents(F: FeatureSource, log: EventLog): FeatureSource {
  return {
    get: (t, k) => (k === K_ONSET && log.has(t, 'hit') ? 255 : F.get(t, k)),
    wave: (t) => F.wave(t),
  };
}
