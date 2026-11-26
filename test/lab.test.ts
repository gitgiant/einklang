import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixtureSource, FIXTURES } from '../src/core/fixtures.ts';
import { K_ONSET, K_RMS, STRIDE } from '../src/core/constants.ts';
import { judgeRun, judgeReactive, judgeCost, motion, reactivity, junit, LIMITS } from '../scripts/lab/checks.ts';
import { lintDriver, lintPieces } from '../scripts/lab/lint.ts';
import { harness } from '../src/core/graph/harness.ts';
import { validateScene } from '../src/core/graph/validate.ts';
import { loadPieces, LAB } from '../scripts/lab/load.ts';
import type { RunResult, FrameStat } from '../src/web/lab.ts';
import { join } from 'node:path';

const { reg } = await loadPieces();

test('fixtures: deterministic, distinct, with onsets where drums are', () => {
  const sum = (name: (typeof FIXTURES)[number]) => {
    const F = fixtureSource(name);
    let s = 0, onsets = 0;
    for (let t = 0; t < 600; t++) { for (let k = 0; k < STRIDE; k++) s += F.get(t, k) * (k + 1); if (F.get(t, K_ONSET)) onsets++; }
    return { s, onsets, rms: F.get(300, K_RMS), wave: F.wave(300)!.reduce((a, x) => a + Math.abs(x), 0) };
  };
  const a = FIXTURES.map(sum), b = FIXTURES.map(sum);
  assert.deepEqual(a, b);
  assert.equal(new Set(a.map((x) => x.s)).size, 3);
  const [quiet, techno, dense] = a;
  assert.equal(quiet.onsets, 0);
  assert.ok(techno.onsets >= 20, `techno onsets ${techno.onsets}`);
  assert.ok(dense.onsets > techno.onsets, `dense ${dense.onsets} vs techno ${techno.onsets}`);
  for (const x of a) assert.ok(x.wave > 1000, 'every fixture has a waveform');
  assert.equal(fixtureSource('silence').get(100, 3), 0);
});

const stat = (luma: number, thumbV: number, extra: Partial<FrameStat> = {}): FrameStat => ({ tick: 0, luma, black: 0, white: 0, nan: 0, thumb: new Array(16).fill(thumbV), ...extra });
const run = (stats: FrameStat[], extra: Partial<RunResult> = {}): RunResult => ({ ok: true, hashes: [], stats, msPerFrame: 1, adapter: 'x', errors: [], ...extra });

test('checks: black, blown out, NaN, frozen; quiet only warns about dark/still', () => {
  const moving = [stat(0.5, 10), stat(0.5, 60), stat(0.5, 20)];
  assert.deepEqual(judgeRun('techno', run(moving)).failures, []);
  const black = [stat(0.001, 0), stat(0.001, 0), stat(0.001, 0)];
  const f = judgeRun('techno', run(black)).failures.join('\n');
  assert.match(f, /black/); assert.match(f, /frozen/);
  const q = judgeRun('quiet', run(black));
  assert.deepEqual(q.failures, []); assert.match(q.notes.join(' '), /warning: black/);
  assert.match(judgeRun('dense', run(moving.map((s) => ({ ...s, white: 0.95 })))).failures.join(), /blown out/);
  assert.match(judgeRun('dense', run([...moving, stat(0.5, 30, { nan: 3 })])).failures.join(), /NaN/);
  assert.match(judgeRun('dense', run(moving, { ok: false, error: 'boom' })).failures.join(), /render failed: boom/);
  assert.match(judgeRun('dense', run(moving, { errors: ['WebGPU: bad\n- details', '[p] main.wgsl:2:3 oops', 'WebGPU: bad\n- details'] })).failures[0], /\[p\] main\.wgsl:2:3 oops\n {2}WebGPU: bad$/);
});

test('checks: motion, reactivity, cost', () => {
  assert.equal(motion([stat(0, 0), stat(0, 0)]), 0);
  assert.ok(motion([stat(0, 0), stat(0, 255)]) > 0.9);
  const a = [stat(0, 10), stat(0, 20)], same = [stat(0, 10), stat(0, 20)], diff = [stat(0, 100), stat(0, 120)];
  assert.equal(reactivity(a, same), 0);
  assert.match(judgeReactive([{ fixture: 'techno', reactivity: reactivity(a, same) }])!, /doesn't react/);
  assert.equal(judgeReactive([{ fixture: 'quiet', reactivity: 0 }, { fixture: 'techno', reactivity: reactivity(a, diff) }]), null);
  assert.equal(judgeCost(LIMITS.sceneMs - 1, LIMITS.sceneMs, 's'), null);
  assert.match(judgeCost(LIMITS.pieceMs + 1, LIMITS.pieceMs, 'the piece')!, /too slow/);
});

test('junit output escapes and counts failures', () => {
  const x = junit('s', [{ name: 'a<b', classname: 'c' }, { name: 'd', classname: 'c', failure: 'x "y" & z\nmore' }]);
  assert.match(x, /tests="2" failures="1"/);
  assert.match(x, /name="a&lt;b"/);
  assert.match(x, /message="x &quot;y&quot; &amp; z"/);
});

test('lint: pieces import only lab/api and their own folder; no page/network/timers', () => {
  const dir = join(LAB, 'pieces', 'effect', 'acme-thing');
  assert.deepEqual(lintDriver("import { definePiece } from '../../../api/index.ts';\nimport x from './helper.ts';", dir, false), []);
  assert.match(lintDriver("import fs from 'node:fs';", dir, false).join(), /only lab\/api/);
  assert.match(lintDriver("import { flow } from '../../../../src/core/scenes/flow.ts';", dir, false).join(), /only lab\/api/);
  assert.deepEqual(lintDriver("import { flow } from '../../../../src/core/scenes/flow.ts';", dir, true), []);
  assert.match(lintDriver("const r = fetch('x');", dir, false).join(), /fetch/);
  assert.match(lintDriver('setTimeout(() => 0, 1);', dir, false).join(), /setTimeout/);
  assert.deepEqual(lintDriver('// fetch in a comment is fine\nconst a = 1;', dir, false), []);
  assert.deepEqual(lintPieces(), []);
});

test('harness: every piece with a tex, palette or signal output gets a valid harness and baseline', () => {
  let n = 0;
  for (const id of reg.keys()) {
    for (const base of [false, true]) {
      const h = harness(id, reg, base);
      if (typeof h === 'string') { assert.match(h, /can't/, id); continue; }
      assert.deepEqual(validateScene(h, reg), [], `${id}${base ? ' (base)' : ''}`);
      if (!base) assert.ok(h.nodes.some((x) => x.piece === id), id);
      n++;
    }
  }
  assert.ok(n >= 20);
});
