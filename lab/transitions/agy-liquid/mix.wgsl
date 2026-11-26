// agy-liquid: A warps along a seeded divergence-free flow field and streams into B.

fn liq_hash2(ip: vec2i, s: u32) -> f32 {
  let ux = bitcast<u32>(ip.x) * 2654435761u;
  let uy = bitcast<u32>(ip.y) * 2246822519u;
  return rnd(ux ^ uy, s);
}

fn liq_vnoise(p: vec2f, s: u32) -> f32 {
  let i = vec2i(floor(p));
  let f = fract(p);
  let u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  let a = liq_hash2(i, s);
  let b = liq_hash2(i + vec2i(1, 0), s);
  let c = liq_hash2(i + vec2i(0, 1), s);
  let d = liq_hash2(i + vec2i(1, 1), s);
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

fn liq_pot(p_in: vec2f, s: u32) -> f32 {
  var p = p_in;
  var acc = 0.0;
  var amp = 0.55;
  for (var i = 0; i < 3; i = i + 1) {
    acc = acc + amp * liq_vnoise(p, s + u32(i) * 73u);
    p = vec2f(p.x * 1.65 - p.y * 1.12, p.x * 1.12 + p.y * 1.65) + vec2f(6.3, 11.4);
    amp = amp * 0.5;
  }
  return acc;
}

fn trans(uv: vec2f) -> vec3f {
  let p = clamp(T.p, 0.0, 1.0);
  if (p <= 0.0) { return sa(uv); }
  if (p >= 1.0) { return sb(uv); }

  let s = T.seed;
  let asp = vec2f(T.aspect, 1.0);
  let sc = p_scale() * (0.85 + 0.3 * rnd(s, 1u));
  let off = vec2f(rnd(s, 2u), rnd(s, 3u)) * 10.0;

  // Seeded global current direction so each switch flows along a new angle.
  let ang = rnd(s, 4u) * 6.2831853;
  let current = vec2f(cos(ang), sin(ang)) * 0.38;

  // Compute curl of scalar potential (divergence-free eddies) via central differences.
  let q = (uv - T.center) * asp * sc + off + current * p * 1.4;
  let eps = 0.06;
  let px1 = liq_pot(q + vec2f(eps, 0.0), s ^ 0x2468u);
  let px0 = liq_pot(q - vec2f(eps, 0.0), s ^ 0x2468u);
  let py1 = liq_pot(q + vec2f(0.0, eps), s ^ 0x2468u);
  let py0 = liq_pot(q - vec2f(0.0, eps), s ^ 0x2468u);
  let curl = vec2f(py1 - py0, -(px1 - px0)) / (2.0 * eps);

  let audio_surge = 1.0 + 0.25 * band(0.15);
  let vel = (curl * 0.72 + current) / asp * p_strength() * audio_surge;

  // Midpoint envelope keeps ends locked while streaming through the middle.
  let bump = 4.0 * p * (1.0 - p);
  // A advects forward along the flow; B streams in from upstream to land exactly at uv at p = 1.
  let uv_a = clamp(uv - vel * p * (0.55 + 0.65 * bump), vec2f(0.0), vec2f(1.0));
  let uv_b = clamp(uv + vel * (1.0 - p) * (0.55 + 0.65 * bump), vec2f(0.0), vec2f(1.0));

  let col_a = sa(uv_a);
  let col_b = sb(uv_b);

  // Flow-modulated blend: faster streams carry B slightly ahead of slower eddies.
  let pot_mid = 0.25 * (px1 + px0 + py1 + py0);
  let wave_shift = (pot_mid - 0.5) * 0.32 * bump;
  let m = smoothstep(0.0, 1.0, clamp(p + wave_shift, 0.0, 1.0));
  var c = mix(col_a, col_b, m);

  // Subtle glossy liquid sheen along high-shear flow ridges.
  let shear = clamp(length(curl) * 0.65, 0.0, 1.0);
  let sheen = pow(shear, 2.0) * bump * p_sheen();
  c = c * (1.0 + 0.22 * sheen) + vec3f(0.16, 0.2, 0.26) * sheen;

  return c;
}
