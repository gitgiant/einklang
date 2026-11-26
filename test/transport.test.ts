import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Room } from '../src/server/room.ts';
import type { WsConn } from '../src/server/ws.ts';
import { FPS, STRIDE } from '../src/core/constants.ts';
import { modeTick, type RoomState, type ServerMsg } from '../src/core/protocol.ts';

function setup() {
  const clock = { ms: 50_000 };
  const room = new Room(() => clock.ms);
  const join = () => {
    const got: ServerMsg[] = [];
    const ws = { onmessage: (_: Buffer | string) => {}, onclose: () => {}, json: (m: unknown) => got.push(m as ServerMsg), send: (s: string | Buffer) => { if (typeof s === 'string') got.push(JSON.parse(s)); } };
    room.join(ws as unknown as WsConn);
    return {
      got, ws, id: (got[0] as { you: number }).you,
      send: (m: unknown) => ws.onmessage(JSON.stringify(m)),
      bin: (b: Uint8Array) => ws.onmessage(Buffer.from(b)),
      state: () => [...got].reverse().find((m) => m.t === 'state') as RoomState,
    };
  };
  return { clock, room, join };
}

const track = (frames: number) => {
  const b = new Uint8Array(5 + frames * STRIDE); b[0] = 2; new DataView(b.buffer).setUint32(1, frames, true); return b;
};

test('pause freezes the position, seek moves it, resume continues from it', () => {
  const { clock, room, join } = setup();
  const a = join();
  a.bin(track(60 * FPS));
  a.send({ t: 'play', name: 'song' });
  let s = a.state();
  assert.equal(s.mode === 'file' && s.name, 'song');
  clock.ms += 2500 + 10_000; // 10 s in
  a.send({ t: 'pause' });
  s = a.state();
  assert.equal(s.mode === 'file' && s.paused, 10 * FPS);
  clock.ms += 5000;
  assert.equal(room.tickNow(), 10 * FPS, 'frozen while paused');
  a.send({ t: 'seek', frame: 30 * FPS });
  assert.equal(room.tickNow(), 30 * FPS, 'seek while paused stays paused');
  const e0 = a.state().epoch;
  a.send({ t: 'resume' });
  s = a.state();
  assert.equal(s.epoch, e0 + 1);
  assert.equal(s.mode === 'file' && s.paused, null);
  clock.ms += 300 + 1000;
  assert.equal(modeTick(s, clock.ms), 31 * FPS);
  a.send({ t: 'seek', frame: 999_999 }); // clamped
  clock.ms += 300;
  assert.equal(room.tickNow(), 60 * FPS - 1);
  // a scene switch while paused lands on the frozen tick
  a.send({ t: 'pause' });
  a.send({ t: 'scene', id: 'scope', quant: 'bar' });
  s = a.state();
  assert.equal(s.scene.at, room.tickNow());
});

test('prev/next from any host is relayed to the playlist owner; owner leaving clears it', () => {
  const { join } = setup();
  const owner = join(), other = join();
  owner.send({ t: 'hello', name: 'owner' });
  other.send({ t: 'track', step: 1 });
  assert.ok(!owner.got.some((m) => m.t === 'track'), 'no playlist yet');
  owner.send({ t: 'playlist', names: ['a', 'b', 'c'], index: 2 });
  assert.deepEqual(other.state().playlist, { owner: owner.id, names: ['a', 'b', 'c'], index: 2 });
  other.send({ t: 'track', step: 1 });
  other.send({ t: 'track', step: -1 });
  other.send({ t: 'track', index: 0 });
  assert.deepEqual(owner.got.filter((m) => m.t === 'track').map((m) => (m as { index: number }).index), [0, 1, 0]);
  owner.ws.onclose();
  assert.equal(other.state().playlist, null);
});
