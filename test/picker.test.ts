import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../src/server/transitions.ts';
import { facets, filterScenes, sceneTags, stepChoice, type SceneFilter, type SceneItem } from '../src/web/pickerlist.ts';
import { change, cycleSched, cycleTicks, holdAt, pickScene, transTicks, type Cycle, type Run, type Settings } from '../src/web/cycle.ts';
import { galleryRot } from '../src/web/defaults.ts';
import type { SceneGraph } from '../src/core/graph/types.ts';

const item = (id: string, name: string, vendor: string, tags: string[], created: string, score: number): SceneItem => ({ id, name, vendor, tags, created, score });
const ITEMS = [
  item('claude-media-tube', 'Tube', 'claude', ['3d', 'media'], '2026-11-27', 1),
  item('agy-rain', 'Rain code', 'agy', ['pixel'], '2026-11-25', 3),
  item('core-evolve', 'Garden', 'core', ['evolve', 'organic'], '2026-11-26', 0),
  item('claude-pico', 'Arcade', 'claude', ['media', 'pixel'], '', -1),
];
const ids = (f: Partial<SceneFilter>) => filterScenes(ITEMS, { query: '', vendors: new Set(), tags: new Set(), sort: 'name', ...f }).map((i) => i.id);

test('picker: sorts by name, score and newest', () => {
  assert.deepEqual(ids({}), ['claude-pico', 'core-evolve', 'agy-rain', 'claude-media-tube']);
  assert.deepEqual(ids({ sort: 'score' }), ['agy-rain', 'claude-media-tube', 'core-evolve', 'claude-pico']);
  assert.deepEqual(ids({ sort: 'newest' }), ['claude-media-tube', 'core-evolve', 'agy-rain', 'claude-pico']);
});

test('picker: search words and chips narrow the list', () => {
  assert.deepEqual(ids({ query: '  RAIN ' }), ['agy-rain']);
  assert.deepEqual(ids({ query: 'claude media tube' }), ['claude-media-tube']);
  assert.deepEqual(ids({ query: 'organic' }), ['core-evolve']);
  assert.deepEqual(ids({ query: 'nothing' }), []);
  assert.deepEqual(ids({ vendors: new Set(['agy', 'core']) }), ['core-evolve', 'agy-rain']);
  assert.deepEqual(ids({ tags: new Set(['media', 'pixel']) }), ['claude-pico']);
  assert.deepEqual(ids({ vendors: new Set(['claude']), tags: new Set(['3d']), query: 'tube' }), ['claude-media-tube']);
});

test('picker: chips list vendors, the main tags first, rare other tags left out', () => {
  assert.deepEqual(facets(ITEMS, 2), { vendors: ['agy', 'claude', 'core'], tags: ['media', 'evolve', 'pixel'] });
  assert.deepEqual(facets(ITEMS, 1).tags, ['media', 'evolve', 'pixel', '3d', 'organic']);
});

test('picker: scene tags come from pieces, sections, evolve and the id', () => {
  const g = { id: 'agy-vaporwave-acts', style: 'claude-pico8', nodes: [{ id: 'a', piece: 'p' }], sections: { variants: [{ id: 'drop', nodes: [{ id: 'b', piece: 'q' }] }] } } as unknown as SceneGraph;
  assert.deepEqual(sceneTags(g, (p) => (p === 'p' ? ['core', 'retro'] : ['glitch'])), ['glitch', 'retro', 'sections', 'vapor']);
});

test('picker: prev / next steps through a list and wraps', () => {
  assert.equal(stepChoice(['random', 'a', 'b'], 'b', 1), 'random');
  assert.equal(stepChoice(['random', 'a', 'b'], 'random', -1), 'b');
  assert.equal(stepChoice(['random', 'a', 'b'], 'all', 1), 'a');
});

test('rotation: weighted skips retired and the current scene, liked picks liked ones', () => {
  const s = ['a', 'b', 'c', 'd'], scores = { b: 2, c: -2, d: 1 };
  for (let n = 0; n < 200; n++) {
    assert.ok([1, 3].includes(pickScene('weighted', s, scores, 0, n)));
    assert.ok([1, 3].includes(pickScene('liked', s, scores, 0, n)));
    assert.equal(pickScene('liked', s, scores, 1, n), 3);
    assert.notEqual(pickScene('liked', s, {}, 2, n), 2); // none liked: any other
  }
  assert.equal(pickScene('liked', s, { c: 1 }, 2, 5), 2);
});

test('rotation: the URL decides, stills keep list order', () => {
  const r = (q: string) => galleryRot(new URLSearchParams(q));
  assert.equal(r(''), 'weighted');
  assert.equal(r('trans=off'), 'stay');
  assert.equal(r('stop=3'), 'stay');
  assert.equal(r('stop=3&trans=random'), 'order');
  assert.equal(r('rot=liked'), 'liked');
  assert.equal(r('rot=bogus'), 'weighted');
});

const SCENES = ['a', 'b', 'c', 'd', 'e'];
const deck = () => {
  const scores: Record<string, number> = {};
  const of = (s: Settings): Cycle => ({
    ids: SCENES, trans: s.trans, beats: s.beats, hold: s.hold, stay: s.rot === 'stay',
    pick: s.rot === 'weighted' || s.rot === 'liked' ? (prev, n) => pickScene(s.rot as 'weighted', SCENES, scores, prev, n, 7) : undefined,
  });
  const run: Run = { s: { rot: 'weighted', trans: 'random', beats: 8 }, anchor: holdAt(1000, 0, 8), pending: null };
  /** What the gallery draws at `tick`, applying pending settings as it does. */
  const at = (r: Run, tick: number) => {
    const now: Run = r.pending && tick >= r.pending.from ? { s: r.pending.s, anchor: r.pending.anchor, pending: null } : r;
    return { run: now, sched: cycleSched(of(now.s), now.anchor, tick) };
  };
  return { scores, of, run, at };
};
const same = (x: ReturnType<typeof cycleSched>) => [x.id, x.prev, x.at, x.trans.type, x.trans.ticks];

test('rotation: new scores never change a scene already shown', () => {
  const d = deck(), len = cycleTicks(8), tick = d.run.anchor.at + 3 * len + 5;
  const before = d.at(d.run, tick).sched;
  Object.assign(d.scores, { a: 4, b: -2, c: 4, d: -2 });
  assert.deepEqual(same(d.at(d.run, tick).sched), same(before));
  assert.equal(d.at(d.run, tick + len).sched.prev, before.id);
});

test('settings: a new effect waits for the next switch', () => {
  const d = deck(), len = cycleTicks(8), tick = d.run.anchor.at + len + 5;
  const before = d.at(d.run, tick).sched, next = change(d.of, d.run, { trans: 'core-flash' }, tick);
  assert.deepEqual(same(d.at(next, tick).sched), same(before));
  const after = d.at(next, next.pending!.from).sched;
  assert.deepEqual([after.prev, after.trans.type, after.at], [before.id, 'core-flash', d.run.anchor.at + 2 * len]);
});

test('settings: stay stops after the running switch; leaving it holds the scene, then moves on', () => {
  const d = deck(), len = cycleTicks(8), tick = d.run.anchor.at + len + 5;
  const before = d.at(d.run, tick).sched;
  const stay = change(d.of, d.run, { rot: 'stay' }, tick);
  assert.deepEqual(same(d.at(stay, tick).sched), same(before));
  const later = d.at(stay, tick + 20 * len);
  assert.equal(later.sched.id, before.id);
  assert.ok(later.sched.at + transTicks(8) <= tick + 20 * len);
  const t = tick + 20 * len + 1, go = change(d.of, later.run, { rot: 'order' }, t);
  const held = d.at(go, t);
  assert.equal(held.sched.id, before.id);
  assert.ok(held.sched.at + held.sched.trans.ticks <= t);
  const moved = d.at(held.run, t + cycleTicks(8)).sched;
  assert.deepEqual([moved.prev, moved.id], [before.id, SCENES[(SCENES.indexOf(before.id) + 1) % SCENES.length]]);
});
