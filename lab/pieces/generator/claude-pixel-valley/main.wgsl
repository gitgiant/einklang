// Pixel valley: parallax landscape on a low-res grid.

// per mood: sky top, horizon, sun top, sun bottom, far range, near range, trees, cloud, water
var<private> MOOD: array<u32, 36> = array<u32, 36>(
  0x2b2d6eu, 0xf7a072u, 0xfff3b0u, 0xff6f59u, 0x8a6fa8u, 0x3a2a5cu, 0x140f24u, 0xffd1dcu, 0x3b3f8au,  // dawn
  0x2f7de1u, 0xa6e3ffu, 0xffffe0u, 0xffe066u, 0x7fb2d9u, 0x3d7a4fu, 0x1f4d2cu, 0xffffffu, 0x2b6cb0u,  // day
  0x1b0b3au, 0xff4f8bu, 0xffe66du, 0xff2a6du, 0x7b3fa0u, 0x3a1450u, 0x12062au, 0xff9ecfu, 0x2a1060u,  // dusk
  0x050816u, 0x1c2a5au, 0xf4f1deu, 0xc9c5b0u, 0x24305eu, 0x141b3au, 0x070a18u, 0x39407au, 0x0b1230u   // night
);

fn mc(k: u32) -> vec3f {
  let m = min(u32(p_mood()), 3u);
  let c = MOOD[m * 9u + k];
  let s = vec3f(f32((c >> 16u) & 255u), f32((c >> 8u) & 255u), f32(c & 255u)) / 255.0;
  return pow(s, vec3f(2.2));
}

fn h1(x: f32) -> f32 { return fract(sin(x * 127.1) * 43758.5453); }
fn h2(a: f32, b: f32) -> f32 { return fract(sin(a * 127.1 + b * 311.7) * 43758.5453); }
fn vn(x: f32) -> f32 {
  let i = floor(x);
  let f = x - i;
  return mix(h1(i), h1(i + 1.0), f * f * (3.0 - 2.0 * f));
}
fn fbm(x: f32) -> f32 { return 0.6 * vn(x) + 0.28 * vn(x * 2.1 + 7.0) + 0.12 * vn(x * 4.3 + 3.0); }

// spectrum level at a screen x 0..1, interpolated between the 16 bands
fn spec(x: f32) -> f32 {
  let f = clamp(x, 0.0, 1.0) * 15.0;
  let i = i32(floor(f));
  return mix(band(i), band(i + 1), f - floor(f));
}

const HORIZON = 0.66;

struct Env { jump: f32, sx: f32, sy: f32, sr: f32, t: f32 };

fn env() -> Env {
  var e: Env;
  e.jump = p_bounce() * bass() + p_kick() * 0.8;
  e.t = time() * p_speed();
  e.sx = aspect() * 0.62;
  e.sr = (0.1 + 0.12 * p_sun()) * (1.0 + 0.65 * bass() + 0.35 * p_kick());
  e.sy = 0.37 - e.jump * 0.06;
  return e;
}

fn ridge_top(i: i32, x: f32, e: Env, sx: f32) -> f32 {
  let fi = f32(i);
  let base = HORIZON - (0.07 - fi * 0.018);
  let amp = 0.32 - fi * 0.065;
  let fr = 1.3 + fi * 1.2;
  let sc = e.t * (0.012 + fi * 0.03);
  let u = x * fr + sc + fi * 17.0;
  // rolling noise plus pointed peaks
  let roll = smoothstep(0.2, 0.85, fbm(u));
  let peak = (1.0 - abs(2.0 * fract(u * 0.8 + 0.3) - 1.0)) * vn(floor(u * 0.8 + 0.3) * 1.7);
  var top = base - amp * (0.5 * roll + 0.6 * peak) - e.jump * (0.03 + 0.04 * fi);
  if (i == 0) { top -= 0.14 * spec(sx); }
  return top;
}

// sky, sun, clouds and the ranges at (x in screen heights, y 0..1 down)
fn land(x: f32, y: f32, e: Env, sx: f32, px: f32) -> vec3f {
  let mood = u32(p_mood());
  // sky: lifts with the loudness, flashes on kicks
  let g = clamp(y / HORIZON, 0.0, 1.0);
  var col = mix(mc(0u), mc(1u), g * g) * (0.5 + 1.0 * rms() + 0.6 * p_kick());

  // stars at night and dawn, twinkling with the highs
  if (mood == 0u || mood == 3u) {
    let sh = h2(floor(x / px), floor(y / px));
    let hi = (band(12) + band(13) + band(14)) / 3.0;
    let tw = 0.3 + 1.4 * hi * h2(sh * 91.0, floor(time() * 6.0));
    col += vec3f(step(0.985, sh) * tw * (1.0 - g)) * select(0.5, 1.0, mood == 3u);
  }

  // sun (moon at night): a halo, and slats in its lower half at dawn and dusk
  let d = length(vec2f(x - e.sx, y - e.sy));
  col += mix(mc(3u), mc(2u), 0.5) * select(0.3, 0.04, mood == 3u) * exp(-max(d - e.sr, 0.0) * 14.0) * (0.5 + bass());
  if (d < e.sr) {
    let v = (y - e.sy) / e.sr; // -1 top .. 1 bottom
    var sun = mix(mc(2u), mc(3u), clamp(v * 0.5 + 0.5, 0.0, 1.0)) * (1.4 + 0.8 * bass());
    let slats = mood == 0u || mood == 2u;
    let k = (v + 0.3) / 0.2;
    let w = clamp(0.1 + 0.3 * (v + 0.3) + 0.2 * bass(), 0.0, 0.8);
    if (slats && v > -0.3 && fract(k) < w) { sun = col; }
    col = sun;
  }

  // two rows of clouds drifting
  for (var r = 0; r < 2; r++) {
    let fr = f32(r);
    let yb = 0.14 + fr * 0.16 - e.jump * 0.01;
    let c = max(0.0, fbm(x * (1.6 + fr) + e.t * (0.03 + 0.04 * fr) + fr * 40.0) - 0.42) * (0.16 - fr * 0.03);
    if (c > px * 2.0 && y > yb - c && y < yb + c * 0.35) {
      let lit = select(1.0, 0.7, y > yb);
      col = mc(7u) * lit * (0.75 + 0.5 * rms());
    }
  }

  // four ranges, far to near; the far one's peaks are the spectrum
  for (var i = 0; i < 4; i++) {
    let top = ridge_top(i, x, e, sx);
    if (y >= top && y <= HORIZON) {
      let fi = f32(i) / 3.0;
      var m = mix(mix(mc(4u), mc(1u), 0.35), mc(5u), fi * fi);
      // lit along the ridge, darker toward the foot
      m *= 1.2 - 0.45 * clamp((y - top) / max(HORIZON - top, 0.01), 0.0, 1.0);
      // snow above the snowline on the two far ranges
      if (i <= 1 && y < 0.4 && mood != 3u) { m = mix(m, mc(7u), 0.75); }
      col = m * (0.75 + 0.6 * rms());
    }
  }
  return col;
}

fn shade(uv: vec2f) -> vec4f {
  let h = floor(p_pixels());
  let n = vec2f(max(1.0, floor(h * aspect() + 0.5)), h);
  let pc = floor(uv * n);
  let q = (pc + 0.5) / n;       // the cell centre: everything is drawn on the grid
  let px = 1.0 / h;
  let x = q.x * aspect();
  let y = q.y;
  let e = env();
  var col = vec3f(0.0);

  let shore = 0.8;
  if (y <= HORIZON) {
    col = land(x, y, e, q.x, px);
  } else {
    // the lake: the land mirrored, wobbling by whole pixels, darker; sun glints on alternate rows
    let row = pc.y;
    let wob = floor(sin(row * 0.9 + time() * 3.0) * (0.6 + 2.5 * bass()) + 0.5) * px;
    let ry = 2.0 * HORIZON - y;
    col = land(x + wob, ry, e, q.x + wob / aspect(), px) * mix(mc(8u), vec3f(1.0), 0.55) * 0.85;
    let depth = (y - HORIZON) / (shore - HORIZON);
    let gw = e.sr * (0.25 + 0.9 * h2(row, floor(time() * 5.0))) * (1.0 - depth * 0.5);
    if (abs(x - e.sx) < gw && (u32(row) & 1u) == 0u) { col = mc(2u) * (1.2 + bass()); }
    // a few shimmer dashes across the water
    let dash = h2(floor((x + time() * 0.02 * p_speed()) / (px * 7.0)), row);
    if (dash > 0.93 - 0.08 * rms()) { col += mc(1u) * 0.35; }
  }

  // the tree line in front, fastest layer
  let fx = x + e.t * 0.16;
  let ground = 0.85 - 0.035 * fbm(fx * 3.0 + 5.0) - e.jump * 0.06;
  var front = y > ground;
  let cw = 0.07;
  let ci = floor(fx / cw);
  for (var k = -1; k <= 1; k++) {
    let cc = ci + f32(k);
    let r = h1(cc * 3.7);
    if (r < 0.75) {
      let cx = (cc + 0.3 + 0.4 * h1(cc)) * cw;
      let th = 0.06 + 0.08 * h1(cc + 9.0) + e.jump * 0.04;
      let gy = 0.85 - 0.035 * fbm(cx * 3.0 + 5.0) - e.jump * 0.06;
      let top = gy - th;
      if (y > top && abs(fx - cx) < (y - top) * 0.38 + px * 0.5) { front = true; }
    }
  }
  if (front) {
    col = mc(6u) * (1.0 + 0.4 * p_kick());
  }

  return vec4f(col * p_glow(), 1.0);
}
