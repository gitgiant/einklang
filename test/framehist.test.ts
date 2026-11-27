import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BUCKETS, FrameRecorder, Refresh, SEGMENTS, Tally, bucketOf, grade, reportText, segmentRows, type ShownTrans } from '../src/web/framehist.ts';

test('buckets: the nominal edges, with slack for rAF jitter', () => {
  assert.deepEqual([8.3, 11.1, 16.7, 20, 33.3, 50, 80].map(bucketOf), [0, 1, 2, 3, 4, 5, 6]);
  // a jittery or ms-rounded 60 Hz frame is still a 60 fps one
  assert.deepEqual([16, 17, 17.3, 17.5].map(bucketOf), [2, 2, 2, 3]);
  assert.equal(bucketOf(33.9), 4);
  assert.equal(bucketOf(1e6), BUCKETS.length - 1);
});

test('grade: relative to the refresh interval', () => {
  const row = (hz: number) => BUCKETS.map((_, i) => grade(i, 1000 / hz)[0]).join('');
  assert.equal(row(60), 'gggobbb');
  assert.equal(row(120), 'gobbbbb');
  assert.equal(row(90), 'ggobbbb');
  assert.equal(row(144), 'gbbbbbb');
});

test('Tally: percentiles, dropped frames and bucket shares', () => {
  const t = new Tally();
  assert.equal(t.summary(16.7).frames, 0);
  assert.equal(t.summary(16.7).p99, 0);
  for (let i = 1; i <= 100; i++) t.add(i); // 1..100 ms, once each
  const s = t.summary(1000 / 60);
  assert.deepEqual([s.median, s.p95, s.p99, s.worst].map(Math.round), [50, 95, 99, 100]);
  assert.equal(s.avg, 50.5);
  assert.equal(s.dropped, 75); // over 25 ms
  assert.equal(s.buckets[0], 9); // 1..9 ms
  assert.equal(s.buckets[6], 50);
  assert.ok(Math.abs(s.buckets.reduce((a, b) => a + b, 0) - 100) < 1e-9);
});

test('Tally: a frame past the fine bins reads as the worst one', () => {
  const t = new Tally();
  t.add(900);
  const s = t.summary(16.7);
  assert.deepEqual([s.median, s.worst, s.dropped, s.buckets[6]], [900, 900, 1, 100]);
});

test('Refresh: the fastest sustained rate, never under 60 Hz', () => {
  const r = new Refresh();
  const feed = (ms: number, n = 90) => { for (let i = 0; i < n; i++) r.add(ms); };
  assert.equal(r.measured, false);
  feed(33.3);
  assert.equal(r.hz, 60);
  feed(8.4);
  assert.equal(r.hz, 120);
  feed(16.7); // a slow stretch doesn't lower it
  assert.equal(r.hz, 120);
  const b = new Refresh();
  for (let i = 0; i < 90; i++) b.add(i < 3 ? 2 : 11.2); // a few odd short ones don't count
  assert.equal(b.hz, 90);
});

const rec = () => {
  const r = new FrameRecorder();
  let t = 1000;
  const run = (n: number, ms: number, scene: string, trans: ShownTrans | null = null) => { for (let i = 0; i < n; i++) r.frame((t += ms), scene, trans); };
  return { r, run, now: () => t };
};

test('FrameRecorder: windows', () => {
  const { r, run, now } = rec();
  run(1000, 40, 'a'); // 40 s
  run(300, 20, 'a'); // 6 s
  assert.equal(r.summary('5s', now()).frames, 250);
  assert.equal(r.summary('5s', now()).worst, 20);
  assert.equal(r.summary('30s', now()).frames, 300 + 600);
  assert.equal(r.summary('load', now()).frames, 1299); // the first frame has no interval
  assert.equal(r.summary('scene', now()).frames, 1299);
});

test('FrameRecorder: an interval counts for what the previous frame drew', () => {
  const { r, run, now } = rec();
  const tr = { type: 'x', from: 'a', to: 'b' };
  run(10, 16, 'a');
  run(1, 16, 'a', tr);   // first switch frame: the interval before it was a's
  run(1, 90, 'a', tr);   // its cost
  run(1, 16, 'b');       // the last switch frame's
  run(5, 16, 'b');
  const rows = segmentRows(r, (s) => (s.trans ? `${s.trans.from}>${s.trans.to}` : s.scene));
  assert.deepEqual(rows.map((x) => [x.name, x.frames, x.worst]), [['b', 5, 16], ['a>b', 2, 90], ['a', 10, 16]]);
  // "since scene start" includes the switch into the scene
  assert.equal(r.summary('scene', now()).frames, 7);
});

test('FrameRecorder: keeps the last segments, skips hidden-page gaps, counts long tasks, resets', () => {
  const { r, run, now } = rec();
  for (let i = 0; i < SEGMENTS + 5; i++) run(2, 16, `s${i}`);
  assert.equal(r.segments.length, SEGMENTS);
  assert.equal(r.segments[0].scene, `s${SEGMENTS + 4}`);
  const frames = r.summary('load', now()).frames;
  r.gap(); run(1, 3000, 'z'); run(1, 60_000, 'z');
  assert.equal(r.summary('load', now()).frames, frames);
  r.longTask(10); r.longTask(now() - 100);
  assert.equal(r.summary('5s', now()).longTasks, 1);
  assert.equal(r.summary('load', now()).longTasks, 2);
  r.reset();
  assert.equal(r.summary('load', now()).frames, 0);
  assert.equal(r.summary('load', now()).longTasks, 0);
  assert.equal(r.segments.length, 0);
});

test('reportText: window, buckets and the scene table', () => {
  const { r, run, now } = rec();
  run(11, 16, 'a');
  const text = reportText({ span: '30s', summary: r.summary('30s', now()), refresh: r.refresh, longTasks: false, gpu: 'GPU ms: n/a', rows: segmentRows(r, (s) => s.scene) }, ['dev']);
  assert.match(text, /^einklang frames · 30 s\ndev\nfps 62\.5 {3}display 60 Hz \(assumed\)/);
  assert.match(text, /long tasks n\/a/);
  assert.match(text, /11\.1-16\.7 \(60\) +100\.0%/);
  assert.match(text, /\na: 16\.0 \/ 16\.0 \/ 16\.0, 0\/10$/);
});
