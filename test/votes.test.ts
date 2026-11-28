import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { Room, memoryVotes } from '../src/server/room.ts';
import { fileVotes, labCatalog, startServer } from '../src/server/main.ts';
import type { WsConn } from '../src/server/ws.ts';
import { STRIDE } from '../src/core/constants.ts';
import { INPUT_DELAY, sceneAt, type RoomState, type ServerMsg } from '../src/core/protocol.ts';
import { RETIRE_AT, TRANS_TAGS, cleanTags, parseVotes, pickWeighted, tally, weight, type Vote } from '../src/core/votes.ts';
import { pickRandom, randomPool, transEffects, transitions } from '../src/core/transitions.ts';
import { ranTransition, fixedScene } from '../src/core/protocol.ts';
import { cycleSched, randomEffect, ZERO } from '../src/web/cycle.ts';
import { digest, feedbackMd } from '../scripts/lab/feedback.ts';
import { loadPieces, loadScenes, LAB } from '../scripts/lab/load.ts';

const V = (scene: string, vote: 1 | -1, tags: string[] = []): Vote => ({ scene, vote, tags, at: '2026-11-26T00:00:00.000Z' });

test('votes: tally, weights, weighted pick, parsing', () => {
  const t = tally([V('a', 1, ['calm']), V('a', 1), V('a', -1, ['calm', 'boring']), V('b', -1)]);
  assert.deepEqual(t.get('a'), { up: 2, down: 1, tags: { calm: 2, boring: 1 } });
  assert.equal(weight(0), 1); assert.equal(weight(1), 2); assert.equal(weight(-1), 0.5); assert.equal(weight(99), 16); assert.equal(weight(-99), 1 / 8);
  // weights 1 (a) and 4 (b): b gets 80% of the line, and `not` is never picked while there's another choice
  const ids = ['a', 'b'], sc = { b: 2 };
  assert.equal(pickWeighted(ids, sc, 0.19), 'a');
  assert.equal(pickWeighted(ids, sc, 0.21), 'b');
  for (let r = 0; r < 1; r += 0.05) assert.equal(pickWeighted(ids, sc, r, 'b'), 'a');
  assert.equal(pickWeighted(['a'], {}, 0.5, 'a'), 'a', 'the only scene stays');
  assert.equal(pickWeighted([], {}, 0.5), undefined);
  const parsed = parseVotes(`${JSON.stringify(V('a', 1, ['calm', 3 as unknown as string]))}\nnot json\n{"scene":"x","vote":5}\n${JSON.stringify(V('b', -1))}\n{"scene":"c","vo`);
  assert.deepEqual(parsed.map((v) => [v.scene, v.vote, v.tags]), [['a', 1, ['calm']], ['b', -1, []]]);
  assert.deepEqual(cleanTags(['calm', 'calm', 'nope', 7, 'boring']), ['calm', 'boring']);
  assert.deepEqual(cleanTags('calm'), []);
});

const T = (transition: string, vote: 1 | -1, tags: string[] = [], extra: object = {}): Vote => ({ transition, vote, tags, at: '2026-11-26T00:00:00.000Z', ...extra });

test('votes: old scene lines and transition lines parse side by side and tally apart', () => {
  const old = '{"scene":"radial","at":"2026-11-20T00:00:00.000Z","vote":1,"tags":["calm"],"live":true,"tick":5}';
  const lines = [old, JSON.stringify(T('core-wipe', -1, ['too fast'], { from: 'radial', to: 'tunnel', beats: 4 })), '{"vote":1}', '{"scene":"a","transition":"core-wipe","vote":1}', '{"transition":7,"vote":1}'];
  const v = parseVotes(lines.join('\n'));
  assert.equal(v.length, 2);
  assert.deepEqual([...tally(v).keys()], ['radial']);
  assert.deepEqual([...tally(v, 'transition')], [['core-wipe', { up: 0, down: 1, tags: { 'too fast': 1 } }]]);
  assert.deepEqual(cleanTags(['smooth', 'too busy', 'boring'], TRANS_TAGS), ['smooth', 'boring']);
});

test('transitions: weighted server pick follows the scores, skips retired ones, repeats for the same inputs', () => {
  const E = transEffects(), rs = Array.from({ length: 4000 }, (_, i) => (i + 0.5) / 4000);
  // no votes: uniform over everything but `last`, as before votes existed
  const pool = E.filter((t) => t !== 'core-wipe');
  for (const r of rs) assert.equal(pickRandom('core-wipe', r), pool[Math.floor(r * pool.length)]);
  const scores = { 'core-blend': 2, 'core-iris': -1, 'core-melt': -2 };
  const seen = new Map<string, number>();
  for (const r of rs) { const t = pickRandom(null, r, scores); seen.set(t, (seen.get(t) ?? 0) + 1); assert.equal(pickRandom(null, r, { ...scores }), t); }
  assert.equal(seen.has('core-melt'), false, 'retired');
  assert.ok(Math.abs(seen.get('core-blend')! / seen.get('core-wipe')! - 4) < 0.1);
  assert.ok(Math.abs(seen.get('core-iris')! / seen.get('core-wipe')! - 0.5) < 0.05);
  // everything retired: random still picks something
  assert.deepEqual(randomPool(Object.fromEntries(E.map((t) => [t, -5]))), E);
});

test('transitions: the gallery\'s weighted sequence is deterministic, never repeats and follows the scores', () => {
  const scores = { 'core-blend': 3, 'core-melt': -2 };
  const seq = (s: Record<string, number>) => Array.from({ length: 4000 }, (_, i) => randomEffect(i - 40, s));
  const a = seq(scores);
  assert.deepEqual(seq({ ...scores }), a);
  // any order of evaluation gives the same answers
  for (let i = a.length - 1; i >= 0; i -= 7) assert.equal(randomEffect(i - 40, scores), a[i]);
  for (let i = 1; i < a.length; i++) assert.notEqual(a[i], a[i - 1], `switch ${i - 40}`);
  assert.equal(a.includes('core-melt'), false);
  const n = (id: string) => a.filter((t) => t === id).length;
  assert.ok(n('core-blend') > 3 * n('core-wipe'), `${n('core-blend')} vs ${n('core-wipe')}`);
  assert.deepEqual(seq({ 'core-blend': 0 }), seq({}), 'a zero score is no vote');
  // a small pool alternates
  const two = Object.fromEntries(transEffects().slice(2).map((t) => [t, -2]));
  assert.deepEqual(new Set([randomEffect(0, two), randomEffect(1, two)]), new Set(transEffects().slice(0, 2)));
  // the cycle uses them; a named effect ignores them
  const c = { ids: ['a', 'b'], trans: 'random' as const, beats: 4, scores };
  assert.equal(cycleSched(c, ZERO, 5).trans.type, randomEffect(0, scores));
  assert.equal(cycleSched({ ...c, trans: 'core-melt' }, ZERO, 5).trans.type, 'core-melt');
});

test('ranTransition: the running or last finished switch; cuts and the starting hold are not one', () => {
  const trans = { type: 'core-wipe', ticks: 112, seed: 1, tpb: 28 };
  const s = { id: 'b', prev: 'a', at: 100, trans, earlier: [] };
  assert.equal(ranTransition(s, 99), null);
  const ran = { type: 'core-wipe', from: 'a', to: 'b', beats: 4, at: 100 };
  assert.deepEqual(ranTransition(s, 150), ran);
  assert.deepEqual(ranTransition(s, 9999), ran);
  assert.equal(ranTransition(fixedScene('a'), 5), null);
  assert.equal(ranTransition({ ...s, prev: 'b' }, 150), null);
});

function setup(opts: { catalog?: string[]; votes?: Vote[]; rand?: () => number } = {}) {
  const clock = { ms: 50_000 }, store = memoryVotes(opts.votes);
  const room = new Room(() => clock.ms, opts.rand ?? (() => 0.5), { catalog: opts.catalog, votes: store });
  const got: ServerMsg[] = [];
  const ws = { onmessage: (_: Buffer | string) => {}, onclose: () => {}, json: (m: unknown) => got.push(m as ServerMsg), send: (s: string | Buffer) => { if (typeof s === 'string') got.push(JSON.parse(s)); } };
  room.join(ws as unknown as WsConn);
  const send = (m: unknown) => ws.onmessage(JSON.stringify(m));
  const state = () => [...got].reverse().find((m) => m.t === 'state') as RoomState;
  const votes = () => got.filter((m): m is Extract<ServerMsg, { t: 'vote' }> => m.t === 'vote');
  send({ t: 'hello', name: 'owner' });
  return { clock, room, store, send, state, votes, got };
}

test('room: live votes update scores and toast everyone; a live thumbs-down skips at the next boundary', () => {
  const { room, store, send, state, votes } = setup();
  assert.deepEqual(state().presets, ['radial', 'tunnel', 'scope', 'flow']);
  send({ t: 'vote', scene: 'radial', vote: 1 });
  assert.equal(state().scores.radial, 1);
  assert.deepEqual(votes().at(-1), { t: 'vote', scene: 'radial', vote: 1, score: 1, retired: false, host: 'owner' });
  assert.equal(state().scene.id, 'radial', 'a 👍 does not switch');
  const t = room.tickNow();
  send({ t: 'vote', scene: 'radial', vote: -1, quant: 'beat', trans: { type: 'wipe', beats: 1 } });
  const s = state();
  assert.equal(s.scores.radial, 0);
  assert.notEqual(s.scene.id, 'radial');
  assert.equal(s.scene.prev, 'radial');
  assert.equal(s.scene.trans.type, 'core-wipe');
  assert.ok(s.scene.at >= t + INPUT_DELAY && Number.isInteger((s.scene.at - s.grid.origin) / s.grid.tpb), 'on a beat, INPUT_DELAY ahead');
  // recorded as live, with the tick (no features in idle mode)
  const last = store.votes.at(-1)!;
  assert.equal(last.live, true); assert.equal(last.tick, t); assert.equal(last.features, undefined);
  // unknown scenes and bad votes are ignored
  const n = store.votes.length;
  send({ t: 'vote', scene: 'nope', vote: 1 }); send({ t: 'vote', scene: 'radial', vote: 2 });
  assert.equal(store.votes.length, n);
});

test('room: a thumbs-down on a scene not showing does not skip; net -2 retires it from the list', () => {
  const { room, send, state, votes } = setup();
  send({ t: 'vote', scene: 'scope', vote: -1 });
  assert.equal(state().scene.id, 'radial');
  assert.ok(state().presets.includes('scope'));
  assert.equal(room.vote('scope', -1, ['boring', 'bogus'], null)?.retired, true);
  assert.deepEqual(state().presets, ['radial', 'tunnel', 'flow']);
  assert.deepEqual(votes().at(-1), { t: 'vote', scene: 'scope', vote: -1, score: -2, retired: true, host: null });
  // a 👍 brings it back above the line
  room.vote('scope', 1, [], null);
  assert.deepEqual(state().presets, ['radial', 'tunnel', 'scope', 'flow']);
  // retiring the scene that's showing moves on even from the gallery
  room.vote('radial', -1, [], null); room.vote('radial', -1, [], null);
  assert.notEqual(state().scene.id, 'radial');
  assert.ok(!state().presets.includes('radial'));
});

test('room: stored votes load at start; retired scenes stay off; the list is never empty', () => {
  const { state } = setup({ catalog: ['a-x', 'b-y', 'c-z'], votes: [V('a-x', -1), V('a-x', -1), V('b-y', 1)] });
  assert.deepEqual(state().presets, ['b-y', 'c-z']);
  assert.deepEqual(state().scores, { 'a-x': -2, 'b-y': 1 });
  assert.equal(state().scene.id, 'b-y', 'starts on the first live scene');
  const all = setup({ catalog: ['a-x'], votes: [V('a-x', -1), V('a-x', -1)] });
  assert.deepEqual(all.state().presets, ['a-x']);
});

test('room: live votes in file mode record the tick features', () => {
  const { room, store, send, clock } = setup();
  const frames = 4000, feat = new Uint8Array(5 + frames * STRIDE);
  feat[0] = 2; new DataView(feat.buffer).setUint32(1, frames, true);
  for (let i = 0; i < frames; i++) feat[5 + i * STRIDE] = i & 255;
  (room as unknown as { onBinary(c: unknown, m: Buffer): void }).onBinary(null, Buffer.from(feat));
  send({ t: 'play' });
  clock.ms += 10_000;
  const t = room.tickNow();
  send({ t: 'vote', scene: 'radial', vote: 1 });
  const v = store.votes.at(-1)!;
  assert.equal(v.tick, t);
  assert.equal(v.features?.length, STRIDE);
  assert.equal(v.features![0], t & 255);
});

test('room: weighted next never repeats the scene showing and follows the scores', () => {
  let seed = 12345;
  const rand = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
  const { send, state, clock, room } = setup({ rand });
  room.vote('flow', 1, [], null); room.vote('flow', 1, [], null); // flow: weight 4 of 4 + 1 + 1
  let fromOther = 0, toFlow = 0;
  for (let i = 0; i < 400; i++) {
    clock.ms += 20_000;
    const before = sceneAt(state().scene, room.tickNow());
    send({ t: 'scene', weighted: true, quant: 'now' });
    const id = state().scene.id;
    assert.notEqual(id, before);
    if (before !== 'flow') { fromOther++; if (id === 'flow') toFlow++; }
  }
  // from another scene, flow's share is 4 / (4 + 1 + 1) = 2/3
  assert.ok(toFlow / fromOther > 0.55 && toFlow / fromOther < 0.8, `${toFlow}/${fromOther}`);
});

test('room: auto-rotation switches every N bars by weight, and stops when turned off', () => {
  const { room, send, state, clock } = setup({ rand: () => 0.3 });
  send({ t: 'auto', bars: 7 });
  assert.equal(state().auto, null, 'only the offered lengths');
  send({ t: 'auto', bars: 4, trans: { type: 'blend', beats: 1 } });
  assert.deepEqual(state().auto, { bars: 4, trans: { type: 'core-blend', beats: 1 } });
  const barMs = (state().grid.tpb * 4 * 1000) / 60;
  const switches: number[] = [];
  let last = state().scene.at;
  for (let ms = 0; ms < barMs * 13; ms += 250) {
    clock.ms += 250; room.tickAuto();
    if (state().scene.at !== last) { last = state().scene.at; switches.push(last); assert.equal(state().scene.trans.type, 'core-blend'); }
  }
  assert.equal(switches.length, 3, `switches at ${switches}`);
  const bar = state().grid.tpb * 4;
  for (let i = 1; i < switches.length; i++) assert.ok(Math.abs(switches[i] - switches[i - 1] - 4 * bar) <= bar + state().scene.trans.ticks, `${switches}`);
  send({ t: 'auto', bars: 0 });
  const at = state().scene.at;
  for (let i = 0; i < 100; i++) { clock.ms += 250; room.tickAuto(); }
  assert.equal(state().scene.at, at);
});

// host e2e: the hosts' startup outlasted the default rotation's first pick, so the owner's switch queued behind it
test('room: turning auto-rotation off or picking a scene takes back an auto pick that has not started', () => {
  for (const turnOff of [true, false]) {
    const { room, send, state, clock } = setup({ rand: () => 0.3 });
    const start = state().scene.id;
    let ticks = 0;
    while (state().scene.id === start && ticks++ < 10_000) { clock.ms += 250; room.tickAuto(); } // the default rotation picks
    const auto = state().scene;
    assert.notEqual(auto.id, start);
    assert.ok(auto.at >= room.tickNow() + INPUT_DELAY && auto.trans.ticks > 0, 'pending, with a transition');
    if (turnOff) {
      send({ t: 'auto', bars: 0 });
      assert.equal(sceneAt(state().scene, auto.at + auto.trans.ticks), start, 'auto off: the pending pick is gone');
    }
    const other = ['radial', 'tunnel', 'scope', 'flow'].find((id) => id !== start && id !== auto.id)!;
    send({ t: 'scene', id: other, quant: 'bar', trans: { type: 'random', beats: 8 } });
    const s = state().scene, bar = state().grid.tpb * 4;
    assert.equal(s.prev, start);
    assert.deepEqual(s.earlier, [], 'not queued behind the auto pick');
    assert.ok(s.at - room.tickNow() <= bar + INPUT_DELAY, `lands at the next bar (${s.at - room.tickNow()} ticks)`);
  }
  // a pick queued behind an auto switch that is already running stays put when rotation turns off
  const { room, send, state, clock } = setup({ rand: () => 0.3 });
  const start = state().scene.id;
  while (state().scene.id === start) { clock.ms += 250; room.tickAuto(); }
  const auto = state().scene;
  while (room.tickNow() < auto.at + 1) clock.ms += 250;
  send({ t: 'scene', id: start, quant: 'bar' });
  const queued = state().scene;
  assert.equal(queued.earlier.length, 1);
  send({ t: 'auto', bars: 0 });
  assert.deepEqual(state().scene, queued);
});

test('room: transition votes are stored, scored and weight random, without skipping; stored ones load', () => {
  const { room, store, send, state, got } = setup({ rand: () => 0.5, votes: [T('core-melt', -1), T('core-melt', -1)] });
  assert.deepEqual(state().transScores, { 'core-melt': -2 });
  assert.deepEqual(state().scores, {}, 'transition votes are not scene votes');
  const at = state().scene.at;
  send({ t: 'transvote', transition: 'wipe', from: 'radial', to: 'tunnel', beats: 4, vote: -1, tags: ['jarring', 'too busy'] });
  assert.equal(state().scene.at, at, 'no skip');
  const rec = store.votes.at(-1)!;
  assert.deepEqual({ ...rec, at: '', tick: 0 }, { transition: 'core-wipe', from: 'radial', to: 'tunnel', beats: 4, vote: -1, tags: ['jarring'], at: '', live: true, tick: 0 });
  assert.deepEqual(got.filter((m) => m.t === 'transvote').at(-1), { t: 'transvote', transition: 'core-wipe', vote: -1, score: -1, retired: false, host: 'owner' });
  assert.equal(state().transScores['core-wipe'], -1);
  const n = store.votes.length;
  for (const transition of ['nope', 'core-cut', undefined]) send({ t: 'transvote', transition, vote: 1 });
  assert.equal(store.votes.length, n);
  // a retired one never comes out of random (auto-rotation too), but stays selectable by name
  for (let r = 0; r < 1; r += 0.02) {
    const x = setup({ rand: () => r, votes: [T('core-melt', -1), T('core-melt', -1)] });
    x.send({ t: 'scene', step: 1, quant: 'now', trans: { type: 'random', beats: 1 } });
    assert.notEqual(x.state().scene.trans.type, 'core-melt');
  }
  send({ t: 'scene', step: 1, quant: 'now', trans: { type: 'melt', beats: 1 } });
  assert.equal(state().scene.trans.type, 'core-melt');
  assert.equal(room.voteTransition({ transition: 'core-melt' }, 1, [], null)?.retired, false);
});

test('server: POST /vote and GET /scores (token required), votes appended to the file', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'einklang-votes-')), file = join(dir, 'data/votes.jsonl');
  const srv = await startServer({ port: 0, pub: dir, token: 'tk', hosts: ['127.0.0.1'], scenes: ['radial', 'tunnel'], votesFile: file });
  const base = `http://127.0.0.1:${(srv.servers[0].address() as AddressInfo).port}`;
  try {
    assert.equal((await fetch(`${base}/scores`)).status, 401);
    const post = (body: unknown) => fetch(`${base}/vote?t=tk`, { method: 'POST', body: JSON.stringify(body) });
    const r = await post({ scene: 'tunnel', vote: -1, tags: ['boring', 'x'] });
    assert.deepEqual(await r.json(), { score: -1, retired: false });
    assert.equal((await post({ scene: 'nope', vote: 1 })).status, 400);
    assert.equal((await post({ scene: 'tunnel', vote: 0 })).status, 400);
    const { boot, ...listed } = await (await fetch(`${base}/scores?t=tk`)).json();
    assert.equal(typeof boot, 'string');
    assert.deepEqual(listed, { scores: { tunnel: -1 }, live: ['radial', 'tunnel'], transScores: {} });
    const lines = parseVotes(readFileSync(file, 'utf8'));
    assert.deepEqual(lines.map((v) => [v.scene, v.vote, v.tags, v.live]), [['tunnel', -1, ['boring'], undefined]]);
    const tv = await post({ transition: 'core-iris', from: 'radial', to: 'tunnel', beats: 8, vote: 1, tags: ['smooth', 'x'] });
    assert.deepEqual(await tv.json(), { score: 1, retired: false });
    assert.equal((await post({ transition: 'nope', vote: 1 })).status, 400);
    assert.deepEqual((await (await fetch(`${base}/scores?t=tk`)).json()).transScores, { 'core-iris': 1 });
    const t = parseVotes(readFileSync(file, 'utf8')).at(-1)!;
    assert.deepEqual([t.transition, t.scene, t.tags, t.live], ['core-iris', undefined, ['smooth'], undefined]);
    // a restart reads them back
    assert.deepEqual(tally(fileVotes(file).load()).get('tunnel'), { up: 0, down: 1, tags: { boring: 1 } });
  } finally { await srv.close(); }
});

test('server: the catalog is every non-retired lab scene, v1 presets first', () => {
  const ids = labCatalog(join(LAB, 'scenes'));
  assert.deepEqual(ids.slice(0, 4), ['radial', 'tunnel', 'scope', 'flow']);
  for (const g of loadScenes()) assert.equal(ids.includes(g.id), g.status !== 'retired', g.id);
  const dir = mkdtempSync(join(tmpdir(), 'einklang-cat-'));
  writeFileSync(join(dir, 'b.json'), JSON.stringify({ id: 'x-b' })); writeFileSync(join(dir, 'a.json'), JSON.stringify({ id: 'x-a', status: 'retired' }));
  writeFileSync(join(dir, 'c.json'), '{ broken');
  assert.deepEqual(labCatalog(dir), ['x-b']);
});

test('feedback: credit flows to pieces and vendors; net -2 retires', async () => {
  const { reg } = await loadPieces();
  const votes = [V('core-demo', 1, ['great colors']), V('core-demo', 1), V('claude-vox-fleet', -1, ['boring']), V('claude-vox-fleet', -1), V('tunnel', 1)];
  // statuses reset: which real scenes the owner's votes have retired must not matter here
  const scenes = loadScenes().map((g) => ({ ...g, status: 'live' as const }));
  const d = digest(votes, scenes, reg);
  assert.equal(d.votes, 5);
  assert.equal(d.scenes['core-demo'].score, 2);
  assert.equal(d.scenes['claude-vox-fleet'].status, 'retired');
  assert.deepEqual(d.retired, ['claude-vox-fleet']);
  assert.equal(d.scenes.radial.score, 0);
  // core-harmony is in both scenes: +2 - 2
  assert.equal(d.pieces['core-harmony'].score, 0);
  assert.equal(d.pieces['core-harmony'].scenes, 2);
  assert.equal(d.pieces['claude-vox-ship'].score, -2);
  assert.equal(d.pieces['core-plasma'].score, 2);
  assert.equal(d.vendors.claude.scenes.score, -2);
  assert.equal(d.vendors.claude.pieces.score, -2);
  assert.equal(d.vendors.core.scenes.score, 3);
  assert.deepEqual(d.tags, { 'great colors': 1, boring: 1 });
  const md = feedbackMd(d);
  assert.match(md, /## Top scenes[\s\S]*core-demo[\s\S]*## Bottom scenes[\s\S]*claude-vox-fleet/);
  assert.match(md, /claude-vox-ship\*\* -2/);
  assert.match(md, /## Retired\n\n- claude-vox-fleet \(-2\)/);
  assert.equal(RETIRE_AT, -2);
});

test('feedback: transitions are scored, credited to vendors and listed', async () => {
  const { reg } = await loadPieces();
  const ctx = { from: 'radial', to: 'tunnel', beats: 4 };
  const votes = [T('core-blend', 1, ['smooth'], ctx), T('core-blend', 1, [], { ...ctx, live: true }), T('core-melt', -1, ['too slow'], ctx), T('core-melt', -1), V('radial', 1, ['calm']), T('gone-effect', 1)];
  const d = digest(votes, loadScenes(), reg, transitions());
  assert.equal(d.votes, 6);
  assert.deepEqual(d.transitions['core-blend'], { up: 2, down: 0, score: 2, tags: { smooth: 1 }, name: 'blend', vendor: 'core', live: 1, status: 'live', contexts: [{ ...ctx, up: 2, down: 0 }] });
  assert.equal(d.transitions['core-melt'].status, 'retired');
  assert.equal(d.transitions['core-cut'], undefined);
  assert.equal(d.transitions['gone-effect'], undefined);
  assert.equal(d.vendors.core.transitions.score, 0);
  assert.equal(d.vendors.core.scenes.score, 1);
  assert.deepEqual(d.transitionTags, { smooth: 1, 'too slow': 1 });
  assert.deepEqual(d.tags, { calm: 1 });
  assert.deepEqual(d.retired, [], 'only scenes get retired in files');
  const md = feedbackMd(d);
  assert.match(md, /## Top transitions[\s\S]*core-blend[\s\S]*radial→tunnel @4[\s\S]*## Bottom transitions[\s\S]*core-melt/);
  assert.match(md, /\| core \| \+1 \(1↑ 0↓\) \|.*\| 0 \(2↑ 2↓\) \|/);
  assert.match(md, /## Transition reason tags\n\n(smooth ×1, too slow ×1)/);
  assert.match(md, /## Retired transitions\n\n- core-melt \(-2\)/);
  assert.match(feedbackMd(digest([], loadScenes(), reg, transitions())), /## Top transitions\n\nNo votes yet\./);
});
