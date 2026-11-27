import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FlowSim } from '../src/core/scenes/flow.ts';
import { demoSource } from '../src/core/demo.ts';
import { RESEED_TICKS } from '../src/core/constants.ts';
import { FlowCheck, follow } from '../lab/pieces/generator/core-flow/check.ts';

/** A clock that moves 1 ms per read: every follow() slice with budget b takes about b steps. */
const ticker = () => { let t = 0; return () => t++; };

test('follow walks to the goal in bounded slices and lands on the same state as one seek', () => {
  const F = demoSource(), at = RESEED_TICKS * 3 + 700;
  const ref = new FlowSim(64); ref.seekTo(at, F);
  const sim = new FlowSim(64), clock = ticker();
  let slices = 0;
  while (!follow(sim, at, F, 3, clock)) { slices++; assert.ok(slices < 1000); }
  assert.ok(slices > 100, `took ${slices} slices: the budget did not bound the work`);
  assert.equal(sim.hash(), ref.hash());
  // behind the goal's epoch start or past it: reseeds, still the same state
  const back = new FlowSim(64); back.seekTo(at + 5, F);
  while (!follow(back, at, F, 3, clock));
  assert.equal(back.hash(), ref.hash());
});

test('FlowCheck: verdict only once the CPU reached the GPU tick and the GPU hash is in', () => {
  const F = demoSource(), at = RESEED_TICKS * 5 + 40;
  const ref = new FlowSim(32); ref.seekTo(at, F);
  const c = new FlowCheck(32), clock = ticker();
  c.start(at);
  let r = null, frames = 0;
  for (; frames < 5; frames++) r = c.step(at + frames, F, 2, clock);
  assert.equal(r, null); // CPU still behind, no GPU hash yet
  while (c.sim.tick !== at) assert.equal(c.step(at + frames++, F, 2, clock), null);
  assert.equal(c.step(at + frames, F, 2, clock), null); // there, but the readback has not landed
  c.gpuHash(at + 1, 123); // a stale hash for another tick is ignored
  assert.equal(c.step(at + frames, F, 2, clock), null);
  c.gpuHash(at, ref.hash());
  r = c.step(at + frames, F, 2, clock);
  assert.ok(r && r.gpu === r.cpu && r.cpu === ref.hash());
  assert.ok(r.worst <= 4, `worst slice ${r.worst}: 2 ms budget + the ticker clock counting its own reads`);
  assert.equal(c.busy, false);
  // no check pending: it follows the GPU tick
  c.step(at + 3, F, 100, clock);
  assert.equal(c.sim.tick, at + 3);
});
