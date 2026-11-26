import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Room, CLOCK_TIMEOUT_MS } from '../src/server/room.ts';
import type { WsConn } from '../src/server/ws.ts';
import { EventLog, withEvents } from '../src/core/events.ts';
import { silence } from '../src/core/features.ts';
import { FPS, K_BAR, K_BEAT, K_BPM, K_NOTE, K_ONSET, K_P0, K_PHASE, K_VEL } from '../src/core/constants.ts';
import { INPUT_DELAY, modeTickF, type RoomState, type ServerMsg, type TickEvent } from '../src/core/protocol.ts';
import { radial } from '../src/core/scenes/radial.ts';
import { hashState } from '../src/core/scene.ts';

/** In-process room with a fake clock and fake sockets. */
function setup() {
  const clock = { ms: 100_000 };
  const room = new Room(() => clock.ms);
  const join = () => {
    const got: ServerMsg[] = [];
    const ws = { onmessage: (_: Buffer | string) => {}, onclose: () => {}, json: (m: unknown) => got.push(m as ServerMsg), send: (s: string | Buffer) => { if (typeof s === 'string') got.push(JSON.parse(s)); } };
    room.join(ws as unknown as WsConn);
    const id = (got.find((m) => m.t === 'welcome') as { you: number }).you;
    return {
      id, got, ws,
      send: (m: unknown) => ws.onmessage(JSON.stringify(m)),
      evs: (type: string) => got.filter((m): m is { t: 'ev'; ev: TickEvent } => m.t === 'ev' && m.ev.type === type).map((m) => m.ev),
      state: () => [...got].reverse().find((m) => m.t === 'state') as RoomState,
    };
  };
  return { clock, room, join };
}

test('MIDI events: notes and CCs are sanitized, clients cannot forge beats', () => {
  const { join } = setup();
  const a = join();
  a.send({ t: 'ev', type: 'note', payload: { n: 60, v: 100, junk: 'x'.repeat(100) } });
  a.send({ t: 'ev', type: 'note', payload: { n: 200, v: 100 } });
  a.send({ t: 'ev', type: 'note', payload: { n: 60, v: 0 } });
  a.send({ t: 'ev', type: 'cc', payload: { c: 1, v: 64 } });
  a.send({ t: 'ev', type: 'beat', payload: { bpm: 12000, n: 0 } });
  a.send({ t: 'ev', type: 'transport', payload: { op: 'rm -rf' } });
  assert.deepEqual(a.evs('note').map((e) => e.payload), [{ n: 60, v: 100 }]);
  assert.deepEqual(a.evs('cc').map((e) => e.payload), [{ c: 1, v: 64 }]);
  assert.equal(a.evs('beat').length, 0);
  assert.equal(a.evs('transport').length, 0);
});

test('MIDI clock: first master wins, next beat is stamped where it will fall, grid follows', () => {
  const { clock, join } = setup();
  const a = join(), b = join();
  const beatMs = 500; // 120 bpm
  a.send({ t: 'clock', at: clock.ms - 5, bpm: 120, n: 3 });
  const st = a.state();
  assert.equal(st.clock, a.id);
  const [beat] = a.evs('beat');
  assert.deepEqual(beat.payload, { bpm: 12000, n: 4 });
  assert.equal(beat.tick, Math.round(modeTickF(st, clock.ms - 5 + beatMs)));
  assert.ok(beat.tick >= Math.floor(modeTickF(st, clock.ms)) + INPUT_DELAY);
  // grid: 30 ticks/beat, beat 4 is a downbeat
  assert.equal(st.grid.tpb, 30);
  assert.ok(Math.abs(((beat.tick - st.grid.origin) % 120 + 120) % 120) < 1 || Math.abs(((beat.tick - st.grid.origin) % 120 + 120) % 120 - 120) < 1);

  // a second clock is ignored while the master is alive...
  clock.ms += beatMs;
  b.send({ t: 'clock', at: clock.ms - 5, bpm: 90, n: 0 });
  assert.equal(a.evs('beat').length, 1);
  // ...the master's own next report doesn't double-stamp beat 5's predecessor
  a.send({ t: 'clock', at: clock.ms - 5, bpm: 120, n: 4 });
  assert.deepEqual(a.evs('beat').map((e) => (e.payload as { n: number }).n), [4, 5]);
  a.send({ t: 'clock', at: clock.ms - 5, bpm: 120, n: 4 }); // duplicate report
  assert.equal(a.evs('beat').length, 2);

  // ...and takes over after CLOCK_TIMEOUT_MS of silence
  clock.ms += CLOCK_TIMEOUT_MS + 1;
  b.send({ t: 'clock', at: clock.ms - 5, bpm: 90, n: 0 });
  assert.equal(a.state().clock, b.id);
  assert.equal(a.evs('beat').at(-1)!.src, b.id);
  assert.equal(a.state().grid.tpb, 40);
});

test('CC values survive the log window and new timelines; joiners get them', () => {
  const { clock, join } = setup();
  const a = join();
  a.send({ t: 'ev', type: 'cc', payload: { c: 74, v: 99 } });
  clock.ms += 120_000; // far past the event log window
  for (let i = 0; i < 5; i++) { a.send({ t: 'ev', type: 'hit' }); clock.ms += 1000; }
  const b = join();
  const log = b.got.find((m) => m.t === 'log') as { events: TickEvent[] };
  assert.ok(log.events.some((e) => e.type === 'cc' && (e.payload as { v: number }).v === 99));
  assert.ok(!log.events.some((e) => e.type === 'hit' && e.tick < log.events.at(-1)!.tick - 5 * FPS - 10));

  a.send({ t: 'live' });
  const st = a.state();
  const carried = a.evs('cc').at(-1)!;
  assert.equal(st.mode, 'live');
  assert.equal((carried.payload as { v: number }).v, 99);
  assert.ok(carried.tick < 0 + INPUT_DELAY + 1); // live starts 300 ms ahead: stamped in the new tick space
});

test('withEvents: notes are onsets with pitch, beats give phase / bar / bpm, CCs hold', () => {
  const log = new EventLog();
  log.add({ tick: 50, src: 1, type: 'note', payload: { n: 60, v: 40 } });
  log.add({ tick: 50, src: 2, type: 'note', payload: { n: 64, v: 90 } });
  log.add({ tick: 100, src: 1, type: 'beat', payload: { bpm: 12000, n: 7 } }); // 30 ticks/beat
  log.add({ tick: 10, src: 1, type: 'cc', payload: { c: 1, v: 100 } });
  log.add({ tick: 5, src: 1, type: 'cc', payload: { c: 1, v: 20 } }); // out of order
  const F = withEvents(silence, log);
  assert.equal(F.get(50, K_ONSET), 255);
  assert.equal(F.get(50, K_NOTE), 65); // loudest note, pitch + 1
  assert.equal(F.get(50, K_VEL), 180);
  assert.equal(F.get(51, K_NOTE), 0);
  assert.equal(F.get(100, K_BEAT), 255);
  assert.equal(F.get(99, K_BPM), 0);
  assert.equal(F.get(100, K_BPM), 120);
  assert.equal(F.get(115, K_PHASE), 128);
  assert.equal(F.get(100, K_BAR), 3);
  assert.equal(F.get(130, K_BAR), 0); // predicted on past the beat until the next one lands
  assert.equal(F.get(400, K_BPM), 0); // clock gone
  assert.equal(F.get(7, K_P0), 40);
  assert.equal(F.get(9999, K_P0), 200);
  log.prune(5000);
  assert.equal(F.get(9999, K_P0), 200); // the latest value survives pruning
  // MIDI changes the picture; no MIDI leaves it exactly as before (pinned hashes)
  assert.notEqual(hashState(radial.state(60, F)), hashState(radial.state(60, silence)));
});
