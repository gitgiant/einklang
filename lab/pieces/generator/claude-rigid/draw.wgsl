// Backdrop: a dim wall with a faint grid, a floor with a lit edge, light pools and shock rings where
// the kicks hit. Bodies: one instanced quad per body and layer (instance / N: 0 = floor reflection,
// 1 = soft shadow, 2 = the body), shaded from their SDF: bevelled crates with an inset panel line,
// shaded balls with a stripe that shows them roll, a flash when hit, and a see-through glowing
// outline while they fly back to their slot. Premultiplied alpha.

struct Draw {
  center: vec2f, vh: f32, aspect: f32,   // camera centre (world), view height (world units), w/h
  px: f32, time: f32, glow: f32, bg: f32,
  shift: f32, pal_n: f32, bass: f32, n: f32,
  reflect: f32, kick: f32, _a: f32, _b: f32,
  kicks: array<vec4f, 4>,                 // x, age (s), amp
  pal: array<vec4f, 8>,
};
struct Inst { pos: vec2f, ang: f32, shape: f32, half: vec2f, tone: f32, glow: f32, ghost: f32, hold: f32, _a: f32, _b: f32 };
@group(0) @binding(0) var<uniform> dr: Draw;
@group(0) @binding(1) var<storage, read> B: array<Inst>;

fn lab2lin(c: vec3f) -> vec3f {
  let l_ = c.x + 0.3963377774 * c.y + 0.2158037573 * c.z;
  let m_ = c.x - 0.1055613458 * c.y - 0.0638541728 * c.z;
  let s_ = c.x - 0.0894841775 * c.y - 1.291485548 * c.z;
  let l = l_ * l_ * l_;
  let m = m_ * m_ * m_;
  let s = s_ * s_ * s_;
  return max(vec3f(0.0), vec3f(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s));
}

fn pal(x: f32) -> vec3f {
  let n = max(i32(dr.pal_n), 1);
  let f = clamp(x, 0.0, 1.0) * f32(n - 1);
  let i = min(i32(floor(f)), n - 1);
  let j = min(i + 1, n - 1);
  return lab2lin(mix(dr.pal[i].xyz, dr.pal[j].xyz, f - f32(i)));
}

fn rot(v: vec2f, a: f32) -> vec2f {
  let c = cos(a);
  let s = sin(a);
  return vec2f(v.x * c - v.y * s, v.x * s + v.y * c);
}

fn uv2world(uv: vec2f) -> vec2f {
  return dr.center + vec2f((uv.x - 0.5) * dr.vh * dr.aspect, (0.5 - uv.y) * dr.vh);
}

@fragment fn fs_bg(v: VOut) -> @location(0) vec4f {
  let w = uv2world(v.uv);
  let lift = 0.85 + 0.45 * dr.bass + 0.3 * dr.kick;
  var col: vec3f;
  if (w.y >= 0.0) {
    let c = (w - vec2f(0.0, 0.35)) * vec2f(0.8, 1.2);
    col = mix(pal(0.0), pal(0.14), exp(-dot(c, c) * 2.0));
    let g = abs(fract(w / 0.1) - 0.5);
    col += pal(0.3) * smoothstep(0.47, 0.5, max(g.x, g.y)) * 0.05;
  } else {
    col = mix(pal(0.08), pal(0.0), clamp(-w.y * 4.0, 0.0, 1.0));
  }
  col *= dr.bg * lift;
  // the floor edge and the kicks: a light pool and a ring running out along the floor
  let edge = 1.0 - smoothstep(0.0, 2.0 * dr.px, abs(w.y));
  col += pal(0.65) * edge * (0.35 + 0.6 * dr.kick) * dr.bg;
  for (var k = 0; k < 4; k++) {
    let kk = dr.kicks[k];
    if (kk.z <= 0.0) { continue; }
    let age = kk.y;
    let d = length(vec2f(w.x - kk.x, w.y * 2.5));
    let fade = exp(-age * 2.5) * min(kk.z / 2.0, 1.5);
    col += pal(0.9) * exp(-d * d * 30.0) * exp(-age * 6.0) * fade * 0.8;
    let r = age * 1.6;
    col += pal(0.95) * exp(-pow((d - r) / (0.008 + 0.02 * age), 2.0)) * fade * 0.6 * step(abs(w.y), 0.12);
  }
  return vec4f(col, 1.0);
}

struct BOut {
  @builtin(position) pos: vec4f,
  @location(0) q: vec2f,                     // body-frame position
  @location(1) @interpolate(flat) id: u32,
  @location(2) @interpolate(flat) mode: u32,
  @location(3) wy: f32,                       // world y (for the reflection fade)
};

@vertex fn vs_body(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> BOut {
  var corners = array<vec2f, 6>(vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(-1.0, 1.0), vec2f(-1.0, 1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0));
  let n = u32(dr.n);
  let mode = ii / n;
  let id = ii % n;
  let b = B[id];
  let margin = select(0.03, 0.05, mode == 1u);
  let q = corners[vi] * (b.half + vec2f(margin));
  var w = b.pos + rot(q, b.ang);
  if (mode == 0u) { w.y = -w.y; }
  if (mode == 1u) { w += vec2f(0.016, -0.012); }
  var o: BOut;
  let c = (w - dr.center) / dr.vh;
  o.pos = vec4f(c.x * 2.0 / dr.aspect, c.y * 2.0, 0.0, 1.0);
  o.q = q;
  o.id = id;
  o.mode = mode;
  o.wy = w.y;
  return o;
}

fn sd_box(p: vec2f, h: vec2f, r: f32) -> f32 {
  let d = abs(p) - h + vec2f(r);
  return length(max(d, vec2f(0.0))) + min(max(d.x, d.y), 0.0) - r;
}

fn sd_body(b: Inst, q: vec2f) -> f32 {
  if (b.shape > 0.5) { return length(q) - b.half.x; }
  return sd_box(q, b.half, min(0.008, min(b.half.x, b.half.y) * 0.35));
}

@fragment fn fs_body(v: BOut) -> @location(0) vec4f {
  let b = B[v.id];
  let d = sd_body(b, v.q);
  let aa = dr.px * 1.2;
  let cov = 1.0 - smoothstep(-aa, aa, d);
  if (v.mode == 1u) {
    // soft shadow on the wall behind
    let a = (1.0 - smoothstep(-0.012, 0.03, d)) * 0.45 * (1.0 - 0.6 * b.ghost);
    return vec4f(0.0, 0.0, 0.0, a);
  }
  let L = normalize(vec3f(-0.45, 0.75, 0.55));
  let base = pal(b.tone + dr.shift);
  var col: vec3f;
  if (b.shape > 0.5) {
    // a shaded ball with a stripe along its own y axis, so it shows rolling
    let s = rot(v.q, b.ang) / b.half.x;
    let z = sqrt(max(0.0, 1.0 - dot(s, s)));
    let N = vec3f(s, z);
    let stripe = 1.0 - smoothstep(0.18, 0.24, abs(v.q.x / b.half.x));
    let tint = mix(base, pal(b.tone + dr.shift + 0.15) * 1.3, stripe * 0.7);
    let diff = max(dot(N, L), 0.0);
    let spec = pow(max(dot(reflect(-L, N), vec3f(0.0, 0.0, 1.0)), 0.0), 30.0);
    col = tint * (0.3 + 0.85 * diff) + pal(1.0) * spec * 0.9;
  } else {
    // a bevelled crate: the SDF gradient gives the bevel normal, an inset line draws the panel
    let e = 0.0015;
    let g = vec2f(sd_body(b, v.q + vec2f(e, 0.0)) - sd_body(b, v.q - vec2f(e, 0.0)), sd_body(b, v.q + vec2f(0.0, e)) - sd_body(b, v.q - vec2f(0.0, e)));
    let gw = rot(normalize(g + vec2f(1e-6)), b.ang);
    let bw = 0.01;
    let t = clamp(-d / bw, 0.0, 1.0);
    let N = normalize(vec3f(gw * (1.0 - t), 0.35 + t));
    let diff = max(dot(N, L), 0.0);
    let inset = min(b.half.x, b.half.y) * 0.3;
    let line = (1.0 - smoothstep(0.0, aa * 1.5, abs(d + inset) - 0.0012)) * step(0.03, min(b.half.x, b.half.y));
    let up = rot(v.q, b.ang).y / max(b.half.x, b.half.y);
    col = base * (0.35 + 0.8 * diff) * (0.92 + 0.12 * up) * (1.0 - 0.45 * line);
  }
  col *= dr.glow;
  // hit flash and rim
  let rim = 1.0 - smoothstep(0.0, 0.012, -d);
  col += pal(0.97) * b.glow * (0.35 + 0.9 * rim);
  // a halo around hit bodies, added on top (alpha 0)
  let halo = pal(0.95) * b.glow * exp(-max(d, 0.0) * 60.0) * 0.5 * (1.0 - cov);
  var outc = vec4f(col * cov + halo, cov);
  if (b.ghost > 0.5) {
    // flying home: see-through, with a glowing outline
    let outline = 1.0 - smoothstep(0.0, aa * 2.0, abs(d) - 0.002);
    let a = 0.4 * cov;
    outc = vec4f(col * a + pal(0.92) * outline * 1.2 + halo, a);
  }
  if (v.mode == 0u) {
    // the floor reflection: dim, fading with depth
    let fade = exp(v.wy * 7.0) * dr.reflect * 0.35;
    outc = vec4f(outc.rgb * fade, outc.a * fade);
  }
  return outc;
}
