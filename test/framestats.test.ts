import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FrameStats } from '../src/web/framestats.ts';

test('FrameStats: worst frame of the last switch, including the interval after its last frame', () => {
  const s = new FrameStats();
  let t = 0;
  const step = (dt: number, trans: string | null) => { t += dt; s.frame(t, trans); };
  for (let i = 0; i < 10; i++) step(16, null);
  assert.equal(s.lastSwitch === null, true);
  step(16, 'core-blend'); // first switch frame drawn
  step(50, 'core-blend'); // its cost shows here
  step(16, 'core-blend');
  step(16, null);         // the interval after the last switch frame
  assert.equal(s.lastSwitch === null, true);
  step(30, null);         // no longer part of it
  assert.ok(s.lastSwitch);
  assert.equal(s.lastSwitch.type, 'core-blend');
  assert.equal(s.lastSwitch.worst, 50);
  assert.equal(s.lastSwitch.start, 50);
  assert.equal(s.lastSwitch.frames, 3);
  assert.match(s.line(), /last switch core-blend: worst 50\.0 ms/);
  assert.equal(s.recent().p50, 16);
});

test('FrameStats: back-to-back switches are kept apart', () => {
  const s = new FrameStats();
  let t = 0;
  const step = (dt: number, trans: string | null) => { t += dt; s.frame(t, trans); };
  step(16, null); step(16, 'a'); step(40, 'a'); step(16, 'b'); step(16, 'b'); step(16, null); step(16, null);
  assert.equal(s.lastSwitch?.type, 'b');
  assert.equal(s.lastSwitch?.worst, 16);
});
