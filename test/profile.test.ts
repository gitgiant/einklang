import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pct, summarize } from '../scripts/lab/profile.ts';

test('pct: nearest rank', () => {
  assert.equal(pct([], 0.5), 0);
  assert.equal(pct([3, 1, 2], 0.5), 2);
  assert.equal(pct([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.95), 10);
  assert.equal(pct([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9), 9);
});

test('summarize: splits before / transition / after, first frame and worst', () => {
  const f = (at: number, wall: number) => ({ at, wall, js: 1, cpu: { a: 1, b: 2 }, gpu: { a: 3, mix: at === 0 ? 100 : 1 } });
  const s = summarize('x', [f(-2, 5), f(-1, 5), f(0, 40), f(1, 10), f(2, 12), f(3, 9), f(4, 6)], 4);
  assert.equal(s.first, 40);
  assert.equal(s.max, 40); assert.equal(s.maxAt, 0);
  assert.equal(s.p50, 10);
  assert.equal(s.before, 5); assert.equal(s.after, 6);
  assert.equal(s.frames, 4);
  // section means skip the first transition frame (its one-off cost shows in `first`)
  assert.deepEqual(s.gpu, { a: 3, mix: 1 });
  assert.deepEqual(s.cpu, { a: 1, b: 2 });
});
