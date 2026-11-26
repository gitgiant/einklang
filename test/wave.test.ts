import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decimateWave, fileSource, mapSource } from '../src/core/features.ts';
import { STRIDE, WAVE_BYTES, WAVE_N } from '../src/core/constants.ts';
import { scope } from '../src/core/scenes/scope.ts';
import { hashState } from '../src/core/scene.ts';

test('waveform blocks: decimation, file and live sources, scope uses them', () => {
  const L = Float32Array.from({ length: 1600 }, (_, i) => Math.sin(i / 20)), R = L.map((x) => -x * 2);
  const frames = 2, buf = new Uint8Array(frames * (STRIDE + WAVE_BYTES));
  buf[STRIDE + 17] = 255; // onset on tick 1
  decimateWave(L, R, 0, 800, buf, frames * STRIDE);
  decimateWave(L, R, 800, 800, buf, frames * STRIDE + WAVE_BYTES);
  const F = fileSource(buf, frames), w = F.wave(1)!;
  assert.equal(w.length, WAVE_BYTES);
  assert.equal(w[0], Math.round(Math.sin(800 / 20) * 127));
  assert.equal(w[1], Math.sign(-Math.sin(800 / 20)) * 127); // clipped
  assert.equal(F.wave(2), null);
  assert.equal(F.get(1, 17), 255);
  assert.equal(fileSource(buf.subarray(0, frames * STRIDE), frames).wave(0), null, 'features-only track');

  const live = new Map([[5, buf.slice(STRIDE, 2 * STRIDE + 0)], [6, Uint8Array.from([...buf.subarray(0, STRIDE), ...buf.subarray(frames * STRIDE, frames * STRIDE + WAVE_BYTES)])]]);
  const M = mapSource(live);
  assert.equal(M.wave(5), null);
  assert.equal(M.wave(6)![2], F.wave(0)![2]);
  assert.equal(M.get(6, STRIDE), 0, 'wave bytes never read as input keys');
  assert.notEqual(hashState(scope.state(6, M)), hashState(scope.state(5, M)));
  assert.equal(WAVE_N * 2, WAVE_BYTES);
});
