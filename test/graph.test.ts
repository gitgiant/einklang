import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadPieces, loadScenes } from '../scripts/lab/load.ts';
import { validateScene, order } from '../src/core/graph/validate.ts';
import { compile, evalCpu } from '../src/core/graph/eval.ts';
import type { SceneGraph } from '../src/core/graph/types.ts';
import { demoSource } from '../src/core/demo.ts';
import { silence } from '../src/core/features.ts';
import { hashState } from '../src/core/scene.ts';
import type { Palette } from '../lab/api/index.ts';

const { reg, errors } = await loadPieces();
const scenes = loadScenes();
const demo = () => structuredClone(scenes.find((s) => s.id === 'core-demo')!);
const errsOf = (g: SceneGraph) => validateScene(g, reg);

test('every lab piece is valid', () => {
  assert.deepEqual(errors, []);
  assert.ok(reg.size >= 10);
});

test('every lab scene is valid and compiles', () => {
  assert.ok(scenes.length >= 1);
  for (const s of scenes) { assert.deepEqual(errsOf(s), [], s.id); compile(s, reg); }
});

test('validation catches type mismatches, missing inputs, bad params, cycles', () => {
  let g = demo(); g.edges.push({ from: 'pal.palette', to: 'kal.in' }); // second edge into kal.in, wrong type
  assert.ok(errsOf(g).some((e) => e.includes('palette into tex')));
  assert.ok(errsOf(g).some((e) => e.includes('more than one edge')));
  g = demo(); g.edges = g.edges.filter((e) => e.to !== 'mix.b');
  assert.ok(errsOf(g).some((e) => e.includes('mix.b is not connected')));
  g = demo(); g.nodes.find((n) => n.id === 'kal')!.params = { segments: 99 };
  assert.ok(errsOf(g).some((e) => e.includes('outside')));
  g = demo(); g.nodes.find((n) => n.id === 'plasma')!.bind = { warp: { from: 'pal.palette' } };
  assert.ok(errsOf(g).some((e) => e.includes('needs a signal')));
  g = demo(); g.out = 'pal.palette';
  assert.ok(errsOf(g).some((e) => e.includes('must be tex')));
  g = demo(); g.edges.push({ from: 'trails.out', to: 'mix.b' }); g.edges = g.edges.filter((e) => e.from !== 'bars.out');
  assert.ok(errsOf(g).some((e) => e.includes('cycle')));
  g = demo(); g.nodes.push({ id: 'x', piece: 'nobody-nothing' });
  assert.ok(errsOf(g).some((e) => e.includes('unknown piece')));
});

test('order: dependencies first, only what the output needs', () => {
  const g = demo();
  g.nodes.push({ id: 'unused', piece: 'core-lfo' });
  const o = order(g)!;
  assert.ok(!o.includes('unused'));
  const at = (n: string) => o.indexOf(n);
  assert.ok(at('lfo') < at('pal') && at('pal') < at('plasma') && at('bass') < at('plasma'));
  assert.ok(at('mix') < at('kal') && at('kal') < at('trails'));
  assert.equal(o[o.length - 1], 'trails');
});

test('bindings map signals onto params, clamped to the param range', () => {
  const plan = compile(demo(), reg), F = demoSource();
  for (const t of [0, 300, 2000, 4100]) {
    const f = evalCpu(plan, t, F);
    const bass = f.outs.get('bass')!.out as number, warp = f.params.get('plasma')!.warp as number;
    assert.ok(Math.abs(warp - Math.min(2, bass * 1.5)) < 1e-9, `t=${t}`);
    const hue = f.params.get('pal')!.hue as number, lfo = f.outs.get('lfo')!.out as number;
    assert.ok(Math.abs(hue - (0.5 + lfo * 0.3)) < 1e-9);
    assert.equal(f.params.get('kal')!.segments, 8);
    assert.equal(f.params.get('kal')!.spin, 0.05); // default
  }
});

test('palette output: 5 OKLab stops', () => {
  const f = evalCpu(compile(demo(), reg), 100, demoSource());
  const p = f.outs.get('pal')!.palette as Palette;
  assert.equal(p.stops.length, 5);
  for (const s of p.stops) assert.ok(s[0] > 0 && s[0] <= 1);
});

test('hash: pure function of (tick, features), order independent, sensitive to params and version', () => {
  const plan = compile(demo(), reg), ticks = [0, 1, 59, 600, 2276, 5000];
  const fwd = ticks.map((t) => hashState({ u: evalCpu(plan, t, demoSource()).hash, prims: null }));
  const F = demoSource();
  const rev = [...ticks].reverse().map((t) => hashState({ u: evalCpu(plan, t, F).hash, prims: null })).reverse();
  assert.deepEqual(rev, fwd);
  assert.equal(new Set(fwd).size, fwd.length);
  const h = (g: SceneGraph) => hashState({ u: evalCpu(compile(g, reg), 600, demoSource()).hash, prims: null });
  const base = h(demo());
  const g1 = demo(); g1.version = 2; assert.notEqual(h(g1), base);
  const g2 = demo(); g2.nodes.find((n) => n.id === 'kal')!.params = { segments: 7 }; assert.notEqual(h(g2), base);
  // the sub-tick changes drawn values, not what a tick hashes to
  assert.deepEqual(evalCpu(plan, 600, demoSource(), 0).hash, evalCpu(plan, 600, demoSource()).hash);
  assert.notEqual(evalCpu(plan, 600, demoSource(), 128).params.get('pal')!.hue, evalCpu(plan, 600, demoSource()).params.get('pal')!.hue);
});

test('silence evaluates without NaN', () => {
  const f = evalCpu(compile(demo(), reg), 10, silence);
  for (const P of f.params.values()) for (const v of Object.values(P)) if (typeof v === 'number') assert.ok(Number.isFinite(v));
});
