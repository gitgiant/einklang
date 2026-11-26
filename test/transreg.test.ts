// Pluggable transitions: the registry built from lab/transitions/, its curves, and the shader assembly.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TRANSITIONS_DIR, readTransitionFiles } from '../src/server/transitions.ts';
import {
  CORE_ORDER, CURVES, ONE, buildTransitions, curveAt, orderTransitions, resolveTrans, transIds, transitionAt, transHash, transName,
  validateTransition, type CurveSpec, type TransFile,
} from '../src/core/transitions.ts';
import { assembleTransitions, mixLine, namespaced, topLevelNames } from '../src/core/transwgsl.ts';
import { demoSource } from '../src/core/demo.ts';
import { silence, type FeatureSource } from '../src/core/features.ts';
import { FNV0, fnv } from '../src/core/math.ts';
import { K_ONSET } from '../src/core/constants.ts';

/**
 * Before the registry, per short name: a fold of kind, p16, flash16, roll, seed, transHash and
 * bands over four schedules x two sources x every tick x three sub-ticks (computed on main at e3c7302).
 */
const GOLDEN: Record<string, number> = {
  cut: 3108815427, blend: 3686062009, flash: 1408698049, wipe: 2209361077, iris: 1391031893, dissolve: 4124787561, luma: 3230843777,
  zoom: 1555319893, glitch: 1312386257, stutter: 3671570417, swirl: 2698581537, melt: 1346374933, audio: 85897079, pixelate: 2625177545,
};

test('the 14 core transitions hash exactly as before the registry', () => {
  const F = demoSource();
  for (const [short, want] of Object.entries(GOLDEN)) {
    let h = FNV0;
    for (const [ticks, tpb, seed] of [[112, 28, 123], [28, 28, 0xdeadbeef], [13, 27.5, 7], [450, 31.25, 99]]) for (const src of [F, silence]) {
      const s = { id: 'b', prev: 'a', at: 1000, trans: { type: `core-${short}`, ticks, seed, tpb }, earlier: [] };
      for (let t = 995; t < 1000 + ticks + 3; t++) for (const sub of [0, 77, 200]) {
        const tr = transitionAt(s, t, src, sub);
        h = fnv(h, tr ? [tr.kind, tr.p16, tr.flash16, tr.roll, tr.seed | 0, transHash(1, 2, tr), ...(tr.bands ?? [])] : [-1]);
      }
    }
    assert.equal(h >>> 0, want, `core-${short}`);
  }
});

test('registry order: core ones first in the historical order, then the rest by id', () => {
  const ids = transIds();
  assert.deepEqual(ids.slice(0, 14), [...CORE_ORDER]);
  const rest = ids.slice(14);
  assert.deepEqual(rest, [...rest].sort());
  // the order doesn't depend on the order folders are found in
  const { files } = readTransitionFiles(TRANSITIONS_DIR);
  const fake = (id: string): TransFile => ({ folder: id, def: { id, name: id, vendor: id.split('-')[0], description: 'x', curve: 'linear' }, wgsl: 'fn trans(uv: vec2f) -> vec3f { return sa(uv); }' });
  const extra = [fake('codex-zz'), fake('agy-b'), fake('claude-a'), fake('agy-a')];
  const a = buildTransitions([...files, ...extra]), b = buildTransitions([...extra].reverse().concat([...files].reverse()));
  assert.deepEqual(a.errors, []);
  assert.deepEqual(a.list.map((e) => e.id), b.list.map((e) => e.id));
  assert.deepEqual(a.list.map((e) => e.id).slice(0, 14), [...CORE_ORDER]);
  assert.deepEqual(a.list.slice(14).map((e) => e.id), [...rest, 'agy-a', 'agy-b', 'claude-a', 'codex-zz'].sort());
  assert.deepEqual(a.list.map((e) => e.kind), a.list.map((_, i) => i));
  assert.deepEqual(orderTransitions([{ id: 'agy-x' }, { id: 'core-blend' }, { id: 'core-cut' }]).map((x) => x.id), ['core-cut', 'core-blend', 'agy-x']);
});

test('short names and ids resolve; anything else does not', () => {
  assert.equal(resolveTrans('blend'), 'core-blend');
  assert.equal(resolveTrans('core-blend'), 'core-blend');
  assert.equal(resolveTrans('cut'), 'core-cut');
  assert.equal(resolveTrans('nope'), null);
  assert.equal(resolveTrans(3), null);
  assert.equal(resolveTrans(undefined), null);
  assert.equal(transName('core-audio'), 'audio mask');
});

test('folder validation: ids, vendor prefix, curves and params, mix.wgsl contract, duplicates', () => {
  const ok = { id: 'agy-ripple', name: 'ripple', vendor: 'agy', description: 'Rings.', curve: { type: 'beat-steps', per: 8 } };
  const wgsl = 'fn trans(uv: vec2f) -> vec3f { return mix(sa(uv), sb(uv), T.p); }';
  const v = (def: unknown, w: string | undefined = wgsl, folder = 'agy-ripple') => validateTransition({ folder, def, wgsl: w });
  assert.deepEqual(v(ok), []);
  assert.match(v({ ...ok, id: 'Ripple' }).join(), /id must be/);
  assert.match(v({ ...ok, id: 'bob-ripple' }, wgsl, 'bob-ripple').join(), /not a vendor/);
  assert.match(v({ ...ok, vendor: 'codex' }).join(), /vendor must be "agy"/);
  assert.match(v(ok, wgsl, 'agy-other').join(), /doesn't match its folder/);
  assert.match(v({ ...ok, curve: 'wobble' }).join(), /curve: one of/);
  assert.match(v({ ...ok, curve: { type: 'beat-steps', per: 0.5 } }).join(), /curve.per: an integer/);
  assert.match(v({ ...ok, curve: { type: 'linear', per: 2 } }).join(), /no param "per"/);
  assert.match(v({ ...ok, uses: ['time'] }).join(), /uses:/);
  assert.match(v({ ...ok, colour: 1 }).join(), /unknown key "colour"/);
  assert.match(v({ ...ok, params: { Soft: { default: 1 } } }).join(), /lowercase identifier/);
  assert.match(validateTransition({ folder: 'agy-ripple', def: ok, wgsl: undefined }).join(), /missing mix.wgsl/);
  assert.match(v(ok, 'fn mixit(uv: vec2f) -> vec3f { return sa(uv); }').join(), /must define fn trans/);
  assert.match(v(ok, wgsl + '\n@group(0) @binding(9) var<uniform> X: f32;').join(), /may not declare bindings/);
  const dup = buildTransitions([...readTransitionFiles().files, { folder: 'core-blend', def: { ...ok, id: 'core-blend', vendor: 'core' }, wgsl }]);
  assert.match(dup.errors.join(), /duplicate id core-blend/);
  assert.match(buildTransitions([]).errors.join(), /core transition missing/);
});

test('every folder in lab/transitions is valid', () => {
  const { files, errors } = readTransitionFiles();
  assert.deepEqual([...errors, ...buildTransitions(files).errors], []);
});

const tr = { ticks: 112, tpb: 28 };
const at = (c: CurveSpec, x: number, F: FeatureSource = silence) => curveAt(c, tr, 0, Math.round(x * tr.ticks), F) / ONE;

test('curves: endpoints, shapes and params', () => {
  for (const type of Object.keys(CURVES) as CurveSpec['type'][]) {
    if (type === 'stutter') continue;
    const c = { type };
    assert.ok(at(c, 0) <= 1 / 4 + 1e-9, `${type} starts low`);
    let prev = -1;
    for (let dt = 0; dt < tr.ticks; dt++) { const p = curveAt(c, tr, 0, dt, silence); assert.ok((type === 'bounce' || p >= prev) && p >= 0 && p <= ONE, `${type} monotonic at ${dt}`); prev = p; }
    assert.ok(prev >= ONE * 0.95, `${type} nearly done on its last tick (${prev / ONE})`);
  }
  assert.equal(at({ type: 'linear' }, 0.5), 0.5);
  assert.equal(at({ type: 'smoothstep' }, 0.25), Math.round(0.15625 * ONE) / ONE);
  assert.equal(at({ type: 'cubic' }, 0.25), Math.round(0.0625 * ONE) / ONE);
  assert.equal(at({ type: 'smootherstep' }, 0.5), 0.5);
  assert.equal(at({ type: 'ease-in' }, 0.5), 0.25);
  assert.equal(at({ type: 'ease-in', power: 3 }, 0.5), 0.125);
  assert.equal(at({ type: 'ease-out' }, 0.5), 0.75);
  assert.equal(at({ type: 'ease-out', power: 3 }, 0.5), 0.875);
  assert.ok(at({ type: 'bounce' }, 1 / 2.75) > 0.98, 'bounce touches 1 at its first landing');
  assert.ok(at({ type: 'bounce' }, 0.5) < at({ type: 'bounce' }, 1 / 2.75), 'then bounces back');
  // beat-steps: flat within a 1/per beat, (i + 1) / n
  const bs = (dt: number, per = 4) => curveAt({ type: 'beat-steps', per }, tr, 0, dt, silence) / ONE;
  assert.equal(bs(0), Math.round(ONE / 16) / ONE);
  assert.equal(bs(6), bs(0));
  assert.equal(bs(7), Math.round((2 * ONE) / 16) / ONE);
  assert.equal(bs(111), 1);
  assert.equal(bs(3, 8), bs(0, 8));
  assert.notEqual(bs(4, 8), bs(3, 8));
  // onset: a bigger push gets further ahead on the same onsets
  const onsets: FeatureSource = { get: (t, k) => (k === K_ONSET && t % 14 === 0 ? 255 : 0), wave: () => null };
  const o = (push: number) => curveAt({ type: 'onset', push }, tr, 0, 30, onsets);
  assert.ok(o(0) < o(0.15) && o(0.15) < o(0.5));
  assert.equal(o(0), curveAt({ type: 'smoothstep' }, tr, 0, 30, onsets));
});

test('shader assembly: each mix in its own namespace, a switch over every kind, lines map back', () => {
  const src = `// helpers\nconst K = 2.0;\nfn wave(x: f32) -> f32 { let K2 = K; return sin(x * K2); }\nfn trans(uv: vec2f) -> vec3f {\n  let w = wave(uv.x) * p_amp();\n  return mix(sa(uv), sb(uv), T.p * w);\n}\n`;
  assert.deepEqual(topLevelNames(src), ['K', 'wave', 'trans']);
  const ns = namespaced({ id: 'agy-wave', wgsl: src, params: { amp: { default: 1 } } });
  assert.match(ns, /const K__agy_wave = 2\.0;/);
  assert.match(ns, /fn wave__agy_wave\(x: f32\)/);
  assert.match(ns, /let K2 = K__agy_wave;/, 'locals are left alone');
  assert.match(ns, /fn trans__agy_wave\(uv: vec2f\)/);
  assert.match(ns, /fn p_amp__agy_wave\(\) -> f32 \{ return 1\.0; \}/);
  assert.match(ns, /T\.p \* w/, 'members untouched');
  assert.match(ns, /sa\(uv\), sb\(uv\)/, 'prelude helpers untouched');
  const list = [{ id: 'core-cut', kind: 0, wgsl: 'fn trans(uv: vec2f) -> vec3f { return sa(uv); }' }, { id: 'agy-wave', kind: 1, wgsl: src, params: { amp: { default: 1 } } }];
  const a = assembleTransitions('// prelude\nfn x() {}\n', list);
  assert.match(a.code, /case 0u: \{ c = trans__core_cut\(uv\); \}/);
  assert.match(a.code, /case 1u: \{ c = trans__agy_wave\(uv\); \}/);
  const lines = a.code.split('\n');
  for (const e of list) {
    const s = a.spans.find((x) => x.id === e.id)!;
    assert.equal(lines[s.start - 1].replace(/__\w+/g, ''), e.wgsl.split('\n')[0].replace(/__\w+/g, ''), `${e.id} first line`);
  }
  const s1 = a.spans[1];
  assert.deepEqual(mixLine(a.spans, s1.start + 3), { id: 'agy-wave', line: 4 });
  assert.equal(mixLine(a.spans, 1), null);
});
