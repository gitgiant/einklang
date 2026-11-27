// Evolving scenes: pools, the deterministic weighted walk, params, the scene hash, validation, votes,
// the digest and freeze.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { WsConn } from '../src/server/ws.ts';
import '../src/server/transitions.ts'; // installs the transition registry
import { loadPieces, loadScenes } from '../scripts/lab/load.ts';
import { validateScene } from '../src/core/graph/validate.ts';
import { compile, evalCpu, strHash } from '../src/core/graph/eval.ts';
import {
  EPOCH, applyChoices, drawParams, evolveStep, fitError, freezeScene, resolveEvolve, scoresFromDigest, stateAt, stateGraph, stateInfo, stateKey, withEvolve,
  type EvolveScores, type ResolvedEvolve,
} from '../src/core/graph/evolve.ts';
import { sceneCpu } from '../src/core/graph/scenecpu.ts';
import { forceAll, sectionIds } from '../src/core/graph/sections.ts';
import type { SceneGraph } from '../src/core/graph/types.ts';
import { demoSource } from '../src/core/demo.ts';
import { silence } from '../src/core/features.ts';
import { BAR_TICKS, sectionAt } from '../src/core/songform.ts';
import { hashState } from '../src/core/scene.ts';
import { cleanEvolve, type Vote } from '../src/core/votes.ts';
import { digest, feedbackMd } from '../scripts/lab/feedback.ts';
import { Room, memoryVotes } from '../src/server/room.ts';

const { reg } = await loadPieces();
const raw = loadScenes();
const scenes = loadScenes(undefined, reg);
const byId = (id: string) => structuredClone(scenes.find((s) => s.id === id)!);
const hashOf = (u: Int32Array) => hashState({ u, prims: null });
const D = demoSource();

/** A small evolving scene over cheap auto-shader pieces. */
function evo(extra: Partial<SceneGraph> = {}): SceneGraph {
  return {
    format: 1, id: 'core-test-evolve', name: 'test', version: 1, author: { vendor: 'core' },
    nodes: [
      { id: 'audio', piece: 'core-audio' },
      { id: 'pal', piece: 'core-harmony' },
      { id: 'gen', piece: 'core-plasma', bind: { speed: { from: 'audio.bass' } } },
      { id: 'fx', piece: 'core-kaleido', params: { segments: 6 } },
    ],
    edges: [{ from: 'pal.palette', to: 'gen.palette' }, { from: 'gen.out', to: 'fx.in' }],
    out: 'fx.out',
    evolve: {
      every: 'bar',
      slots: [
        { node: 'gen', pool: ['core-bars', 'codex-grid-floor', { piece: 'codex-starfield', ranges: { speed: [0.5, 1.5], warp: [0, 1] } }] },
        { node: 'fx', pool: [{ piece: 'core-kaleido', ranges: { segments: [3, 12] } }, 'core-pixelate', 'core-trails'], jitter: 0 },
      ],
    },
    ...extra,
  };
}
const resolved = (g: SceneGraph, s?: EvolveScores) => resolveEvolve(g, reg, s);

test('evolve: the shipped scenes validate, and their pools resolve within the caps', () => {
  for (const id of ['core-evolve-garden', 'core-evolve-circuit']) {
    const g = byId(id);
    assert.ok(g.evolve && g.evolved, id);
    assert.deepEqual(validateScene(g, reg), [], id);
    for (const s of g.evolved!.slots) {
      assert.ok(s.cands.length >= 2 && s.cands.length <= 6, `${id} ${s.node}: ${s.cands.length}`);
      for (const c of s.cands.slice(1)) assert.equal(fitError(g, s.node, reg.get(c.piece), reg), null);
    }
  }
  // the filter: generators tagged synthwave / space / terrain, at most 5 with the base
  const circuit = byId('core-evolve-circuit').evolved!;
  assert.equal(circuit.slots[0].cands[0].piece, 'codex-grid-floor');
  assert.ok(circuit.slots[0].cands.length <= 5);
  for (const c of circuit.slots[1].cands) assert.ok(['retro', 'glitch'].some((t) => reg.get(c.piece)!.manifest.tags!.includes(t)), c.piece);
  assert.deepEqual(validateScene(evo(), reg), []);
});

test('evolve: validation catches misfits, empty pools, bad ranges and sections + evolve', () => {
  const bad = (patch: (g: SceneGraph) => void, re: RegExp) => {
    const g = evo(); patch(g);
    const errs = validateScene(g, reg);
    assert.ok(errs.some((e) => re.test(e)), `${re}: ${errs.join(' | ')}`);
  };
  bad((g) => { g.evolve!.slots[1].pool = ['core-bars']; }, /core-bars doesn't fit: no tex input in/);
  bad((g) => { g.evolve!.slots[0].pool = ['core-kaleido']; }, /core-kaleido doesn't fit: input in would not be connected/);
  bad((g) => { g.evolve!.slots[0].pool = undefined; g.evolve!.slots[0].filter = { tags: ['no-such-tag'] }; }, /slot gen: the pool is empty/);
  bad((g) => { g.evolve!.slots[1].pool = [{ piece: 'core-kaleido', ranges: { segments: [1, 40] } }]; }, /range segments must be \[lo, hi\] within \[2, 24\]/);
  bad((g) => { g.evolve!.slots.push({ node: 'nope', pool: ['core-bars'] }); }, /slot nope: no such node/);
  bad((g) => { g.evolve!.slots[0].max = 9; }, /max must be 2\.\.6/);
  bad((g) => { g.evolve!.every = 'week' as never; }, /every must be/);
  bad((g) => { g.sections = { variants: [{ id: 'x', when: { cue: 1 } }] }; }, /sections or evolve, not both/);
  bad((g) => { g.nodes.push({ id: 'dead', piece: 'core-plasma' }); g.evolve!.slots[0].node = 'dead'; }, /slot dead: not on the way to out/);
});

test('evolve: a candidate keeps the slot\'s edges it can take; CPU ones it lacks drop; bindings carry by name', () => {
  const g = evo(), ev = resolved(g);
  // core-bars: palette yes, no speed param (the binding drops)
  const bars = applyChoices(g, ev, [{ c: 1, params: {} }, { c: 0, params: { segments: 6 } }], reg);
  assert.deepEqual(bars.nodes.find((n) => n.id === 'gen'), { id: 'gen', piece: 'core-bars' });
  assert.ok(bars.edges.some((e) => e.to === 'gen.palette'));
  assert.deepEqual(validateScene(bars, reg), []);
  // starfield has speed: the base's binding carries over
  const star = applyChoices(g, ev, [{ c: 3, params: { speed: 1 } }, { c: 0, params: {} }], reg);
  assert.deepEqual(star.nodes.find((n) => n.id === 'gen')!.bind, { speed: { from: 'audio.bass' } });
  // codex-cymatics has no palette input: the palette edge drops
  const cym = evo(); cym.evolve!.slots[0].pool = ['codex-cymatics'];
  const cg = applyChoices(cym, resolved(cym), [{ c: 1, params: {} }, { c: 0, params: {} }], reg);
  assert.ok(!cg.edges.some((e) => e.to === 'gen.palette'));
  assert.deepEqual(validateScene(cg, reg), []);
});

test('evolve: the walk is a pure function of the scene id and step; one slot swaps per step, never to itself', () => {
  const g = evo(), ev = resolved(g), id = strHash(g.id);
  const a = Array.from({ length: 300 }, (_, k) => stateAt(ev, id, k));
  const b = Array.from({ length: 300 }, (_, k) => stateAt(resolved(evo()), id, k));
  assert.deepEqual(a, b, 'same inputs, same states');
  assert.deepEqual(a[0].pick, [0, 0], 'step 0 is the base graph');
  assert.deepEqual(a[0].seeds, [0, 0]);
  for (let k = 1; k < 300; k++) {
    const changed = a[k].pick.map((p, i) => p !== a[k - 1].pick[i] || a[k].seeds[i] !== a[k - 1].seeds[i]);
    if (k % EPOCH === 0) continue; // a fresh draw
    assert.equal(changed.filter(Boolean).length, 1, `step ${k}: exactly one slot moves`);
    const i = changed.indexOf(true);
    assert.notEqual(a[k].pick[i], a[k - 1].pick[i], `step ${k}: the swap brings another candidate`);
    assert.equal(a[k].seeds[i], k);
  }
  // the slots take turns
  const moved = a.slice(1, 9).map((s, k) => s.pick.findIndex((p, i) => s.seeds[i] === k + 1));
  assert.ok(moved.includes(0) && moved.includes(1));
  // another scene id walks differently
  const other = Array.from({ length: 40 }, (_, k) => stateAt(ev, strHash('core-test-other'), k).pick.join());
  assert.notDeepEqual(other, a.slice(0, 40).map((s) => s.pick.join()));
  // a late step costs at most EPOCH small steps and matches however it was reached
  assert.deepEqual(stateAt(ev, id, 1e6 + 5), stateAt(resolved(evo()), id, 1e6 + 5));
});

test('evolve: candidates are weighted by piece + slot scores (2^score); at -2 one leaves the pool', () => {
  const g = evo(), id = strHash(g.id);
  const freq = (ev: ResolvedEvolve) => {
    const n = new Map<string, number>();
    for (let k = 1; k < 4000; k++) { const s = stateAt(ev, id, k); if (s.seeds[0] === k) { const p = ev.slots[0].cands[s.pick[0]].piece; n.set(p, (n.get(p) ?? 0) + 1); } }
    return n;
  };
  const even = freq(resolved(g));
  const liked = freq(resolved(g, { pieces: { 'core-bars': 3 } }));
  // weight 8 vs 1: core-bars comes in far more often than without the vote (excluded only while it shows)
  assert.ok(liked.get('core-bars')! > 1.5 * even.get('core-bars')!, `${liked.get('core-bars')} vs ${even.get('core-bars')}`);
  // per-slot scores (from votes on this scene) add to the piece score
  const slot = freq(resolved(g, { pieces: {}, slots: { [g.id]: { gen: { 'codex-grid-floor': 3 } } } }));
  assert.ok(slot.get('codex-grid-floor')! > 1.5 * even.get('codex-grid-floor')!);
  const gone = freq(resolved(g, { pieces: { 'core-bars': -2 } }));
  assert.equal(gone.get('core-bars') ?? 0, 0);
  const ev = resolved(g, { pieces: { 'core-bars': -2 } });
  assert.equal(ev.slots[0].cands[1].weight, 0);
  // the scores in effect join the hash
  assert.notEqual(ev.scoresHash, resolved(g).scoresHash);
  // scores come from the digest
  assert.deepEqual(scoresFromDigest({ pieces: { 'core-bars': { score: 2 } }, evolve: { [g.id]: { slots: { gen: { 'core-bars': { score: -1 } } }, states: {} } } }),
    { pieces: { 'core-bars': 2 }, slots: { [g.id]: { gen: { 'core-bars': -1 } } } });
  assert.deepEqual(scoresFromDigest(undefined), { pieces: {}, slots: {} });
});

test('evolve: params: as written at step 0, ranges drawn (ints whole), other floats jittered within bounds', () => {
  const g = evo(), ev = resolved(g), id = strHash(g.id);
  assert.deepEqual(drawParams(ev, 1, 0, 0, id, reg), { segments: 6 });
  const seen = new Set<number>();
  for (let seed = 1; seed < 200; seed++) {
    const p = drawParams(ev, 0, 3, seed, id, reg);
    assert.ok((p.speed as number) >= 0.5 && (p.speed as number) <= 1.5 && (p.warp as number) >= 0 && (p.warp as number) <= 1);
    const spec = reg.get('codex-starfield')!.manifest.params!.glow;
    assert.ok((p.glow as number) >= spec.min! && (p.glow as number) <= spec.max!, 'jittered within the param bounds');
    assert.ok(Math.abs((p.glow as number) - (spec.default as number)) <= 0.08 * (spec.max! - spec.min!) + 1e-9);
    const k = drawParams(ev, 1, 1, seed, id, reg).segments as number;
    assert.ok(Number.isInteger(k) && k >= 3 && k <= 12);
    seen.add(k);
    assert.deepEqual(drawParams(ev, 0, 3, seed, id, reg), p, 'pure');
  }
  assert.ok(seen.size > 6, 'ranges are covered');
  // jitter 0 on the fx slot: a candidate without ranges keeps its params
  assert.deepEqual(drawParams(ev, 1, 2, 5, id, reg), {});
});

test('evolve: the scene hash follows the step, is the same on every host, and blends at the boundary', () => {
  const g = withEvolve(evo(), reg), A = sceneCpu(g, reg), B = sceneCpu(structuredClone(g), reg);
  const ev = g.evolved!, id = strHash(g.id);
  for (let t = 0; t < 6 * BAR_TICKS; t += 7) {
    const a = A.state(t, D), b = B.state(t, D);
    assert.equal(hashOf(a.hash), hashOf(b.hash), `tick ${t}`);
    assert.equal(a.evolve!.step.k, Math.floor(t / BAR_TICKS));
    assert.deepEqual(a.evolve!.pick, stateAt(ev, id, a.evolve!.step.k).pick);
  }
  // step 0 = the base graph's own hash at the front
  const base = evalCpu(compile({ ...evo(), evolve: undefined }, reg), 10, D);
  assert.deepEqual([...A.state(10, D).hash.slice(0, base.hash.length)], [...base.hash]);
  // a swap blends in over the first beats of the bar (core-blend, 4 beats clamped to half the bar)
  const at = 3 * BAR_TICKS, s = A.state(at + 5, D);
  assert.ok(s.trans && s.prev && s.evolve!.step.prev === 2, 'blending from step 2');
  assert.notDeepEqual(s.evolve!.pick, s.evolve!.prevPick);
  assert.ok(A.state(at + BAR_TICKS / 2 - 1, D).trans);
  assert.equal(A.state(at + BAR_TICKS / 2, D).trans, null, 'done by the middle of the bar');
  // different scores, different hash
  const C = sceneCpu(withEvolve(evo(), reg, { pieces: { 'core-bars': 4 } }), reg);
  assert.notEqual(hashOf(C.state(5, D).hash), hashOf(A.state(5, D).hash));
  // the CPU frame of a step is its state graph's
  const k = 4, sg = compile(stateGraph(g, ev, stateAt(ev, id, k), id, reg), reg);
  assert.deepEqual([...A.state(k * BAR_TICKS + 100, D).cur.hash], [...evalCpu(sg, k * BAR_TICKS + 100, D).hash]);
  // every candidate's node for the GPU side, the base node first
  assert.deepEqual(A.evolve!.sockets.map((x) => x.cands.map((c) => c.node.piece)), ev.slots.map((x) => x.cands.map((c) => c.piece)));
  assert.equal(A.evolve!.sockets[1].cands[2].def.manifest.id, 'core-pixelate');
});

test('evolve: every "section" steps on song-section changes, and at least every `most` phrases', () => {
  const g = withEvolve(evo(), reg);
  g.evolve!.every = 'section'; g.evolve!.most = 4;
  const ev = resolveEvolve(g, reg), id = strHash(g.id), unit = 4 * BAR_TICKS;
  assert.equal(ev.unit, unit);
  let last = 0;
  for (let p = 1; p < 40; p++) {
    const k = evolveStep(ev, p * unit + 3, D, id).k;
    const change = sectionAt(D, p * unit) !== sectionAt(D, (p - 1) * unit);
    if (change) assert.equal(k, p, `phrase ${p}: a section change steps`);
    else assert.ok(k === last || k === p && p % 4 === 0, `phrase ${p}: k ${k}, last ${last}`);
    assert.ok(k >= last && p - k < 4, 'monotone, never more than `most` phrases old');
    last = k;
  }
  // silence: no changes, so only the floor of `most` phrases
  assert.equal(evolveStep(ev, 9 * unit + 1, silence, id).k, 8);
});

test('evolve: the lab forces s0..s3 in turn', () => {
  const g = withEvolve(evo(), reg), cpu = sceneCpu(g, reg);
  assert.deepEqual(sectionIds(g), ['s0', 's1', 's2', 's3']);
  const plan = forceAll(g, 600, 480);
  cpu.force(plan);
  assert.deepEqual([600, 721, 841, 961, 1079].map((t) => cpu.state(t, D).evolve!.step.k), [0, 1, 2, 3, 3]);
  assert.ok(cpu.state(722, D).trans, 'forced steps blend in too');
  cpu.force(null);
  assert.equal(cpu.state(5 * BAR_TICKS, D).evolve!.step.k, 5);
});

test('evolve: votes record the state on screen; the digest scores mutations and credits the pieces seen', () => {
  const g = withEvolve(evo(), reg), ev = g.evolved!, id = strHash(g.id);
  const info = (k: number) => stateInfo(ev, stateAt(ev, id, k), id, reg);
  const i1 = info(1), i2 = info(2);
  assert.equal(i1.key, stateKey(ev, stateAt(ev, id, 1).pick));
  assert.match(i1.key, /^gen=[a-z0-9-]+(#\d)?,fx=[a-z0-9-]+(#\d)?$/);
  // the server keeps a clean copy
  assert.deepEqual(cleanEvolve(JSON.parse(JSON.stringify(i1))), i1);
  assert.equal(cleanEvolve({ step: -1, key: 'x', slots: {} }), undefined);
  assert.equal(cleanEvolve({ step: 1, key: 'x', slots: { gen: { piece: '../evil' } } }), undefined);
  assert.deepEqual(cleanEvolve({ step: 1, key: 'k', slots: { gen: { piece: 'core-bars', params: { a: 1, b: { x: 1 }, 'B C': 2 } } } })?.slots, { gen: { piece: 'core-bars', params: { a: 1 } } });
  const store = memoryVotes(), room = new Room(() => 50_000, () => 0.5, { catalog: [g.id], votes: store });
  room.join({ onmessage: () => {}, onclose: () => {}, json: () => {}, send: () => {} } as unknown as WsConn);
  room.vote(g.id, 1, ['great motion'], null, undefined, i1);
  room.vote(g.id, 1, [], null, undefined, { ...i1, slots: { gen: { piece: 'bad id!' } } });
  assert.deepEqual((store.votes[0] as { evolve?: unknown }).evolve, i1);
  assert.equal((store.votes[1] as { evolve?: unknown }).evolve, undefined, 'a malformed state is dropped, the vote kept');

  const at = '2026-11-27T00:00:00.000Z';
  const votes: Vote[] = [
    { scene: g.id, vote: 1, tags: ['great motion'], at, evolve: i1 },
    { scene: g.id, vote: 1, tags: [], at, evolve: i1 },
    { scene: g.id, vote: -1, tags: ['boring'], at, evolve: i2 },
  ];
  const d = digest(votes, [g], reg), e = d.evolve[g.id];
  assert.equal(e.states[i1.key].score, 2);
  assert.deepEqual(e.states[i1.key].slots, i1.slots);
  assert.equal(e.states[i2.key].score, -1);
  const g1 = i1.slots.gen.piece, g2 = i2.slots.gen.piece;
  if (g1 !== g2) {
    assert.equal(e.slots.gen[g1].score, 2);
    // the pieces on screen get the credit, not the slot's base piece
    assert.equal(d.pieces[g1].score, 2);
  }
  assert.equal(d.pieces['core-harmony'].score, 1, 'the rest of the graph: every vote');
  const md = feedbackMd(d);
  assert.match(md, /## Evolving scenes[\s\S]*### Liked mutations[\s\S]*core-test-evolve \| `gen=/);
  assert.match(md, /### Disliked mutations[\s\S]*boring/);
  // fed back: the slot scores weight the pool
  const back = scoresFromDigest(JSON.parse(JSON.stringify(d)));
  assert.equal(back.slots![g.id].gen[g1], g1 === g2 ? 1 : 2);
});

test('evolve: freeze writes a liked state as a child scene with parent', () => {
  const g = raw.find((s) => s.id === 'core-evolve-garden')!, styled = byId('core-evolve-garden'), ev = styled.evolved!, id = strHash(g.id);
  const info = stateInfo(ev, stateAt(ev, id, 7), id, reg);
  const child = freezeScene(g, reg, info, { id: 'core-evolve-garden-ftest', created: '2026-11-27' });
  assert.equal(child.parent, 'core-evolve-garden');
  assert.equal(child.evolve, undefined);
  assert.equal(child.version, 1);
  for (const [node, x] of Object.entries(info.slots)) {
    const n = child.nodes.find((m) => m.id === node)!;
    assert.equal(n.piece, x.piece);
    assert.deepEqual(n.params ?? {}, x.params);
  }
  assert.deepEqual(validateScene(child, reg), []);
  // its CPU frame matches the evolving scene's at that step
  const sg = compile(stateGraph(styled, ev, stateAt(ev, id, 7), id, reg), reg), cg = compile(child, reg);
  assert.deepEqual(cg.order.map((p) => [p.node.id, p.node.piece, p.node.params]), sg.order.map((p) => [p.node.id, p.node.piece, p.node.params]));
  assert.throws(() => freezeScene(g, reg, { slots: { gen: { piece: 'core-bars', params: {} } } }, { id: 'x-y', created: '' }), /no candidate core-bars/);
});
