// Display-list renderer: one instanced quad per primitive, analytic SDF coverage.
// The list buffer is the raw Int32Array from core/prims.ts (8 ints per primitive).

struct View {
  res: vec2f,     // target size in px
  off: vec2f,     // letterbox offset in px
  scale: f32,     // px per virtual unit
  gain: f32,      // HDR intensity multiplier
  _pad: vec2f,
};
@group(0) @binding(0) var<uniform> view: View;
@group(0) @binding(1) var<storage, read> L: array<i32>;

struct POut {
  @builtin(position) pos: vec4f,
  @location(0) p: vec2f,
  @location(1) @interpolate(flat) idx: u32,
};

const VW = 1280.0;
const VH = 720.0;

@vertex fn vs_prim(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> POut {
  let b = ii * 8u;
  let op = L[b];
  let a = vec2f(f32(L[b + 1u]), f32(L[b + 2u]));
  let c = f32(L[b + 3u]);
  let d = f32(L[b + 4u]);
  let w = f32(L[b + 7u]);
  let pad = 2.0 / view.scale + 1.0;
  var lo = vec2f(0.0);
  var hi = vec2f(VW, VH);
  if (op == 1) { lo = a - c - pad; hi = a + c + pad; }
  else if (op == 2) { lo = a - c - w * 0.5 - pad; hi = a + c + w * 0.5 + pad; }
  else if (op == 3) { let e = vec2f(c, d); lo = min(a, e) - w * 0.5 - pad; hi = max(a, e) + w * 0.5 + pad; }
  var corners = array<vec2f, 6>(vec2f(0, 0), vec2f(1, 0), vec2f(0, 1), vec2f(0, 1), vec2f(1, 0), vec2f(1, 1));
  let corner = corners[vi];
  let p = mix(lo, hi, corner);
  let px = p * view.scale + view.off;
  var o: POut;
  o.pos = vec4f(px.x / view.res.x * 2.0 - 1.0, 1.0 - px.y / view.res.y * 2.0, 0.0, 1.0);
  o.p = p;
  o.idx = ii;
  return o;
}

fn seg_dist(p: vec2f, a: vec2f, b: vec2f) -> f32 {
  let pa = p - a;
  let ba = b - a;
  let h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-6), 0.0, 1.0);
  return length(pa - ba * h);
}

@fragment fn fs_prim(in: POut) -> @location(0) vec4f {
  let b = in.idx * 8u;
  let op = L[b];
  let a = vec2f(f32(L[b + 1u]), f32(L[b + 2u]));
  let c = f32(L[b + 3u]);
  let w = max(f32(L[b + 7u]), 1.0);
  var dist = -1.0;
  if (op == 1) { dist = length(in.p - a) - c; }
  else if (op == 2) { dist = abs(length(in.p - a) - c) - w * 0.5; }
  else if (op == 3) { dist = seg_dist(in.p, a, vec2f(c, f32(L[b + 4u]))) - w * 0.5; }
  let cover = clamp(0.5 - dist * view.scale, 0.0, 1.0);
  let alpha = cover * clamp(f32(L[b + 6u]) / 255.0, 0.0, 1.0);
  if (alpha <= 0.0) { discard; }
  let gain = select(view.gain, 1.0, op == 0);
  return vec4f(rgb_of(L[b + 5u]) * gain * alpha, alpha);
}
