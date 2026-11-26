import { test } from 'node:test';
import assert from 'node:assert/strict';
import { demoSource } from '../src/core/demo.ts';
import { hashState } from '../src/core/scene.ts';
import { radial } from '../src/core/scenes/radial.ts';
import { tunnel, RING } from '../src/core/scenes/tunnel.ts';
import { scope } from '../src/core/scenes/scope.ts';
import { flow } from '../src/core/scenes/flow.ts';
import { FPS, INSTRUMENT_DELAY, LIVE_DELAY } from '../src/core/constants.ts';
import { modeTick, type SceneSched } from '../src/core/protocol.ts';
import { ONE, transitionAt } from '../src/core/transitions.ts';
import { silence } from '../src/core/features.ts';
import { Room } from '../src/server/room.ts';
import type { WsConn } from '../src/server/ws.ts';
import type { RoomState, ServerMsg } from '../src/core/protocol.ts';

const SUBS = [0, 64, 128, 192, 255];

test('sub = 0 is exactly the hashed tick state', () => {
  const F = demoSource();
  for (const sc of [radial, tunnel, scope, flow]) for (const f of [0, 777, 2300]) {
    assert.equal(hashState(sc.state(f, F, 0)), hashState(sc.state(f, F)), `${sc.id} @${f}`);
  }
});

test('tunnel: depth, twist and hue move continuously through the sub-ticks', () => {
  const F = demoSource();
  for (let f = 1000; f < 1400; f++) {
    const seq = [...SUBS.map((s) => tunnel.state(f, F, s).u), tunnel.state(f + 1, F).u];
    for (let i = 1; i < seq.length; i++) {
      // mod RING: an onset leaving the lookback drops exactly whole rings (invisible by design)
      const dz = (((seq[i][0] - seq[i - 1][0]) % RING) + RING) % RING;
      assert.ok(dz < RING / 4, `z steps forward by less than a ring at ${f}/${i} (${dz})`);
      // hue also drops 96 when an onset leaves the lookback: a tick-to-tick step, so check sub-ticks only
      if (i < SUBS.length) assert.ok(seq[i][2] >= seq[i - 1][2], `hue at ${f}/${i}`);
    }
  }
});

test('radial: onset rings and bursts move between ticks instead of jumping', () => {
  const F = demoSource(), f = 1500; // the kick at 1484 is 16 ticks old: its ring is still growing
  const rings = (s: number) => { const p = radial.state(f, F, s).prims!, r: number[] = []; for (let o = 0; o < p.length; o += 8) if (p[o] === 2) r.push(p[o + 3]); return r; };
  const r = SUBS.map(rings);
  assert.ok(r[0].length > 0);
  for (let i = 1; i < r.length; i++) r[i].forEach((x, k) => assert.ok(x >= r[i - 1][k], `ring ${k} grows at sub ${SUBS[i]}`));
  assert.equal(r[2][0] - r[0][0], 6, 'half a tick = half of the 12 px/tick growth');
});

test('scope and flow show their latest tick (sub ignored)', () => {
  const F = demoSource();
  for (const sc of [scope, flow]) assert.equal(hashState(sc.state(900, F, 200)), hashState(sc.state(900, F)), sc.id);
});

test('transition progress is placed between ticks by sub', () => {
  const s: SceneSched = { id: 'b', prev: 'a', at: 0, trans: { type: 'blend', ticks: 112, seed: 1, tpb: 28 }, earlier: [] };
  for (let t = 0; t < 111; t++) {
    const ps = [...SUBS.map((sub) => transitionAt(s, t, silence, sub)!.p16), transitionAt(s, t + 1, silence)!.p16];
    for (let i = 1; i < ps.length; i++) assert.ok(ps[i] >= ps[i - 1] && ps[i] <= ONE, `${t}/${i}`);
  }
});

test('live delay: instrument mode renders 2 ticks behind, captured audio 6; the server clamps it', () => {
  const start = 10_000, ms = start + 1000;
  assert.equal(modeTick({ mode: 'live', start, delay: INSTRUMENT_DELAY }, ms), FPS - INSTRUMENT_DELAY);
  assert.equal(modeTick({ mode: 'live', start, delay: LIVE_DELAY }, ms), FPS - LIVE_DELAY);
  const room = new Room(() => 50_000), got: ServerMsg[] = [];
  const ws = { onmessage: (_: string) => {}, onclose: () => {}, json: (m: unknown) => got.push(m as ServerMsg), send: (x: string | Buffer) => { if (typeof x === 'string') got.push(JSON.parse(x)); } };
  room.join(ws as unknown as WsConn);
  const live = (m: object) => { ws.onmessage(JSON.stringify({ t: 'live', ...m })); const s = [...got].reverse().find((x) => x.t === 'state') as RoomState; return s.mode === 'live' ? s.delay : -1; };
  assert.equal(live({ delay: 2 }), 2);
  assert.equal(live({}), LIVE_DELAY);
  assert.equal(live({ delay: 0 }), 1);
  assert.equal(live({ delay: 500 }), 30);
  assert.equal(live({ delay: 'x' }), 1);
});
