import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Room } from '../src/server/room.ts';
import type { WsConn } from '../src/server/ws.ts';
import { EventLog, withEvents } from '../src/core/events.ts';
import { silence } from '../src/core/features.ts';
import { K_PAL } from '../src/core/constants.ts';
import { BTN, fxAt, RING_EVERY, RING_LIFE } from '../src/core/fx.ts';
import type { RoomState, ServerMsg, TickEvent } from '../src/core/protocol.ts';

function setup() {
  const clock = { ms: 10_000 };
  const room = new Room(() => clock.ms);
  const join = () => {
    const got: ServerMsg[] = [];
    const ws = { onmessage: (_: Buffer | string) => {}, onclose: () => {}, json: (m: unknown) => got.push(m as ServerMsg), send: (s: string | Buffer) => { if (typeof s === 'string') got.push(JSON.parse(s)); } };
    room.join(ws as unknown as WsConn);
    return {
      got, ws, id: (got[0] as { you: number }).you,
      send: (m: unknown) => ws.onmessage(JSON.stringify(m)),
      evs: (type: string) => got.filter((m): m is { t: 'ev'; ev: TickEvent } => m.t === 'ev' && m.ev.type === type).map((m) => m.ev),
      state: () => [...got].reverse().find((m) => m.t === 'state') as RoomState,
    };
  };
  return { clock, room, join };
}

const pad = (tick: number, s: number, b = 0, a = [0, 0, 0, 0], t = [0, 0]): TickEvent => ({ tick, src: 1, type: 'pad', payload: { s, b, a, t } });

test('server: pads get room-wide slots, values are clamped, leaving frees the slot', () => {
  const { join } = setup();
  const a = join(), b = join();
  a.send({ t: 'hello', name: 'a' });
  a.send({ t: 'ev', type: 'pad', payload: { l: 0, b: 1, a: [500, -3, 0, 0], t: [50, 0] } });
  a.send({ t: 'ev', type: 'pad', payload: { l: 1, b: 0, a: [], t: [] } });
  b.send({ t: 'ev', type: 'pad', payload: { l: 0, b: 2 } });
  const ev = b.evs('pad');
  assert.deepEqual(ev.map((e) => (e.payload as { s: number }).s), [0, 1, 2]);
  assert.deepEqual(ev[0].payload, { s: 0, b: 1, a: [100, -3, 0, 0], t: [50, 0] });
  a.ws.onclose();
  assert.deepEqual(b.evs('pad').slice(3).map((e) => [(e.payload as { s: number }).s, (e.payload as { gone: number }).gone]), [[0, 1], [1, 1]]);
  const c = join();
  c.send({ t: 'ev', type: 'pad', payload: { l: 0 } });
  assert.equal((c.evs('pad').at(-1)!.payload as { s: number }).s, 0, 'freed slot reused');
});

test('server: palette and freeze are absolute state; tap tempo sets the grid', () => {
  const { clock, join } = setup();
  const a = join();
  a.send({ t: 'ev', type: 'palette', payload: { step: 1 } });
  a.send({ t: 'ev', type: 'palette', payload: { step: -3 } });
  assert.deepEqual(a.evs('palette').map((e) => e.payload), [{ v: 1 }, { v: 254 }]);
  a.send({ t: 'ev', type: 'freeze' });
  a.send({ t: 'ev', type: 'freeze' });
  assert.deepEqual(a.evs('freeze').map((e) => e.payload), [{ on: 1 }, { on: 0 }]);
  for (let i = 0; i < 4; i++) { a.send({ t: 'tap' }); clock.ms += 400; } // 150 bpm
  assert.equal(a.state().grid.tpb, 24);
});

test('fx: shockwaves repeat while held, cursors follow the stick, effects mix across pads', () => {
  const log = new EventLog();
  log.add(pad(100, 0, 1 << BTN.CROSS, [100, 0, 0, 0]));
  log.add(pad(100 + RING_EVERY * 2 + 3, 0, 0, [100, 0, 0, 0])); // released after 3 pulses
  log.add(pad(110, 1, (1 << BTN.TRIANGLE) | (1 << BTN.SQUARE), [0, -100, 50, 0], [80, 20]));
  let fx = fxAt(log, 100 + RING_EVERY * 2);
  const rings = fx.marks.filter((m) => m.r > 0), cursors = fx.marks.filter((m) => m.r === 0);
  assert.equal(rings.length, 3);
  assert.equal(cursors.length, 2);
  assert.ok(Math.abs(rings[0].x - 0.95) < 1e-9 && rings[0].y === 0.5);
  assert.equal(fx.kaleido, 1);
  assert.ok(Math.abs(fx.ky - 0.05) < 1e-9);
  assert.equal(fx.invert, 1);
  assert.equal(fx.trails, 0.8);
  assert.equal(fx.rotate, 0.5);
  fx = fxAt(log, 100 + RING_EVERY * 2 + RING_LIFE + 10);
  assert.equal(fx.marks.filter((m) => m.r > 0).length, 0, 'rings die out after release');
  assert.equal(fxAt(log, 50).marks.length, 0, 'nothing before the first event');
  // freeze + palette
  log.add({ tick: 200, src: 1, type: 'freeze', payload: { on: 1 } });
  log.add({ tick: 300, src: 1, type: 'freeze', payload: { on: 0 } });
  log.add({ tick: 250, src: 1, type: 'palette', payload: { v: 3 } });
  assert.equal(fxAt(log, 250).frozenAt, 200);
  assert.equal(fxAt(log, 300).frozenAt, null);
  assert.equal(withEvents(silence, log).get(260, K_PAL), 3);
});
