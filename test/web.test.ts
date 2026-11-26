import { test } from 'node:test';
import assert from 'node:assert/strict';
import { galleryBeats, galleryTrans, mainTrans, restoreAuto } from '../src/web/defaults.ts';
import { ZERO, cycleSched, cycleTicks, holdAt, randomEffect, retime, transTicks, type Cycle } from '../src/web/cycle.ts';
import { DoubleTap, SINGLE_MS, Taps, tapZone } from '../src/web/doubletap.ts';
import { micError } from '../src/web/capture.ts';
import { Room } from '../src/server/room.ts';
import { TRANSITIONS, type ServerMsg } from '../src/core/protocol.ts';

const store = (o: Record<string, string>) => (k: string) => o[k] ?? null;

test('app defaults: random, 8 beats; the remembered choice wins', () => {
  assert.deepEqual(mainTrans(store({})), { type: 'random', beats: 8 });
  assert.deepEqual(mainTrans(store({ trans: 'wipe', tlen: '2' })), { type: 'wipe', beats: 2 });
  assert.deepEqual(mainTrans(store({ trans: 'nonsense', tlen: '0' })), { type: 'random', beats: 0 });
});

test('auto-rotation: a device restores its choice only into a room nobody has set', () => {
  const preset = { bars: 8, trans: { type: 'random' as const, beats: 8 }, preset: true };
  assert.equal(restoreAuto(preset, store({})), null);
  assert.deepEqual(restoreAuto(preset, store({ auto: '0' })), { t: 'auto', bars: 0, trans: { type: 'random', beats: 8 } });
  assert.deepEqual(restoreAuto(preset, store({ trans: 'blend' })), { t: 'auto', bars: 8, trans: { type: 'blend', beats: 8 } });
  assert.equal(restoreAuto({ bars: 4, trans: preset.trans }, store({ auto: '0' })), null);
  assert.equal(restoreAuto(null, store({ auto: '16' })), null);
});

test('room: starts rotating every 8 bars, also after the tick space restarts', () => {
  let ms = 1e7;
  const room = new Room(() => ms, () => 0.5), got: ServerMsg[] = [];
  const state = () => got.filter((m) => m.t === 'state').at(-1) as Extract<ServerMsg, { t: 'state' }>;
  const ws = { on: () => {}, json: (m: ServerMsg) => got.push(m), send: (s: string) => got.push(JSON.parse(s)) };
  room.join(ws as never);
  assert.deepEqual(room.state.auto, { bars: 8, trans: { type: 'random', beats: 8 }, preset: true });
  const first = room.state.scene.id, bar = room.state.grid.tpb * 4;
  room.tickAuto();
  assert.equal(room.state.scene.id, first, 'not right at start-up');
  ms += (8 * bar * 1000) / 60;
  room.tickAuto();
  assert.notEqual(room.state.scene.id, first);
  assert.notEqual(room.state.scene.trans.type, 'cut');
  assert.ok(state());
});

test('gallery transitions: random unless trans= says otherwise; stills stay off', () => {
  const t = (q: string) => galleryTrans(new URLSearchParams(q));
  assert.equal(t(''), 'random');
  assert.equal(t('scene=radial&grid=1'), 'random'); // the grid draws no transitions anyway
  assert.equal(t('stop=3'), '');
  assert.equal(t('at=3'), '');
  assert.equal(t('stop=3&trans=iris'), 'iris');
  for (const off of ['off', 'none', '0', '']) assert.equal(t(`trans=${off}`), '');
  assert.equal(t('trans=all'), 'all');
  assert.equal(t('trans=cut'), 'cut');
  assert.equal(t('trans=bogus'), 'random');
});

test('random effect: deterministic, every effect, never twice in a row', () => {
  const seq = Array.from({ length: 2000 }, (_, i) => randomEffect(i));
  assert.deepEqual(seq.slice(0, 50), Array.from({ length: 50 }, (_, i) => randomEffect(i)));
  assert.equal(new Set(seq).size, TRANSITIONS.length - 1);
  assert.ok(!seq.includes('cut'));
  assert.ok(seq.every((t, i) => i === 0 || t !== seq[i - 1]));
});

test('gallery cycle: holds the given scene, then moves on; from tick 0 it is as before', () => {
  const c: Cycle = { ids: ['a', 'b', 'c'], trans: 'all', beats: 8 }, len = cycleTicks(8);
  const z = cycleSched(c, ZERO, len + 5);
  assert.deepEqual([z.prev, z.id, z.at, z.trans.type], ['a', 'b', len, TRANSITIONS[2]]);
  assert.equal(cycleSched(c, ZERO, 0).prev, 'c');
  const a = holdAt(1000, 1, 8), h = cycleSched(c, a, 1000);
  assert.equal(h.id, 'b');
  assert.ok(1000 - h.at >= transTicks(8), 'no transition running');
  const n = cycleSched(c, a, a.at + len);
  assert.deepEqual([n.prev, n.id], ['b', 'c']);
});

test('double-tap: two quick taps in one place', () => {
  const d = new DoubleTap();
  const tap = (t: number, x = 10, y = 10) => { d.down(t, x, y); return d.up(t + 50, x, y); };
  assert.equal(tap(0), false);
  assert.equal(tap(200), true);
  assert.equal(tap(350), false, 'a third tap starts over');
  assert.equal(tap(2000), false, 'too late for a pair');
  assert.equal(tap(2200, 200), false, 'too far apart');
  d.reset();
  d.down(3000, 0, 0); assert.equal(d.up(3800, 0, 0), false); // long press
  assert.equal(tap(3900, 0, 0), false);
  d.reset();
  tap(5000);
  d.down(5100, 10, 10); assert.equal(d.up(5150, 90, 10), false, 'a drag');
  d.reset();
  tap(6000);
  d.down(6100, 10, 10, 1); d.down(6110, 50, 50, 2); // two fingers
  assert.equal(d.up(6150, 10, 10, 1), false);
});

test('tap zones: thirds of the screen', () => {
  assert.deepEqual([0, 99, 100, 150, 200, 201, 299].map((x) => tapZone(x, 300)), [-1, -1, 0, 0, 0, 1, 1]);
});

test('single taps: reported once the double-tap window has passed, never for a double-tap', () => {
  const s = new Taps();
  const tap = (t: number, x = 10) => { s.down(t, x, 10); return s.up(t + 50, x, 10); };
  tap(0);
  assert.deepEqual(s.due(50 + SINGLE_MS - 1), [], 'still waiting');
  assert.deepEqual(s.due(50 + SINGLE_MS), [10]);
  assert.deepEqual(s.due(9999), [], 'only once');
  tap(10000);
  assert.equal(tap(10200), true);
  assert.deepEqual(s.due(20000), [], 'a double-tap is no single one');
  tap(30000); tap(30150, 500);
  assert.deepEqual(s.due(40000), [10, 500], 'quick taps far apart are two singles');
  s.down(50000, 0, 0); s.up(50800, 0, 0);
  s.down(51000, 0, 0); s.up(51050, 90, 0);
  assert.deepEqual(s.due(60000), [], 'a long press and a drag are no taps');
  tap(70000); s.reset();
  assert.deepEqual(s.due(80000), [], 'a press on a control drops the waiting tap');
});

test('gallery length: len= wins, then the remembered choice; stills ignore it', () => {
  const b = (q: string, r: string | null = null) => galleryBeats(new URLSearchParams(q), r);
  assert.equal(b(''), 8);
  assert.equal(b('', '2'), 2);
  assert.equal(b('len=4', '2'), 4);
  assert.equal(b('stop=3', '2'), 8);
  assert.equal(b('len=99'), 16);
  assert.equal(b('', 'nonsense'), 8);
});

test('gallery cycle: a new length starts with the next switch', () => {
  const c: Cycle = { ids: ['a', 'b', 'c'], trans: 'all', beats: 8 }, a = holdAt(1000, 1, 8);
  for (const tick of [1000, a.at + cycleTicks(8) + 5]) {
    const next = retime(c, a, tick), old = cycleSched(c, a, next.at), now = cycleSched({ ...c, beats: 1 }, next, next.at);
    assert.ok(next.at > tick && next.at - tick <= cycleTicks(8));
    assert.deepEqual([now.id, now.prev, now.at, now.trans.type], [old.id, old.prev, old.at, old.trans.type]);
    assert.equal(now.trans.ticks, transTicks(1));
    assert.equal(cycleSched({ ...c, beats: 1 }, next, next.at + cycleTicks(1)).prev, now.id);
  }
});

test('mic errors: a blocked mic says where to allow it', () => {
  const blocked = { name: 'NotAllowedError', message: 'The request is not allowed' };
  const nav = (userAgent: string, maxTouchPoints = 0) => ({ userAgent, maxTouchPoints });
  const ios = (browser: string) => `mic blocked: allow Microphone for this browser in iOS Settings → Apps → ${browser}, and for this site in the browser's site settings, then tap mic again`;
  const other = "mic blocked: allow the microphone for this site in the browser's site settings";
  const mac = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';
  assert.equal(micError(blocked, '', nav('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) CriOS/130.0 Mobile Safari/604.1', 5)), ios('Chrome'));
  assert.equal(micError(blocked, '', nav(mac, 5)), ios('Safari')); // iPadOS
  assert.equal(micError(blocked, '', nav(mac)), other);
  assert.equal(micError(blocked, '', nav('Mozilla/5.0 (Linux; Android 14) Chrome/130.0 Mobile Safari/537.36', 5)), other);
  assert.equal(micError({ name: 'NotFoundError', message: 'no device' }, '', nav(mac)), 'mic failed: no device');
  assert.equal(micError(blocked, ' (insecure)', nav(mac, 5)), 'mic failed: The request is not allowed (insecure)');
});
