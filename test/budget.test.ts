import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Room } from '../src/server/room.ts';
import type { WsConn } from '../src/server/ws.ts';
import { RESEED_TICKS } from '../src/core/constants.ts';
import { FLOW_N_DEFAULT, FLOW_N_MAX, FLOW_N_MIN, INPUT_DELAY, flowNAt, type RoomState, type ServerMsg } from '../src/core/protocol.ts';

function setup() {
  const clock = { ms: 50_000 };
  const room = new Room(() => clock.ms);
  const got: ServerMsg[] = [];
  const join = () => {
    const ws = { onmessage: (_: string) => {}, onclose: () => {}, json: (m: unknown) => got.push(m as ServerMsg), send: (s: string | Buffer) => { if (typeof s === 'string') got.push(JSON.parse(s)); } };
    room.join(ws as unknown as WsConn);
    const send = (m: unknown) => ws.onmessage(JSON.stringify(m));
    send({ t: 'hello', name: `h${Math.random()}` });
    return { send, leave: () => ws.onclose() };
  };
  const state = () => [...got].reverse().find((m) => m.t === 'state') as RoomState;
  return { clock, room, join, state };
}

test('N is the default until a host reports, then the weakest report, rounded to a power of two', () => {
  const { room, join, state } = setup();
  const a = join();
  assert.equal(state().flow.n, FLOW_N_DEFAULT);
  a.send({ t: 'bench', n: 300_000 }); // -> 2^18
  assert.equal(state().flow.n, 1 << 18);
  assert.equal(state().hosts[0].cap, 1 << 18);
  const b = join();
  b.send({ t: 'bench', n: 1 << 15 });
  const f = state().flow, t = room.tickNow();
  assert.equal(f.n, 1 << 15);
  assert.equal(f.at % RESEED_TICKS, 0, 'a lower N waits for a reseed boundary');
  assert.ok(f.at >= t + INPUT_DELAY && f.at < t + INPUT_DELAY + RESEED_TICKS);
  assert.equal(flowNAt(f, f.at - 1), f.prev);
  assert.equal(flowNAt(f, f.at), 1 << 15);
  b.leave(); // the weak host leaves: back up to the strongest remaining
  assert.equal(state().flow.n, 1 << 18);
  for (const [n, want] of [[-5, 1 << 18], ['x', 1 << 18], [1, FLOW_N_MIN], [1e9, FLOW_N_MAX]] as const) {
    a.send({ t: 'bench', n });
    assert.equal(state().flow.n, want, String(n));
  }
});

test('a new timeline applies the budget at once', () => {
  const { join, state } = setup();
  const a = join();
  a.send({ t: 'bench', n: 1 << 14 });
  a.send({ t: 'live', delay: 2 });
  assert.deepEqual(state().flow, { n: 1 << 14, prev: 1 << 14, at: 0 });
});
