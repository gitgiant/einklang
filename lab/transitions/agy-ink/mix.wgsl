// agy-ink: B spreads like ink in water from a few seeded drops with a noisy feathered edge.

fn ink_hash2(ip: vec2i, s: u32) -> f32 {
  let ux = bitcast<u32>(ip.x) * 374761393u;
  let uy = bitcast<u32>(ip.y) * 668265263u;
  return rnd(ux ^ uy, s);
}

fn ink_vnoise(p: vec2f, s: u32) -> f32 {
  let i = vec2i(floor(p));
  let f = fract(p);
  let u = f * f * (3.0 - 2.0 * f);
  let a = ink_hash2(i, s);
  let b = ink_hash2(i + vec2i(1, 0), s);
  let c = ink_hash2(i + vec2i(0, 1), s);
  let d = ink_hash2(i + vec2i(1, 1), s);
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

fn ink_fbm(p_in: vec2f, s: u32) -> f32 {
  var p = p_in;
  var acc = 0.0;
  var amp = 0.5;
  for (var i = 0; i < 4; i = i + 1) {
    acc = acc + amp * ink_vnoise(p, s + u32(i) * 97u);
    p = vec2f(p.x * 1.62 - p.y * 1.21, p.x * 1.21 + p.y * 1.62) + vec2f(13.7, 7.3);
    amp = amp * 0.5;
  }
  return acc;
}

fn ink_smin(a: f32, b: f32, k: f32) -> f32 {
  let h = max(k - abs(a - b), 0.0) / k;
  return min(a, b) - h * h * k * 0.25;
}

fn trans(uv: vec2f) -> vec3f {
  let p = clamp(T.p, 0.0, 1.0);
  if (p <= 0.0) { return sa(uv); }
  if (p >= 1.0) { return sb(uv); }

  let asp = vec2f(T.aspect, 1.0);
  let q = uv * asp;
  let s = T.seed;

  // Domain-warped capillary noise for organic tendrils along the ink front.
  let n_off = vec2f(rnd(s, 11u), rnd(s, 12u)) * 10.0;
  let warp = vec2f(
    ink_fbm(q * 3.0 + n_off, s ^ 0x1a2bu),
    ink_fbm(q * 3.0 + n_off + vec2f(5.2, 1.7), s ^ 0x3c4du)
  ) - 0.5;
  let cap = ink_fbm(q * 5.2 + warp * 1.15 + n_off - vec2f(0.0, p * 0.25), s ^ 0x5e6fu);
  let fine = ink_vnoise(q * 18.0 + warp * 2.0, s ^ 0x7a8bu);

  let count = clamp(i32(round(p_drops())), 2, 8);
  let max_span = length(asp);
  var d_min = 10.0;

  for (var i = 0; i < 8; i = i + 1) {
    if (i >= count) { break; }
    let ui = u32(i);
    // First drop starts near FX center (jittered); others spread across the frame.
    var pos: vec2f;
    if (i == 0) {
      let jit = (vec2f(rnd(s, 20u), rnd(s, 21u)) - 0.5) * 0.35;
      pos = clamp(T.center + jit, vec2f(0.15), vec2f(0.85)) * asp;
    } else {
      let px = 0.1 + 0.8 * rnd(s, 30u + ui * 4u);
      let py = 0.1 + 0.8 * rnd(s, 31u + ui * 4u);
      pos = vec2f(px, py) * asp;
    }
    let delay = select(0.0, 0.22 * rnd(s, 32u + ui * 4u), i > 0);
    let speed = 0.85 + 0.3 * rnd(s, 33u + ui * 4u);
    let dist = length(q - pos) / speed + delay * max_span * 0.55;
    d_min = ink_smin(d_min, dist, 0.18);
  }

  let bleed = p_bleed();
  let feather = p_feather() * (0.75 + 0.5 * fine);
  let audio_ripple = 0.025 * band(0.35) * (fine - 0.5);
  let front = d_min + (cap - 0.5) * bleed * 1.4 + audio_ripple;

  // Sweep threshold cleanly from below min possible front (p = 0) to above max (p = 1).
  let lo = -bleed * 0.9 - feather * 1.5;
  let hi = max_span * 1.22 + bleed * 0.9 + feather * 1.5;
  let thresh = mix(lo, hi, p);

  let m = 1.0 - smoothstep(thresh - feather, thresh + feather, front);

  // Subtle wet diffusion and dark pigment pooling at the ink front.
  let edge = 4.0 * m * (1.0 - m);
  let env = smoothstep(0.0, 0.05, p) * (1.0 - smoothstep(0.95, 1.0, p));
  let wet = edge * env;
  let uv_a = uv + warp * 0.018 * wet;

  let col_a = sa(uv_a);
  let col_b = sb(uv);
  var c = mix(col_a, col_b, m);

  // Darken the thin leading rim like concentrated ink pigment diffusing in water.
  let pigment = 1.0 - 0.34 * wet * (0.65 + 0.35 * cap);
  c = c * pigment;

  return c;
}
