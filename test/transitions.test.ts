import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Room } from '../src/server/room.ts';
import type { WsConn } from '../src/server/ws.ts';
import { FPS, K_ONSET, STRIDE } from '../src/core/constants.ts';
import { INPUT_DELAY, TRANSITIONS, sceneAt, type RoomState, type SceneSched, type ServerMsg, type TransType } from '../src/core/protocol.ts';
import { ONE, pickRandom, progress, transitionAt } from '../src/core/transitions.ts';
import { demoSource } from '../src/core/demo.ts';
import { silence, type FeatureSource } from '../src/core/features.ts';

function setup(rand = Math.random) {
  const clock = { ms: 50_000 };
  const room = new Room(() => clock.ms, rand);
  const got: ServerMsg[] = [];
  const ws = { onmessage: (_: Buffer | string) => {}, onclose: () => {}, json: (m: unknown) => got.push(m as ServerMsg), send: (s: string | Buffer) => { if (typeof s === 'string') got.push(JSON.parse(s)); } };
  room.join(ws as unknown as WsConn);
  const send = (m: unknown) => ws.onmessage(JSON.stringify(m));
  const state = () => [...got].reverse().find((m) => m.t === 'state') as RoomState;
  const scene = (trans: { type: string; beats: number } | undefined, quant = 'beat', step = 1) => { send({ t: 'scene', step, quant, trans }); return state().scene; };
  const bin = (b: Uint8Array) => ws.onmessage(Buffer.from(b));
  return { clock, room, send, bin, state, scene };
}
const onBeat = (at: number, s: RoomState) => Math.abs(((at - s.grid.origin) / s.grid.tpb) - Math.round((at - s.grid.origin) / s.grid.tpb)) < 1e-9;

test('a transition starts on the boundary, with its length frozen to ticks and a seed', () => {
  const { room, state, scene, send, clock } = setup();
  const t = room.tickNow();
  const s = scene({ type: 'iris', beats: 2 }, 'bar');
  const st = state();
  assert.equal(s.trans.type, 'iris');
  assert.equal(s.trans.ticks, Math.round(2 * st.grid.tpb));
  assert.ok(Number.isInteger(s.trans.seed) && s.trans.seed >= 0 && s.trans.seed < 2 ** 32);
  assert.ok(s.at >= t + INPUT_DELAY);
  assert.equal((s.at - st.grid.origin) % (st.grid.tpb * 4), 0);
  // a tempo change afterwards (tap) doesn't touch the scheduled length
  for (let i = 0; i < 4; i++) { send({ t: 'tap' }); clock.ms += 400; }
  assert.notEqual(state().grid.tpb, st.grid.tpb);
  assert.equal(state().scene.trans.ticks, s.trans.ticks);
  // 0 beats, cut, unknown and missing are all a plain cut
  for (const tr of [{ type: 'blend', beats: 0 }, { type: 'cut', beats: 4 }, { type: 'nope', beats: 4 }, undefined]) {
    clock.ms += 20_000;
    assert.deepEqual(scene(tr).trans.type, 'cut', JSON.stringify(tr));
  }
});

test('requests during a transition queue after it; steps count from the latest one', () => {
  const { room, state, scene } = setup();
  const s1 = scene({ type: 'blend', beats: 4 });
  const s2 = scene({ type: 'wipe', beats: 1 });
  const s3 = scene({ type: 'glitch', beats: 1 });
  const st = state();
  assert.deepEqual([s1.prev, s1.id, s2.id, s3.id], ['radial', 'tunnel', 'scope', 'flow']);
  assert.ok(s2.at >= s1.at + s1.trans.ticks && onBeat(s2.at, st));
  assert.ok(s3.at >= s2.at + s2.trans.ticks && onBeat(s3.at, st));
  assert.equal(s3.prev, 'scope');
  assert.deepEqual(s3.earlier.map((e) => e.id), ['tunnel', 'scope']);
  // what every host shows at each tick
  const sc = state().scene, t0 = room.tickNow();
  assert.equal(sceneAt(sc, t0), 'radial');
  assert.equal(transitionAt(sc, s1.at, silence)?.type, 'blend');
  assert.equal(transitionAt(sc, s2.at + 1, silence)?.to, 'scope');
  assert.equal(transitionAt(sc, s3.at + s3.trans.ticks, silence), null);
  assert.equal(sceneAt(sc, s3.at + s3.trans.ticks), 'flow');
});

test('a pending cut is replaced, as before transitions', () => {
  const { scene } = setup();
  const a = scene(undefined, 'bar');
  const b = scene(undefined, 'bar');
  assert.equal(a.id, 'tunnel');
  assert.equal(b.id, 'scope');
  assert.equal(b.prev, 'radial');
  assert.equal(b.at, a.at);
  assert.equal(b.earlier.length, 0);
});

test('random is never cut and never the previous effect', () => {
  let r = 0;
  const { clock, scene } = setup(() => (r = (r * 9301 + 49297) % 233280) / 233280);
  let last: TransType | null = null;
  const seen = new Set<TransType>();
  for (let i = 0; i < 200; i++) {
    clock.ms += 30_000; // let the previous one finish
    const t = scene({ type: 'random', beats: 1 }).trans.type;
    assert.notEqual(t, 'cut');
    assert.notEqual(t, last);
    seen.add(t); last = t;
  }
  assert.equal(seen.size, TRANSITIONS.length - 1);
  for (let k = 0; k < 50; k++) assert.notEqual(pickRandom('iris', k / 50), 'iris');
});

test('pause keeps a running transition (frozen); seek resets it', () => {
  const { clock, room, send, bin, state, scene } = setup();
  const b = new Uint8Array(5 + 600 * FPS * STRIDE); b[0] = 2; new DataView(b.buffer).setUint32(1, 600 * FPS, true);
  bin(b);
  send({ t: 'play' });
  clock.ms += 2500 + 5000;
  const s = scene({ type: 'blend', beats: 4 });
  clock.ms += ((s.at - room.tickNow() + 20) * 1000) / FPS; // 20 ticks into it
  send({ t: 'pause' });
  assert.deepEqual(state().scene, s);
  assert.equal(transitionAt(state().scene, room.tickNow(), silence)?.type, 'blend');
  send({ t: 'resume' });
  assert.deepEqual(state().scene, s);
  send({ t: 'seek', frame: 100 });
  assert.equal(state().scene.earlier.length, 0);
  assert.equal(state().scene.trans.type, 'cut');
});

const sched = (type: TransType, ticks: number, tpb = 28): SceneSched =>
  ({ id: 'b', prev: 'a', at: 1000, trans: { type, ticks, seed: 123, tpb }, earlier: [] });

test('curves: exact endpoints, monotonic where expected', () => {
  const F = demoSource();
  for (const type of TRANSITIONS.filter((t) => t !== 'cut')) {
    const s = sched(type, 112);
    assert.equal(transitionAt(s, 999, F), null);
    assert.equal(transitionAt(s, 1000, F)!.p16, 0, `${type} starts at 0`);
    assert.equal(transitionAt(s, 1112, F), null, `${type} ends on time`);
    assert.equal(sceneAt(s, 1112), 'b');
    assert.equal(transitionAt(s, 1000, F)!.from, 'a');
    if (type === 'stutter') continue;
    let prev = -1;
    for (let t = 1000; t < 1112; t++) {
      const p = transitionAt(s, t, F)!.p16;
      assert.ok(p >= prev && p <= ONE, `${type} monotonic at ${t}`);
      prev = p;
    }
    assert.ok(prev > ONE * 0.98, `${type} nearly done on its last tick (${prev})`);
  }
  assert.equal(transitionAt(sched('cut', 0), 1000, F), null);
});

test('stutter: cuts back to the old scene only on 1/8-beat steps, and the new share grows', () => {
  const tpb = 28, step = tpb / 8, s = sched('stutter', 4 * tpb, tpb);
  const ps = Array.from({ length: 4 * tpb }, (_, i) => transitionAt(s, 1000 + i, silence)!.p16);
  assert.ok(ps.every((p) => p === 0 || p === ONE));
  for (let i = 1; i < ps.length; i++) {
    if (ps[i - 1] === ONE && ps[i] === 0) assert.notEqual(Math.floor(i / step), Math.floor((i - 1) / step), `back-cut at ${i} is on a step`);
  }
  const share = (k: number) => ps.filter((_, i) => Math.floor(i / step) >= k * 8 && Math.floor(i / step) < (k + 1) * 8).filter((p) => p).length;
  assert.ok(share(0) < share(1) && share(1) < share(2) && share(2) < share(3), `${[0, 1, 2, 3].map(share)}`);
  assert.equal(ps[0], 0);
  assert.equal(ps[ps.length - 1], ONE);
});

test('audio mask: onsets push it ahead, never past 1, and it ends on time', () => {
  const s = sched('audio', 112);
  const onsets: FeatureSource = { get: (t, k) => (k === K_ONSET && t % 14 === 0 ? 255 : 0), wave: () => null };
  let ahead = 0;
  for (let t = 1000; t < 1112; t++) {
    const quiet = transitionAt(s, t, silence)!.p16, loud = transitionAt(s, t, onsets)!;
    assert.ok(loud.p16 >= quiet && loud.p16 <= ONE);
    assert.equal(loud.bands!.length, 16);
    if (loud.p16 > quiet) ahead++;
  }
  assert.ok(ahead > 50);
  assert.equal(transitionAt(s, 1112, onsets), null);
  assert.equal(progress(s.trans, 1000, 0, silence), 0);
});

test('glitch re-rolls bands every 1/16 beat; seeded params come through', () => {
  const s = sched('glitch', 56);
  const rolls = new Set(Array.from({ length: 56 }, (_, i) => transitionAt(s, 1000 + i, silence)!.roll));
  assert.equal(rolls.size, 32);
  assert.equal(transitionAt(s, 1010, silence)!.seed, 123);
  const f = sched('flash', 112), peak = Array.from({ length: 112 }, (_, i) => transitionAt(f, 1000 + i, silence)!);
  const top = peak.reduce((a, b) => (b.flash16 > a.flash16 ? b : a));
  assert.ok(Math.abs(top.p - 0.25) < 0.05, `flash peaks near p = 0.25 (${top.p})`);
});
