// Curl-noise flow field. Particles live in 16.16 fixed point and step once per tick with i32
// math only, so every GPU produces the same bits. This file is the CPU reference; flow.wgsl
// mirrors it line for line, and the gallery compares the two hashes on real hardware.
import { W, H, K_RMS, K_ONSET, RESEED_TICKS } from '../constants.ts';
import { derive, type FeatureSource } from '../features.ts';
import { h32 } from '../math.ts';
import type { SceneDef } from '../scene.ts';

export const FX = 16, WF = W << FX, HF = H << FX;
const H_OFF = 8 << FX, VMAX = 24 << FX;

/** Per-step params, also the WGSL uniform layout: [tick, seed, speedK, push, cx, cy, 0, 0] */
export const STEP_U = 8;

export const epochOf = (tick: number): number => Math.floor(tick / RESEED_TICKS);
export const seedOf = (epoch: number): number => h32(epoch, 0x5eed) | 0;

export function stepParams(t: number, F: FeatureSource): Int32Array {
  let age = 99;
  for (let i = 0; i < 12; i++) if (F.get(t - i, K_ONSET)) { age = i; break; }
  return Int32Array.of(t, seedOf(epochOf(t)), 8 + (F.get(t, K_RMS) >> 2), age < 12 ? (12 - age) * 4 : 0, W >> 1, H >> 1, 0, 0);
}

const fade = (t: number) => (t * t * (768 - 2 * t)) >> 16;
const lerp = (a: number, b: number, t: number) => a + (((b - a) * t) >> 8);
const lat = (ix: number, iy: number, layer: number) =>
  (h32(Math.imul(ix, 73856093) ^ Math.imul(iy, 19349663), layer) & 0xffff) - 32768;

function pot(x: number, y: number, layer: number): number {
  const ix = x >> 23, iy = y >> 23; // 128 px cells
  const sx = fade((x >> 15) & 255), sy = fade((y >> 15) & 255);
  const a = lerp(lat(ix, iy, layer), lat(ix + 1, iy, layer), sx);
  const b = lerp(lat(ix, iy + 1, layer), lat(ix + 1, iy + 1, layer), sx);
  return lerp(a, b, sy);
}

function psi(x: number, y: number, tick: number, seed: number): number {
  const layer = (tick >> 8) + seed, tf = fade(tick & 255);
  return lerp(pot(x, y, layer | 0), pot(x, y, (layer + 1) | 0), tf);
}

/** Advance one particle in place. p = [x, y, vx, vy] at offset o. */
export function stepParticle(p: Int32Array, o: number, u: Int32Array): void {
  const [tick, seed, speedK, push, cx, cy] = u;
  let x = p[o], y = p[o + 1], vx = p[o + 2], vy = p[o + 3];
  const dy = psi(x, y + H_OFF, tick, seed) - psi(x, y - H_OFF, tick, seed);
  const dx = psi(x + H_OFF, y, tick, seed) - psi(x - H_OFF, y, tick, seed);
  vx += (dy * speedK - vx) >> 3;
  vy += (-dx * speedK - vy) >> 3;
  // onset swirl around the center
  if (push > 0) { vx -= ((y >> FX) - cy) * push * 4; vy += ((x >> FX) - cx) * push * 4; }
  vx = Math.min(VMAX, Math.max(-VMAX, vx)); vy = Math.min(VMAX, Math.max(-VMAX, vy));
  x = (x + vx) | 0; y = (y + vy) | 0;
  if (x < 0) x += WF; else if (x >= WF) x -= WF;
  if (y < 0) y += HF; else if (y >= HF) y -= HF;
  p[o] = x; p[o + 1] = y; p[o + 2] = vx; p[o + 3] = vy;
}

export function seedParticle(p: Int32Array, i: number, seed: number): void {
  p[i * 4] = h32(seed, i * 2) % WF; p[i * 4 + 1] = h32(seed, i * 2 + 1) % HF; p[i * 4 + 2] = 0; p[i * 4 + 3] = 0;
}

/** Order-independent hash: wrapping sum of per-particle hashes (matches the GPU atomicAdd). */
export function particleHash(p: Int32Array, n: number): number {
  let s = 0;
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    s = (s + h32(h32(i ^ p[o], p[o + 1]), p[o + 2] ^ Math.imul(p[o + 3], 31))) >>> 0;
  }
  return s;
}

/** CPU flow sim. Each particle is independent, so the first n of a bigger sim match exactly. */
export class FlowSim {
  readonly n: number;
  readonly p: Int32Array;
  tick = -1;
  constructor(n: number) { this.n = n; this.p = new Int32Array(n * 4); }
  /** Reseed to the start of the epoch containing `tick` and step forward to it. */
  seekTo(tick: number, F: FeatureSource, maxSteps = Infinity): boolean {
    const e0 = epochOf(tick) * RESEED_TICKS;
    if (this.tick < e0 || this.tick > tick) {
      const seed = seedOf(epochOf(tick));
      for (let i = 0; i < this.n; i++) seedParticle(this.p, i, seed);
      this.tick = e0;
    }
    for (let s = 0; this.tick < tick && s < maxSteps; s++) {
      const u = stepParams(++this.tick, F);
      for (let i = 0; i < this.n; i++) stepParticle(this.p, i * 4, u);
    }
    return this.tick === tick;
  }
  hash(n = this.n): number { return particleHash(this.p, n); }
}

/** u layout for rendering: [tick, hue, E, lastOnsetAge, epoch] (the sim itself lives on the GPU). */
export const flow: SceneDef = {
  id: 'flow',
  name: 'Curl-noise flow field',
  state(f, F) {
    const { E, onsets, lastOnsetAge } = derive(F, f);
    return { u: Int32Array.of(f, f + onsets * 96, E, lastOnsetAge, epochOf(f)), prims: null };
  },
};
