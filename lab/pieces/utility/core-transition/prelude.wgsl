// Transition pass: mixes the outgoing (texA) and incoming (texB) HDR scenes into the scene
// target, before the post chain. This is the prelude every lab/transitions/<id>/mix.wgsl sees;
// src/core/transwgsl.ts appends the mixes (each in its own namespace) and `trans_mix`, a switch
// on T.kind (the registry index). Progress and every hashed input come from core/transitions.ts,
// so a mix only decides how it looks.

struct Trans {
  kind: u32,
  seed: u32,      // per transition, from the server
  roll: u32,      // re-roll index every 1/16 beat (with "uses": ["roll"], else 0)
  _p0: u32,
  p: f32,         // progress 0..1 (curve already applied)
  flash: f32,     // flash intensity 0..1, peaks at p = 0.25 (with "uses": ["flash"], else 0)
  aspect: f32,    // width / height
  time: f32,      // seconds (show time)
  center: vec2f,  // FX centre (pads), uv
  res: vec2f,     // target size in pixels
  bands: array<vec4f, 4>, // 16 smoothed bands 0..1
};
@group(0) @binding(0) var<uniform> T: Trans;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var texA: texture_2d<f32>;
@group(0) @binding(3) var texB: texture_2d<f32>;

/** The outgoing scene (HDR rgb) at uv, clamped to the edge. */
fn sa(uv: vec2f) -> vec3f { return textureSampleLevel(texA, samp, uv, 0.0).rgb; }
/** The incoming scene. */
fn sb(uv: vec2f) -> vec3f { return textureSampleLevel(texB, samp, uv, 0.0).rgb; }
/** 1 inside the unit square, else 0. */
fn inside(uv: vec2f) -> f32 { return select(0.0, 1.0, all(uv >= vec2f(0.0)) && all(uv <= vec2f(1.0))); }
/** Hashed 0..1 from two integers (seed with T.seed). */
fn rnd(a: u32, b: u32) -> f32 { return f32(h32(a, b) >> 8u) / 16777216.0; }
/** Band i (0..15), 0..1. */
fn bandv(i: u32) -> f32 { return T.bands[i / 4u][i % 4u]; }
/** The spectrum at x (0 = bass .. 1 = treble), interpolated. */
fn band(x: f32) -> f32 {
  let f = clamp(x, 0.0, 1.0) * 15.0;
  let i = u32(floor(f));
  return mix(bandv(i), bandv(min(i + 1u, 15u)), fract(f));
}
fn rot(d: vec2f, a: f32) -> vec2f { let c = cos(a); let s = sin(a); return vec2f(d.x * c - d.y * s, d.x * s + d.y * c); }

@fragment fn fs_trans(in: VOut) -> @location(0) vec4f {
  return vec4f(trans_mix(in.uv), 1.0);
}
