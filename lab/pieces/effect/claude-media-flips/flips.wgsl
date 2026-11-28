struct Fl {
  res: vec2f, time: f32, aspect: f32,
  cols: f32, rows: f32, gap: f32, flip: f32,
  bar_age: f32, bar_len: f32, base_cur: f32, base_prev: f32,  // seconds into this bar; the wipes' faces
  dir_cur: f32, dir_prev: f32, span: f32, n_ev: f32,           // the wipes' directions, how long one sweeps
  bass: f32, phase: f32, depth: f32, glow: f32,
  pal_n: f32, density: f32, wobble: f32, _b: f32,
  pal: array<vec4f, 8>,   // linear rgb
  ev: array<vec4f, 32>,   // hits, oldest first: age (s), seed, face + 8 * pattern, size 0..1
};
@group(0) @binding(0) var<uniform> U: Fl;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var src: texture_2d<f32>;

const FL_PI = 3.14159265;

fn fl_pal(x: f32) -> vec3f {
  let n = max(i32(U.pal_n), 1);
  let f = clamp(x, 0.0, 1.0) * f32(n - 1);
  let i = min(i32(floor(f)), n - 1);
  let j = min(i + 1, n - 1);
  return mix(U.pal[i].rgb, U.pal[j].rgb, f - f32(i));
}
fn fl_tap(uv: vec2f) -> vec3f { return textureSampleLevel(src, samp, uv, 0.0).rgb; }
fn fl_luma(c: vec3f) -> f32 { return dot(c, vec3f(0.2126, 0.7152, 0.0722)); }
fn fl_h(ij: vec2i, s: f32) -> f32 {
  return f32(h32((u32(ij.x) * 73856093u) ^ (u32(ij.y) * 19349663u), u32(s * 16777216.0)) >> 8u) / 16777216.0;
}

/** When a bar's wipe reaches tile centre q (0..1), seconds after the bar starts. */
fn fl_sweep(dir: f32, q: vec2f) -> f32 {
  let d = i32(dir);
  var t = q.x;
  if (d == 1) { t = q.y; }
  else if (d == 2) { t = min(length(q - 0.5) * 1.414, 1.0); }
  else if (d == 3) { t = (q.x + q.y) * 0.5; }
  return t * U.span;
}

/** Does hit e turn tile ij (centre q)? Its delay in seconds, or -1. */
fn fl_cover(e: vec4f, ij: vec2i, q: vec2f) -> f32 {
  let pat = i32(floor(e.z / 8.0));
  let h1 = fract(e.y * 13.17 + 0.3);
  let h2 = fract(e.y * 71.31 + 0.7);
  let amt = U.density * e.w;
  let a = U.aspect;
  if (pat == 0) {
    if (fl_h(ij, e.y) < 0.12 + 0.5 * amt) { return fl_h(ij, e.y + 0.5) * 0.15; }
    return -1.0;
  }
  if (pat == 1) {
    let dd = length((q - vec2f(0.15 + 0.7 * h1, 0.15 + 0.7 * h2)) * vec2f(a, 1.0));
    if (dd < 0.12 + 0.45 * amt) { return dd * 0.4; }
    return -1.0;
  }
  if (pat == 2) {
    if (abs(q.y - h1) < 0.06 + 0.22 * amt) { return select(1.0 - q.x, q.x, h2 > 0.5) * 0.3; }
    return -1.0;
  }
  if (pat == 3) {
    if (abs(q.x - h1) < 0.05 + 0.18 * amt) { return select(1.0 - q.y, q.y, h2 > 0.5) * 0.25; }
    return -1.0;
  }
  if (pat == 4) {
    let u = (q.x * a + select(q.y, 1.0 - q.y, h2 > 0.5)) / (a + 1.0);
    if (abs(u - h1) < 0.06 + 0.18 * amt) { return q.y * 0.25; }
    return -1.0;
  }
  if (((ij.x + ij.y) & 1) == i32(h1 * 2.0)) { return (q.x + q.y) * 0.2; }
  return -1.0;
}

/** The treatment a face shows at uv (t: -1..1 across the tile). */
fn fl_face(f: i32, uv: vec2f, t: vec2f, ij: vec2i, dims: vec2f) -> vec3f {
  let c = fl_tap(uv);
  let l = fl_luma(c);
  if (f == 1) { return fl_pal(l) * (0.25 + 1.3 * l); }
  if (f == 2) {
    let n = 5.0;
    let g = fract((t * 0.5 + 0.5) * n) - 0.5;
    let r = sqrt(clamp(l, 0.0, 1.0)) * 0.56;
    let dot_ = smoothstep(r, r - 0.08, length(g));
    return mix(fl_pal(0.06) * 0.4, fl_pal(0.72) * 1.3, dot_);
  }
  if (f == 3) {
    let px = 1.5 / U.res;
    let gx = fl_luma(fl_tap(uv + vec2f(px.x, 0.0))) - fl_luma(fl_tap(uv - vec2f(px.x, 0.0)));
    let gy = fl_luma(fl_tap(uv + vec2f(0.0, px.y))) - fl_luma(fl_tap(uv - vec2f(0.0, px.y)));
    let e = min(length(vec2f(gx, gy)) * 7.0, 2.0);
    return fl_pal(fract(0.55 + l * 0.4)) * e * 1.4 + c * 0.08;
  }
  if (f == 4) {
    let blk = min(floor((t * 0.5 + 0.5) * 4.0), vec2f(3.0));
    let m = fl_tap((vec2f(ij) + (blk + 0.5) / 4.0) / dims);
    let pst = floor(m * 4.0 + 0.5) / 4.0;
    return mix(pst, fl_pal(fl_luma(pst)) * 1.2, 0.3);
  }
  return c;
}

@fragment fn fs_flips(v: VOut) -> @location(0) vec4f {
  let uv = v.uv;
  let dims = vec2f(U.cols, U.rows);
  let cf = uv * dims;
  let ij = vec2i(min(floor(cf), dims - 1.0));
  let q = (vec2f(ij) + 0.5) / dims;
  let loc = (cf - vec2f(ij) - 0.5) * 2.0;

  // replay: the previous bar's wipe, its hits, this bar's wipe (once it has reached the tile), its hits
  let sc = U.bar_age - fl_sweep(U.dir_cur, q);
  let sp = U.bar_age + U.bar_len - fl_sweep(U.dir_prev, q);
  var face = U.base_prev;
  var prev = U.base_prev;
  var last = sp;
  var horiz = U.dir_prev == 1.0;
  var pending = sc >= 0.0;
  let n = i32(U.n_ev);
  for (var i = 0; i < n; i++) {
    let e = U.ev[i];
    let dl = fl_cover(e, ij, q);
    if (dl < 0.0) { continue; }
    let eff = e.x - dl;
    if (eff < 0.0 || eff >= sp) { continue; }
    if (pending && sc > eff) {
      pending = false;
      if (face != U.base_cur) { prev = face; face = U.base_cur; last = sc; horiz = U.dir_cur == 1.0; }
    }
    let pat = floor(e.z / 8.0);
    let ef = e.z - pat * 8.0;
    prev = face;
    face = select(0.0, ef, face == 0.0);
    last = eff;
    horiz = fract(e.y * 5.31) > 0.5;
  }
  if (pending && face != U.base_cur) { prev = face; face = U.base_cur; last = sc; horiz = U.dir_cur == 1.0; }

  // the turn: front shows the old face until edge-on, then the back (un-mirrored) the new one
  var pr = clamp(last / U.flip, 0.0, 1.0);
  if (prev == face) { pr = 1.0; }
  let ease = 1.0 - pow(1.0 - pr, 3.0);
  let phi = FL_PI * ease;
  var ang = phi;
  var shown = prev;
  if (phi > 0.5 * FL_PI) { ang = phi - FL_PI; shown = face; }
  // at rest the tiles still rock: a wave over the wall on every beat, and the bass tilts each one
  let sb = clamp((fract(U.phase) - (q.x + q.y) * 0.22) / 0.5, 0.0, 1.0);
  let checker = select(1.0, -1.0, ((ij.x + ij.y) & 1) == 1);
  ang += U.wobble * 0.3 * sin(FL_PI * sb) * checker + U.bass * 0.3 * (fl_h(ij, 0.77) - 0.5) * 2.0;
  let hs = 1.0 - U.gap;
  let lift = min(1.0 + 0.07 * U.bass + 0.16 * sin(phi), 1.0 / hs);
  var s = loc;
  if (horiz) { s = loc.yx; }
  let D = U.depth;
  let den = lift * D * cos(ang) - s.x * sin(ang);
  var col = fl_pal(0.05) * 0.3 + fl_tap(uv) * 0.05;
  if (den > 1e-3) {
    let X = s.x * D / den;
    let Y = s.y * (D + X * sin(ang)) / (lift * D);
    if (abs(X) <= hs && abs(Y) <= hs) {
      var t = vec2f(X, Y);
      if (horiz) { t = t.yx; }
      let tuv = (vec2f(ij) + 0.5 + t * 0.5) / dims;
      var c = fl_face(i32(shown), tuv, t / hs, ij, dims);
      c *= 0.5 + 0.5 * cos(ang);
      let turning = sin(phi);
      c += fl_pal(0.9) * U.glow * turning * 0.3;
      // edge: a bright bevel while turning, a dark line at rest
      let edge = hs - max(abs(X), abs(Y));
      let px = 2.0 * dims.y / U.res.y;
      let rim = 1.0 - smoothstep(0.0, 2.0 * px, edge);
      c = mix(c, fl_pal(0.85) * (0.6 + 1.5 * U.glow * turning), rim * (0.35 + 0.6 * turning));
      c *= 1.0 + 0.08 * pow(1.0 - fract(U.phase), 4.0);
      col = c;
    }
  }
  return vec4f(max(col, vec3f(0.0)), 1.0);
}
