// Scene sections (acts), the song-structure classifier, and the switch / mix / modulator pieces.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../src/server/transitions.ts'; // installs the transition registry
import { loadPieces, loadScenes } from '../scripts/lab/load.ts';
import { validateScene } from '../src/core/graph/validate.ts';
import { compile, evalCpu } from '../src/core/graph/eval.ts';
import { applySection, forceAll, pickAt, sectionGraphs, sectionStep, unitTicks } from '../src/core/graph/sections.ts';
import { sceneCpu } from '../src/core/graph/scenecpu.ts';
import type { SceneGraph } from '../src/core/graph/types.ts';
import { demoSource, sectionAt as demoTruth } from '../src/core/demo.ts';
import { fixtureSource } from '../src/core/fixtures.ts';
import { silence, type FeatureSource } from '../src/core/features.ts';
import { EventLog, withEvents } from '../src/core/events.ts';
import { BAR_TICKS, SONG_SECTIONS, sectionAt } from '../src/core/songform.ts';
import { hashState } from '../src/core/scene.ts';
import { transEffects } from '../src/core/transitions.ts';
import { applyStyle } from '../src/core/graph/style.ts';
import { loadStyles } from '../scripts/lab/load.ts';
import { K_CUE, K_NOTE } from '../src/core/constants.ts';

const { reg } = await loadPieces();
const scenes = loadScenes(undefined, reg);
const byId = (id: string) => structuredClone(scenes.find((s) => s.id === id)!);
const hashOf = (u: Int32Array) => hashState({ u, prims: null });
const D = demoSource();

/** A small scene with sections over plasma (CPU-only checks need no GPU). */
function acts(): SceneGraph {
  return {
    format: 1, id: 'core-test-acts', name: 'test', version: 1, author: { vendor: 'core' },
    nodes: [
      { id: 'audio', piece: 'core-audio' },
      { id: 'pal', piece: 'core-harmony' },
      { id: 'gen', piece: 'core-plasma', params: { gain: 0.5 } },
      { id: 'fx', piece: 'core-trails' },
    ],
    edges: [{ from: 'pal.palette', to: 'gen.palette' }, { from: 'gen.out', to: 'fx.in' }],
    out: 'fx.out',
    sections: {
      on: 'bar', transition: 'core-blend', beats: 2,
      variants: [
        { id: 'drop', when: { section: 'drop' }, params: { gen: { gain: 1.2 } }, post: { bloom: 0.9 } },
        { id: 'hot', when: { signal: 'audio.bass', above: 2 }, nodes: [{ id: 'kal', piece: 'core-kaleido' }],
          edges: [{ from: 'gen.out', to: 'kal.in' }, { from: 'kal.out', to: 'fx.in' }] },
      ],
    },
  };
}

test('songform: the demo track reads as its sections (drop and breakdown on the bar, overall >= 70%)', () => {
  let ok = 0;
  for (let bar = 1; bar < 64; bar++) {
    const got = SONG_SECTIONS[sectionAt(D, bar * BAR_TICKS)], truth = demoTruth(bar * BAR_TICKS - 1);
    if (got === truth) ok++;
    // the bar before the boundary decides: a drop bar reads as a drop, a breakdown bar as a breakdown
    if (truth === 'breakdown' || (truth === 'drop' && bar % 32 !== 16)) assert.equal(got, truth, `bar ${bar}`);
  }
  assert.ok(ok / 63 >= 0.7, `match ${ok / 63}`);
  const T = fixtureSource('techno'), Q = fixtureSource('quiet'), S = silence;
  for (let b = 8; b < 40; b++) {
    assert.equal(SONG_SECTIONS[sectionAt(T, b * BAR_TICKS)], 'drop');
    assert.notEqual(SONG_SECTIONS[sectionAt(Q, b * BAR_TICKS)], 'drop');
    assert.equal(SONG_SECTIONS[sectionAt(S, b * BAR_TICKS)], 'intro');
  }
});

test('applySection: params, bind (null drops), add / replace / remove nodes, rewire, unwire, out, post', () => {
  const g = byId('core-acts-surge'), drop = applySection(g, g.sections!.variants.find((v) => v.id === 'drop')!);
  assert.ok(!drop.nodes.some((n) => n.id === 'blobs'), 'removed');
  assert.ok(!drop.edges.some((e) => e.from.startsWith('blobs.') || e.to.startsWith('blobs.')), 'its edges too');
  assert.equal(drop.nodes.find((n) => n.id === 'pal')!.params!.colors, '#120004 #5c0a12 #c41f1a #ff6b1a #ffc23d #fff4c2', 'replaced');
  assert.deepEqual(drop.edges.filter((e) => e.to === 'goo.in'), [{ from: 'tear.out', to: 'goo.in' }], 'goo.in re-fed, old edge gone');
  assert.equal(drop.nodes.find((n) => n.id === 'goo')!.params!.decay, 0.55);
  assert.equal(drop.post!.bloom, 0.85); assert.equal(drop.post!.threshold, 0.6);
  assert.equal(drop.sections, undefined);
  const sb = byId('core-acts-switchboard'), loud = applySection(sb, sb.sections!.variants.find((v) => v.id === 'loud')!);
  assert.equal(loud.nodes.find((n) => n.id === 'xf')!.bind, undefined, 'bind null drops the binding');
  const g2 = acts();
  const un = applySection(g2, { id: 'x', when: { cue: 1 }, unwire: ['gen.palette'], out: 'gen.out' });
  assert.ok(!un.edges.some((e) => e.to === 'gen.palette')); assert.equal(un.out, 'gen.out');
  assert.deepEqual(validateScene(un, reg), []);
  // the base graph itself is untouched
  assert.ok(g.nodes.some((n) => n.id === 'blobs'));
});

test('sections validate: format, when, transitions, and every variant as a graph', () => {
  assert.deepEqual(validateScene(acts(), reg), []);
  for (const s of scenes.filter((x) => x.sections)) assert.deepEqual(validateScene(s, reg), [], s.id);
  const bad = (mut: (g: SceneGraph) => void, msg: RegExp) => {
    const g = acts(); mut(g);
    const e = validateScene(g, reg);
    assert.ok(e.some((x) => msg.test(x)), `${msg}: ${e.join(' | ')}`);
  };
  bad((g) => { g.sections!.on = 'verse' as never; }, /on must be/);
  bad((g) => { g.sections!.transition = 'nope'; }, /not a registered id/);
  bad((g) => { g.sections!.variants[0].id = 'base'; }, /not "base"/);
  bad((g) => { g.sections!.variants[1].id = 'drop'; }, /duplicate id/);
  bad((g) => { g.sections!.variants[0].when = { section: 'chorus' }; }, /when.section chorus/);
  bad((g) => { g.sections!.variants[0].when = { mood: 1 } as never; }, /unknown key mood/);
  bad((g) => { g.sections!.variants[0].when = { signal: 'audio.bass' }; }, /needs above/);
  bad((g) => { g.sections!.variants[0].when = { signal: 'audio.spectrum', above: 0.5 }; }, /not a signal/);
  bad((g) => { g.sections!.variants[0].when = { note: 200 }; }, /pitch 0..127/);
  bad((g) => { g.sections!.variants[0].when = { cue: 0 }; }, /cue is 1..9/);
  bad((g) => { g.sections!.variants[0].params = { ghost: { x: 1 } }; }, /ghost: no such node/);
  bad((g) => { g.sections!.variants[1].edges = [{ from: 'pal.palette', to: 'kal.in' }]; }, /section hot: .*palette into tex/);
  bad((g) => { g.sections!.variants[0].params = { gen: { gain: 99 } }; }, /section drop: .*outside/);
  bad((g) => { g.sections!.variants = []; }, /non-empty/);
});

test('section step: decided on the boundary, held for the unit, a pure function of tick + features', () => {
  const g = acts(), plan = compile(g, reg), sample = () => 0, U = unitTicks(g.sections!);
  assert.equal(U, BAR_TICKS);
  for (const tick of [0, 1000, 3000, 7000]) {
    const st = sectionStep(g, tick, D, sample, plan.idHash), b = Math.floor(tick / U) * U;
    assert.equal(st.at, b);
    for (const t of [b, b + 1, b + U - 1]) assert.equal(sectionStep(g, t, D, sample, plan.idHash).idx, st.idx);
    assert.deepEqual(sectionStep(g, tick, D, sample, plan.idHash), st, 'same again');
  }
  // the demo's drop bars pick the drop variant, the breakdown ones the base graph
  assert.equal(pickAt(g.sections!, 20 * BAR_TICKS, D, sample), 0);
  assert.equal(pickAt(g.sections!, 28 * BAR_TICKS, D, sample), -1);
  // entering the drop at its first boundary blends in with the variant's transition, clamped to the unit
  const into = sectionStep(g, 17 * BAR_TICKS + 3, D, sample, plan.idHash);
  assert.deepEqual([into.prev, into.idx], [-1, 0]);
  assert.equal(into.trans.type, 'core-blend'); assert.equal(into.trans.ticks, 56);
});

test('section when: MIDI note (held), CC, cue, signal; the first match wins', () => {
  const log = new EventLog(), F = withEvents(silence, log);
  const g: SceneGraph = { ...acts(), sections: { on: 'bar', variants: [
    { id: 'cued', when: { cue: 2 } },
    { id: 'noted', when: { note: [36, 40], hold: 2 } },
    { id: 'wheel', when: { cc: 0, above: 0.5 } },
    { id: 'loud', when: { signal: 'audio.rms', above: 0.5 } },
  ] } };
  const s = g.sections!, none = () => 0, loud = () => 0.9;
  assert.equal(pickAt(s, 10 * BAR_TICKS, F, none), -1);
  assert.equal(pickAt(s, 10 * BAR_TICKS, F, loud), 3);
  log.add({ tick: 9 * BAR_TICKS + 5, src: 1, type: 'note', payload: { n: 38, v: 100 } });
  assert.equal(F.get(9 * BAR_TICKS + 5, K_NOTE), 39);
  assert.equal(pickAt(s, 10 * BAR_TICKS, F, loud), 1, 'note in the unit before');
  assert.equal(pickAt(s, 11 * BAR_TICKS, F, none), 1, 'held for 2 units');
  assert.equal(pickAt(s, 12 * BAR_TICKS, F, none), -1, 'then released');
  log.add({ tick: 11 * BAR_TICKS, src: 1, type: 'cc', payload: { c: 1, v: 120 } });
  assert.equal(pickAt(s, 12 * BAR_TICKS, F, none), 2);
  log.add({ tick: 11 * BAR_TICKS + 50, src: 1, type: 'cue', payload: { v: 2 } });
  assert.equal(F.get(12 * BAR_TICKS, K_CUE), 2);
  assert.equal(pickAt(s, 12 * BAR_TICKS, F, none), 0, 'the cue is listed first');
});

test('scene hash: two hosts agree, sections change it, a scene without sections hashes as before', () => {
  const g = byId('core-acts-surge'), a = sceneCpu(g, reg), b = sceneCpu(structuredClone(g), reg);
  const seen = new Set<number>(), plans = new Set<number>();
  for (let t = 0; t < 40 * BAR_TICKS; t += 37) {
    const fa = a.state(t, D), fb = b.state(t, D);
    assert.equal(hashOf(fa.hash), hashOf(fb.hash), `tick ${t}`);
    seen.add(hashOf(fa.hash)); plans.add(fa.plan);
  }
  assert.deepEqual([...plans].sort(), [0, 1, 2, 3], 'every section shows on the demo track');
  // the same tick in another section hashes differently
  a.force([{ at: 0, idx: 0 }]); const h0 = hashOf(a.state(5000, D).hash);
  a.force([{ at: 0, idx: 1 }]); const h1 = hashOf(a.state(5000, D).hash);
  assert.notEqual(h0, h1);
  const plain = byId('core-demo'), cpu = sceneCpu(plain, reg), plan = compile(plain, reg);
  for (const t of [0, 99, 1234]) assert.deepEqual(cpu.state(t, D).hash, evalCpu(plan, t, D).hash);
});

test('section blend: both plans evaluated, progress 0 -> 1 over the transition, then one plan', () => {
  const g = byId('core-acts-surge'), cpu = sceneCpu(g, reg);
  cpu.force([{ at: 600, idx: -1 }, { at: 900, idx: 0 }]);
  const before = cpu.state(899, D), first = cpu.state(900, D), mid = cpu.state(910, D), after = cpu.state(1100, D);
  assert.equal(before.trans, null); assert.equal(before.plan, 0);
  assert.ok(first.trans && first.trans.p === 0 && first.prev && first.from === 0 && first.plan === 1);
  assert.ok(mid.trans && mid.trans.p > 0 && mid.trans.p < 1);
  assert.equal(first.trans!.type, 'core-flash');
  assert.equal(after.trans, null); assert.equal(after.plan, 1);
  // forceAll walks base then every variant
  assert.deepEqual(forceAll(g, 600, 480).map((x) => x.idx), [-1, 0, 1, 2]);
});

test('random section transitions are picked from the registry, seeded by scene and boundary', () => {
  const g = byId('core-acts-switchboard'), plan = compile(g, reg), sample = () => 0;
  const types = new Set<string>();
  for (let k = 1; k < 40; k++) {
    const force = [{ at: 0, idx: -1 }, { at: k * 448, idx: 0 }];
    const st = sectionStep(g, k * 448 + 1, silence, sample, plan.idHash, force);
    assert.ok(transEffects().includes(st.trans.type)); types.add(st.trans.type);
    assert.deepEqual(sectionStep(g, k * 448 + 1, silence, sample, plan.idHash, force), st);
  }
  assert.ok(types.size > 3);
});

test('applyStyle styles every variant (its own nodes and out too)', () => {
  const styles = new Map(loadStyles().map((s) => [s.id, s]));
  const raw = loadScenes().find((s) => s.id === 'core-acts-surge')!, styled = applyStyle({ ...raw, style: [...styles.keys()][0] }, styles, reg);
  const graphs = sectionGraphs(styled);
  assert.equal(graphs.length, 4);
  for (const x of graphs) {
    assert.ok(x.nodes.some((n) => n.id === 'style_palette'));
    for (const n of x.nodes.filter((n) => n.id !== 'style_palette')) for (const [p, s] of Object.entries(reg.get(n.piece)!.manifest.ports.in ?? {})) if (s.type === 'palette') assert.ok(x.edges.some((e) => e.to === `${n.id}.${p}` && e.from === 'style_palette.palette'));
  }
  assert.deepEqual(validateScene(styled, reg), []);
});

// ------------------------------------------------------------------ pieces

const piece = (id: string) => reg.get(id)!.driver!.cpu!;
/** A one-node-plus-sources graph, evaluated at tick: the node's CPU out. */
function outAt(nodes: SceneGraph['nodes'], edges: SceneGraph['edges'], id: string, tick: number, F: FeatureSource = D, sub = 0) {
  const g: SceneGraph = { format: 1, id: 'core-test-x', name: 'x', version: 1, author: { vendor: 'core' }, nodes: [...nodes, { id: 'show', piece: 'core-plasma' }], edges, out: 'show.out' };
  // keep node `id` evaluated: bind the plasma's gain to its first signal output
  const sig = Object.entries(reg.get(nodes.find((n) => n.id === id)!.piece)!.manifest.ports.out).find(([, p]) => p.type === 'signal')![0];
  g.nodes.at(-1)!.bind = { gain: { from: `${id}.${sig}` } };
  return evalCpu(compile(g, reg), tick, F, sub).outs.get(id)!;
}

test('core-switch: holds the pick for the unit, fades on a change, renders only what shows', () => {
  const nodes: SceneGraph['nodes'] = [
    { id: 'seq', piece: 'core-step', params: { pattern: '0 0.5 1', rate: 3 } },
    { id: 'a', piece: 'core-plasma' }, { id: 'b', piece: 'core-bars' }, { id: 'c', piece: 'core-plasma', params: { gain: 0.2 } },
    { id: 'sw', piece: 'core-switch', params: { quant: 4, fade: 1 }, bind: { select: { from: 'seq.out', range: [0, 2] } } },
  ];
  const edges = [{ from: 'a.out', to: 'sw.in0' }, { from: 'b.out', to: 'sw.in2' }, { from: 'c.out', to: 'sw.in4' }];
  const g: SceneGraph = { format: 1, id: 'core-test-sw', name: 'x', version: 1, author: { vendor: 'core' }, nodes, edges, out: 'sw.out' };
  assert.deepEqual(validateScene(g, reg), []);
  const plan = compile(g, reg), at = (t: number) => evalCpu(plan, t, D).outs.get('sw')!;
  // bar 0 -> in0, bar 1 -> in2 (the second connected input), bar 2 -> in4, then around again
  assert.deepEqual(at(50).use, ['in0']);
  assert.deepEqual(at(BAR_TICKS + 2).use, ['in0', 'in2'], 'fading in');
  assert.ok((at(BAR_TICKS + 2).w as number) > 0 && (at(BAR_TICKS + 2).w as number) < 0.1);
  assert.deepEqual(at(BAR_TICKS + 40).use, ['in2'], 'faded (1 beat = 28 ticks)');
  assert.deepEqual(at(2 * BAR_TICKS + 60).use, ['in4']);
  assert.deepEqual(at(3 * BAR_TICKS + 60).use, ['in0']);
  // tick quant: no fade, follows select now
  g.nodes[4].params = { quant: 0 };
  assert.deepEqual(evalCpu(compile(g, reg), BAR_TICKS + 2, D).outs.get('sw')!.use, ['in2']);
});

test('core-crossfade: amount walks the inputs, snaps near one', () => {
  const run = (amount: number) => piece('core-crossfade')({ ...base(), params: { amount, mode: 0, snap: 0.02 }, in: {}, wired: ['in0', 'in1', 'in2'], paramAt: () => 0, inputAt: () => 0 });
  assert.deepEqual(run(0).use, ['in0']);
  assert.deepEqual(run(0.25).use, ['in0', 'in1']); assert.equal(run(0.25).w, 0.5);
  assert.deepEqual(run(0.5).use, ['in1']);
  assert.deepEqual(run(0.75).use, ['in1', 'in2']);
  assert.deepEqual(run(1).use, ['in2']);
});

const base = () => {
  const audio = { bands: new Float32Array(16), rms: 0, onset: false, phase: 0, bar: 0, bpm: 128, note: -1, vel: 0, cc: [0, 0, 0, 0] as [number, number, number, number], pal: 0, cue: 0 };
  return { tick: 0, sub: 0, time: 0, audio, past: () => audio, wave: () => null, raw: silence, rand: () => 0.5, lyric: () => null };
};

test('modulators: section, step, random walk, envelope, slew, math, midi', () => {
  // section: the demo's drop bar
  const sec = outAt([{ id: 's', piece: 'core-section', params: { fade: 0 } }], [], 's', 20 * BAR_TICKS + 5);
  assert.equal(sec.drop, 1); assert.equal(sec.intro, 0); assert.equal(sec.section, 2 / 3);
  assert.ok((sec.energy as number) > 0.3);
  assert.equal(outAt([{ id: 's', piece: 'core-section' }], [], 's', 17 * BAR_TICKS).change, 1);
  // step: pattern over bars, gate on step starts
  const st = (t: number) => outAt([{ id: 'q', piece: 'core-step', params: { pattern: '0 1 0.5', rate: 3 } }], [], 'q', t);
  assert.deepEqual([st(10).out, st(BAR_TICKS + 10).out, st(2 * BAR_TICKS + 10).out, st(3 * BAR_TICKS).out], [0, 1, 0.5, 0]);
  assert.equal(st(BAR_TICKS).gate, 1); assert.equal(st(BAR_TICKS + 1).gate, 0);
  // random walk: in range, moves, same on a fresh evaluation
  const rw = (t: number) => outAt([{ id: 'w', piece: 'core-random-walk', params: { rate: 2, glide: 0 } }], [], 'w', t).out as number;
  const vals = Array.from({ length: 40 }, (_, k) => rw(k * 28 + 3));
  assert.ok(vals.every((v) => v >= 0 && v <= 1)); assert.ok(new Set(vals).size > 20);
  assert.equal(rw(500), rw(500));
  // envelope: up on an onset, down after
  const T = fixtureSource('techno');
  const env = (t: number) => outAt([{ id: 'e', piece: 'core-envelope', params: { attack: 0, decay: 0.2, release: 0.1 } }], [], 'e', t, T).out as number;
  let on = 700; while (!T.get(on, 17)) on++;
  assert.ok(env(on) > 0.9); assert.ok(env(on + 10) < env(on)); assert.ok(env(on + 10) > 0);
  // slew: smooth lags a step; release holds a peak
  const sl = (mode: number, t: number) => outAt([{ id: 'l', piece: 'core-lfo', params: { beats: 8, shape: 3 } }, { id: 's', piece: 'core-slew', params: { mode, time: 0.5 } }], [{ from: 'l.out', to: 's.in' }], 's', t).out as number;
  // the square lfo drops from 1 to 0 at half its 8-beat cycle (tick 112)
  assert.ok(sl(0, 120) > 0.2 && sl(0, 120) < 0.9);
  assert.ok(sl(1, 113) > 0.9 && sl(1, 140) < 0.1, "release: holds, then falls 1 per 0.5 s");
  // math
  const m = (op: number, a: number, extra: Record<string, number> = {}) => piece('core-math')({ ...base(), params: { op, in_lo: 0, in_hi: 1, lo: 0, hi: 1, amount: 0.5, steps: 4, ...extra }, in: { a, b: 0.2 }, wired: ['a', 'b'], paramAt: () => 0, inputAt: () => 0 }).out;
  assert.equal(m(0, 0.5, { in_lo: 0.25, in_hi: 0.75, lo: 2, hi: 4 }), 3);
  assert.equal(m(1, 1), 0.6); assert.equal(m(6, 0.25), 0.75); assert.equal(m(7, 0.6), 1); assert.equal(m(8, 0.6), 2 / 3);
  // midi: CC params and the cue from the input keys
  const log = new EventLog(), F = withEvents(silence, log);
  log.add({ tick: 5, src: 1, type: 'cc', payload: { c: 74, v: 127 } });
  log.add({ tick: 8, src: 1, type: 'note', payload: { n: 60, v: 64 } });
  log.add({ tick: 9, src: 1, type: 'cue', payload: { v: 3 } });
  const mi = outAt([{ id: 'm', piece: 'core-midi', params: { lo: 48, hi: 72 } }], [], 'm', 20, F);
  assert.equal(mi.cc1, 1); assert.equal(mi.pitch, 0.5); assert.ok(Math.abs((mi.vel as number) - 0.504) < 0.01); assert.equal(mi.cue, 3 / 9);
});

test('paramAt / inputAt evaluate the graph upstream at other ticks', () => {
  const g: SceneGraph = {
    format: 1, id: 'core-test-at', name: 'x', version: 1, author: { vendor: 'core' },
    nodes: [
      { id: 'seq', piece: 'core-step', params: { pattern: '0 1', rate: 3 } },
      { id: 'sw', piece: 'core-switch', params: { quant: 0 }, bind: { select: { from: 'seq.out', range: [0, 1] } } },
      { id: 'a', piece: 'core-plasma' }, { id: 'b', piece: 'core-bars' },
    ],
    edges: [{ from: 'a.out', to: 'sw.in0' }, { from: 'b.out', to: 'sw.in1' }],
    out: 'sw.out',
  };
  const f = evalCpu(compile(g, reg), 10, D), h = f.helpers.get('sw')!;
  assert.equal(h.paramAt('select', 10), 0);
  assert.equal(h.paramAt('select', BAR_TICKS + 3), 1);
  assert.deepEqual([...h.wired].sort(), ['in0', 'in1']);
  assert.equal(f.helpers.get('seq')!.inputAt('nope', 5), undefined);
});
