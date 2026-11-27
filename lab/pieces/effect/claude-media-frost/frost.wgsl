// Media frost: dendritic crystal growth seeded on the picture's edges. Every crystal grows from
// tips: a tip cell advances one cell along its heading (Bresenham-style, so any angle runs straight
// on the grid), wanders a little, steers along the picture's contours and now and then splits off a
// side branch at 60 degrees; a branch stops where it would touch another (crowding), so the frost
// stays feathery. A nucleus sends out six arms. A cell keeps the picture's colour as it freezes, so
// the frost redraws the picture in ice. Gather form: an empty cell checks its eight neighbours'
// tips, which make the same hashed decisions, so no scatter is needed.
// Group 0: uniforms (one block per substep, dynamic offset), sampler, the state (x: 0 empty, 1 ice,
// 2 tip, 3 nucleus; y heading in turns; z beat it froze, mod 64; w colony hue) and the ice colour
// (rgb, a = the tip's sideways error), both rgba16f; group 1: the media (picture, luma, edges).

struct U {
  grid: vec2f, aspect: f32, beat: f32,
  rate: f32, branch: f32, along: f32, wiggle: f32,
  seedp: f32, thr: f32, melt: f32, seed: f32,
  show: f32, tint: f32, sparkle: f32, glow: f32,
  flash: f32, rms: f32, shift: f32, pal_n: f32,
  hi: f32, t: f32, idle_seed: f32, mist: f32,
  pal: array<vec4f, 8>,
};
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var fa: texture_2d<f32>;
@group(0) @binding(3) var fb: texture_2d<f32>;
@group(1) @binding(0) var pic: texture_2d<f32>;
@group(1) @binding(1) var lum: texture_2d<f32>;
@group(1) @binding(2) var edg: texture_2d<f32>;

const TAU = 6.2831853;
fn gsz() -> vec2i { return vec2i(u.grid); }
fn inb(c: vec2i) -> bool { return all(c >= vec2i(0)) && all(c < gsz()); }
fn la(c: vec2i) -> vec4f { if (!inb(c)) { return vec4f(0.0); } return textureLoad(fa, c, 0); }
fn lc(c: vec2i) -> vec4f { return textureLoad(fb, clamp(c, vec2i(0), gsz() - 1), 0); }
fn rnd(c: vec2i, s: u32) -> f32 { return f32(h32(bitcast<u32>(c.x) * 4099u + bitcast<u32>(c.y), s) >> 8u) / 16777216.0; }

// the next cell along heading `a` (radians) from a tip with sideways error `err`: of the neighbours
// within 60 degrees of the heading, the one that keeps the path closest to the ideal line
struct Step { o: vec2i, e: f32 };
fn step_of(a: f32, err: f32) -> Step {
  let d = vec2f(cos(a), sin(a));
  var best = Step(vec2i(0), 0.0);
  var bs = 1e9;
  for (var dy = -1; dy <= 1; dy++) {
    for (var dx = -1; dx <= 1; dx++) {
      if (dx == 0 && dy == 0) { continue; }
      let ov = vec2f(f32(dx), f32(dy));
      let dp = dot(ov, d) / length(ov);
      if (dp < 0.5) { continue; }
      let e = err + (ov.x * d.y - ov.y * d.x);
      let sc = abs(e) - 0.02 * dp;
      if (sc < bs) { bs = sc; best = Step(vec2i(dx, dy), e); }
    }
  }
  return best;
}

struct O { @location(0) a: vec4f, @location(1) c: vec4f };

// ---- one growth step (fa = state, fb = ice colour)
@fragment fn fs_grow(v: VOut) -> O {
  let c = vec2i(v.pos.xy);
  let s = la(c);
  let seed = u32(u.seed);
  if (s.x > 0.5) {
    // a tip that advanced (or a nucleus that sent out its arms) turns to plain ice
    var x = 1.0;
    if (s.x > 1.5 && s.x < 2.5 && rnd(c, seed) >= u.rate) { x = 2.0; }
    // ice thaws (thin parts first) with `melt` and at the phrase start
    var n4 = 0.0;
    n4 += step(0.5, la(c + vec2i(1, 0)).x) + step(0.5, la(c - vec2i(1, 0)).x) + step(0.5, la(c + vec2i(0, 1)).x) + step(0.5, la(c - vec2i(0, 1)).x);
    if (rnd(c, seed ^ 0x6d6du) < u.melt * (1.5 - 0.3 * n4)) { return O(vec4f(0.0), vec4f(0.0)); }
    return O(vec4f(x, s.y, s.z, s.w), lc(c));
  }

  let uv = (vec2f(c) + 0.5) / u.grid;
  let e = textureSampleLevel(edg, samp, uv, 0.0).xy;
  let el = length(e);
  // which neighbouring tip (or nucleus) grows into this cell?
  var got = false;
  var ang = 0.0;
  var err = 0.0;
  var hue = 0.0;
  var parent = vec2i(0);
  var crowd = 0.0;
  for (var dy = -1; dy <= 1; dy++) {
    for (var dx = -1; dx <= 1; dx++) {
      if (dx == 0 && dy == 0) { continue; }
      let n = c + vec2i(dx, dy);
      let sn = la(n);
      if (sn.x < 0.5) { continue; }
      crowd += 1.0;
      if (got) { continue; }
      let a = sn.y * TAU;
      if (sn.x > 2.5) {
        for (var k = 0; k < 6; k++) {
          let ak = a + f32(k) * TAU / 6.0;
          if (all(n + step_of(ak, 0.0).o == c)) { got = true; ang = ak; err = 0.0; hue = sn.w; parent = n; }
        }
      } else if (sn.x > 1.5 && rnd(n, seed) < u.rate) {
        let st = step_of(a, lc(n).a);
        if (all(n + st.o == c)) { got = true; ang = a; err = st.e; hue = sn.w; parent = n; }
        if (!got && rnd(n, seed ^ 0x5151u) < u.branch) {
          let sa = a + select(-1.0, 1.0, rnd(n, seed ^ 0x7777u) < 0.5) * TAU / 6.0;
          if (all(n + step_of(sa, 0.0).o == c)) { got = true; ang = sa; err = 0.0; hue = sn.w; parent = n; }
        }
      }
    }
  }
  if (got && crowd <= 2.0) {
    // wander a little and steer along the picture's contours
    let d = vec2f(cos(ang), sin(ang));
    var t = vec2f(-e.y, e.x) / max(el, 1e-4);
    if (dot(t, d) < 0.0) { t = -t; }
    let turn = (rnd(c, seed ^ 0x2222u) - 0.5) * u.wiggle * 0.9 + u.along * smoothstep(0.03, 0.3, el) * 0.35 * (d.x * t.y - d.y * t.x);
    let col = max(textureSampleLevel(pic, samp, uv, 0.0).rgb, vec3f(0.0));
    return O(vec4f(2.0, fract((ang + turn) / TAU), u.beat, hue), vec4f(col, err));
  }
  // nuclei on the picture's strong edges (bursts on onsets, a few on silence, a few anywhere)
  let onEdge = step(u.thr, el) * min(el, 2.0);
  if (crowd < 0.5 && rnd(c, seed ^ 0xa5a5u) < u.seedp * (onEdge + 0.004) + u.idle_seed * onEdge) {
    let col = max(textureSampleLevel(pic, samp, uv, 0.0).rgb, vec3f(0.0));
    return O(vec4f(3.0, rnd(c, seed ^ 0x1234u), u.beat, rnd(c, seed ^ 0x3c3cu)), vec4f(col, 0.0));
  }
  return O(vec4f(0.0), vec4f(0.0));
}

fn lab2lin(c: vec3f) -> vec3f {
  let l_ = c.x + 0.3963377774 * c.y + 0.2158037573 * c.z;
  let m_ = c.x - 0.1055613458 * c.y - 0.0638541728 * c.z;
  let s_ = c.x - 0.0894841775 * c.y - 1.291485548 * c.z;
  return max(vec3f(0.0), vec3f(4.0767416621 * l_ * l_ * l_ - 3.3077115913 * m_ * m_ * m_ + 0.2309699292 * s_ * s_ * s_,
    -1.2684380046 * l_ * l_ * l_ + 2.6097574011 * m_ * m_ * m_ - 0.3413193965 * s_ * s_ * s_,
    -0.0041960863 * l_ * l_ * l_ - 0.7034186147 * m_ * m_ * m_ + 1.707614701 * s_ * s_ * s_));
}
fn pal(x: f32) -> vec3f {
  let n = max(i32(u.pal_n), 1);
  let f = (1.0 - abs(fract(x * 0.5) * 2.0 - 1.0)) * f32(n - 1);
  let i = min(i32(floor(f)), n - 1);
  let j = min(i + 1, n - 1);
  return lab2lin(mix(u.pal[i].xyz, u.pal[j].xyz, f - f32(i)));
}
fn luma(c: vec3f) -> f32 { return dot(c, vec3f(0.2126, 0.7152, 0.0722)); }

// ---- draw (fa = state, fb = ice colour)
@fragment fn fs_draw(v: VOut) -> @location(0) vec4f {
  let uv = v.uv;
  let gp = uv * u.grid - 0.5;
  let c0 = vec2i(floor(gp + 0.5));
  // the crystal under this pixel, thickened a little: the nearest frozen cell within reach
  var best = 1e9;
  var s = vec4f(0.0);
  var ic = vec3f(0.0);
  var tipNear = 0.0;
  for (var dy = -1; dy <= 1; dy++) {
    for (var dx = -1; dx <= 1; dx++) {
      let n = c0 + vec2i(dx, dy);
      let sn = la(n);
      if (sn.x < 0.5) { continue; }
      let d = length(vec2f(n) - gp);
      if (sn.x > 1.5) { tipNear = max(tipNear, 1.0 - d * 0.6); }
      if (d < best) { best = d; s = sn; ic = lc(n).rgb; }
    }
  }
  let px = u.grid.y / 1080.0; // about a pixel at 1080p, in cells: keeps thin lines from aliasing
  let f = 1.0 - smoothstep(0.55, 0.95 + px, best);
  let rim = smoothstep(0.25, 0.75, best) * f;

  let live = max(textureSampleLevel(pic, samp, uv, 0.0).rgb, vec3f(0.0));
  let l = luma(live);
  // the bare picture under the frost: cold, dim, a faint haze
  let cold = pal(u.shift + 0.1);
  var col = mix(vec3f(l) * (cold * 1.3 + 0.15), live, 0.35) * u.show;
  col += cold * u.mist * (0.03 + 0.05 * u.rms);

  // the ice: the picture's colour where it froze, the colony's palette tint, fresh growth glowing
  let age = fract((u.beat - s.z) / 64.0) * 64.0;
  let fresh = exp(-age * 1.8);
  var ice = ic * (1.15 + 0.4 * u.flash) + pal(u.shift + 0.3 + s.w * 0.6) * u.tint * (0.4 + 0.8 * luma(ic));
  ice *= 0.8 + 0.2 * cos(age * TAU);
  ice += mix(vec3f(0.85, 0.93, 1.0), pal(u.shift + 0.8), 0.3) * (fresh * (0.45 + 1.2 * u.flash) + clamp(tipNear, 0.0, 1.0) * 0.6);
  col = mix(col, ice, f);
  col += pal(u.shift + 0.75) * rim * (0.2 + 0.6 * u.flash + 0.3 * u.hi);

  // glints twinkling on the ice with the highs
  let gc = vec2i(floor(v.pos.xy / 3.0));
  let tw = step(0.985, rnd(gc, u32(u.beat * 4.0) + 77u)) * f;
  col += vec3f(1.0, 0.97, 0.9) * tw * u.sparkle * (0.3 + 2.0 * u.hi);
  return vec4f(max(col, vec3f(0.0)) * u.glow, 1.0);
}
