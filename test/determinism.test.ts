import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SIN_LUT, fnv, FNV0, h32, hex8 } from '../src/core/math.ts';
import { demoSource } from '../src/core/demo.ts';
import { hashState, type SceneDef } from '../src/core/scene.ts';
import { radial } from '../src/core/scenes/radial.ts';
import { tunnel, RING } from '../src/core/scenes/tunnel.ts';
import { scope } from '../src/core/scenes/scope.ts';
import { flow, FlowSim } from '../src/core/scenes/flow.ts';
import { RESEED_TICKS, K_ONSET, LOOKBACK } from '../src/core/constants.ts';

const SCENES: SceneDef[] = [radial, tunnel, scope, flow];
const TICKS = [0, 1, 59, 600, 1799, 2276, 2306, 5000, 123456];

test('sine LUT and hash are pinned (catch engine or refactor drift)', () => {
  assert.equal(hex8(fnv(FNV0, SIN_LUT)), '42edcf5b');
  assert.equal(h32(1, 2), 2835814530);
  assert.equal(h32(-7, 0x7fffffff), 2352950105);
});

test('scene state is a pure function of (tick, features): order-independent hashes', () => {
  for (const sc of SCENES) {
    const fwd = TICKS.map((t) => hashState(sc.state(t, demoSource())));
    const F = demoSource(); // one shared, warm cache, visited in reverse
    const rev = [...TICKS].reverse().map((t) => hashState(sc.state(t, F))).reverse();
    assert.deepEqual(rev, fwd, sc.id);
  }
});

test('scene hashes are pinned', () => {
  const got = Object.fromEntries(SCENES.map((sc) => [sc.id, hex8(fnv(FNV0, TICKS.map((t) => hashState(sc.state(t, demoSource())))))]));
  assert.deepEqual(got, GOLDEN);
});

test('tunnel depth is continuous mod RING when an onset leaves the lookback window', () => {
  // Per tick, z should advance by the base speed plus the in-progress onset rushes only;
  // the onset that falls out of the window must contribute nothing mod RING.
  const F = demoSource(), T = 45, R = 2 * RING;
  const rush = (i: number) => { const t = Math.min(i, T); return ((R * t * t * (3 * T - 2 * t)) / (T * T * T)) | 0; };
  let checked = 0;
  for (let f = LOOKBACK; f < 4000; f++) {
    if (!F.get(f - LOOKBACK, K_ONSET)) continue; // onset at f-LOOKBACK drops out at f
    let inc = 64;
    for (let i = 0; i <= T; i++) if (F.get(f - i, K_ONSET)) inc += rush(i) - (i > 0 ? rush(i - 1) : 0);
    const a = tunnel.state(f - 1, F).u[0], b = tunnel.state(f, F).u[0];
    assert.equal((((b - a - inc) % RING) + RING) % RING, 0, `jump at ${f}`);
    checked++;
  }
  assert.ok(checked > 10);
});

test('flow sim: particles are independent and seeking is path-independent', () => {
  const F = demoSource(), t = RESEED_TICKS + 300;
  const big = new FlowSim(256), small = new FlowSim(64);
  big.seekTo(t, F);
  small.seekTo(t - 100, F); small.seekTo(t, F); // stepped in two hops
  assert.equal(big.hash(64), small.hash());
  const fresh = new FlowSim(64);
  fresh.seekTo(t + RESEED_TICKS, F); fresh.seekTo(t, F); // seek backwards -> reseed + replay
  assert.equal(fresh.hash(), small.hash());
});

test('flow sim hash is pinned', () => {
  const sim = new FlowSim(512);
  sim.seekTo(RESEED_TICKS * 2 + 450, demoSource());
  assert.equal(hex8(sim.hash()), GOLDEN_FLOW);
});

// Golden values from a known-good run. A change here means scene output changed on purpose
// (update deliberately) or determinism broke (don't).
const GOLDEN: Record<string, string> = { radial: 'a0bc1e47', tunnel: '91c3f9ad', scope: '3a3414b0', flow: '11563bcb' };
const GOLDEN_FLOW = 'cedfe7d5';

test('a tick-stamped hit acts as an onset on exactly that tick', async () => {
  const { EventLog, withEvents } = await import('../src/core/events.ts');
  const { silence } = await import('../src/core/features.ts');
  const log = new EventLog();
  log.add({ tick: 100, src: 2, type: 'hit' });
  const F = withEvents(silence, log);
  assert.equal(F.get(100, K_ONSET), 255);
  assert.equal(F.get(99, K_ONSET), 0);
  for (const sc of [radial, tunnel]) {
    assert.equal(hashState(sc.state(99, F)), hashState(sc.state(99, silence)), `${sc.id} before the hit`);
    assert.notEqual(hashState(sc.state(110, F)), hashState(sc.state(110, silence)), `${sc.id} after the hit`);
  }
});
