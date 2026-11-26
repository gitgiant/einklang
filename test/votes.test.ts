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
import { RETIRE_AT, cleanTags, parseVotes, pickWeighted, tally, weight, type Vote } from '../src/core/votes.ts';
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
    assert.deepEqual(await (await fetch(`${base}/scores?t=tk`)).json(), { scores: { tunnel: -1 }, live: ['radial', 'tunnel'] });
    const lines = parseVotes(readFileSync(file, 'utf8'));
    assert.deepEqual(lines.map((v) => [v.scene, v.vote, v.tags, v.live]), [['tunnel', -1, ['boring'], undefined]]);
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
  const scenes = loadScenes();
  const votes = [V('core-demo', 1, ['great colors']), V('core-demo', 1), V('claude-vox-fleet', -1, ['boring']), V('claude-vox-fleet', -1), V('tunnel', 1)];
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
