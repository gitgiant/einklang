// agy-film-burn: a seeded hot spot burns through A with an orange glowing edge and char, B behind.

fn brn_hash2(ip: vec2i, s: u32) -> f32 {
  let ux = bitcast<u32>(ip.x) * 3266489917u;
  let uy = bitcast<u32>(ip.y) * 668265263u;
  return rnd(ux ^ uy, s);
}

fn brn_vnoise(p: vec2f, s: u32) -> f32 {
  let i = vec2i(floor(p));
  let f = fract(p);
  let u = f * f * (3.0 - 2.0 * f);
  let a = brn_hash2(i, s);
  let b = brn_hash2(i + vec2i(1, 0), s);
  let c = brn_hash2(i + vec2i(0, 1), s);
  let d = brn_hash2(i + vec2i(1, 1), s);
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

fn brn_fbm(p_in: vec2f, s: u32) -> f32 {
  var p = p_in;
  var acc = 0.0;
  var amp = 0.5;
  for (var i = 0; i < 4; i = i + 1) {
    acc = acc + amp * brn_vnoise(p, s + u32(i) * 89u);
    p = vec2f(p.x * 1.78 - p.y * 1.15, p.x * 1.15 + p.y * 1.78) + vec2f(5.1, 11.9);
    amp = amp * 0.5;
  }
  return acc;
}

fn brn_smin(a: f32, b: f32, k: f32) -> f32 {
  let h = max(k - abs(a - b), 0.0) / k;
  return min(a, b) - h * h * k * 0.25;
}

fn trans(uv: vec2f) -> vec3f {
  let p = clamp(T.p, 0.0, 1.0);
  if (p <= 0.0) { return sa(uv); }
  if (p >= 1.0) { return sb(uv); }

  let s = T.seed;
  let asp = vec2f(T.aspect, 1.0);
  let q = uv * asp;

  // Primary seeded hot spot + a smaller secondary blister nearby.
  let h1 = vec2f(0.22 + 0.56 * rnd(s, 1u), 0.22 + 0.56 * rnd(s, 2u)) * asp;
  let h2_off = rot(vec2f(0.22 + 0.16 * rnd(s, 3u), 0.0), rnd(s, 4u) * 6.2831853);
  let h2 = clamp(h1 + h2_off, vec2f(0.1) * asp, vec2f(0.9) * asp);

  let d1 = length(q - h1);
  let d2 = length(q - h2) + 0.18;
  let base_d = brn_smin(d1, d2, 0.14);

  let n_off = vec2f(rnd(s, 5u), rnd(s, 6u)) * 10.0;
  let rough = brn_fbm(q * 4.2 + n_off, s ^ 0x9182u);
  let crackle = brn_vnoise(q * 22.0 + n_off, s ^ 0x7364u);

  let jag = p_jagged();
  let char_w = p_char_width();
  let field = base_d + (rough - 0.5) * jag * 1.5 + (crackle - 0.5) * 0.03;

  let max_span = length(asp);
  let lo = -jag * 0.9 - char_w * 2.2;
  let hi = max_span * 1.18 + jag * 0.9 + char_w * 1.5;
  let burn_r = mix(lo, hi, p);

  // Signed distance from the burn rim: < 0 is burned through (B), > 0 is still A.
  let sd = field - burn_r;
  let edge_soft = 0.012;
  let reveal_b = 1.0 - smoothstep(-edge_soft, edge_soft, sd);

  // Heat blister distortion on A right ahead of the melting rim.
  let env = smoothstep(0.0, 0.05, p) * (1.0 - smoothstep(0.95, 1.0, p));
  let heat_zone = (1.0 - smoothstep(0.0, char_w * 2.2, sd)) * (1.0 - reveal_b) * env;
  let blister_dir = normalize(q - h1 + vec2f(1e-4, 0.0));
  let uv_a = clamp(uv + blister_dir * (rough - 0.35) * 0.03 * heat_zone, vec2f(0.0), vec2f(1.0));

  var col_a = sa(uv_a);
  let col_b = sb(uv);

  // Charred celluloid border just ahead of the burn hole.
  let char_m = (1.0 - smoothstep(0.0, char_w, sd)) * (1.0 - reveal_b) * env;
  let char_col = vec3f(0.035, 0.015, 0.008);
  col_a = mix(col_a, char_col, clamp(char_m * 1.15, 0.0, 0.95));

  var c = mix(col_a, col_b, reveal_b);

  // Incandescent orange-to-white ember rim along sd ~= 0.
  let rim_w = max(char_w * 0.55, 0.015);
  let rim = exp(-abs(sd) / rim_w) * env;
  let hot_core = exp(-abs(sd) / (rim_w * 0.25)) * env;
  let flicker = 0.72 + 0.28 * crackle + 0.15 * band(0.12);

  let ember_outer = vec3f(1.35, 0.28, 0.02);
  let ember_inner = vec3f(2.2, 1.35, 0.38);
  let ember = mix(ember_outer, ember_inner, clamp(hot_core * 1.3, 0.0, 1.0));
  c = c + ember * rim * p_glow() * flicker;

  // Warm projector light leak driven by T.flash around the ignition hot spot.
  let leak_falloff = exp(-d1 * 1.8) * (0.65 + 0.35 * rough);
  let leak = vec3f(1.1, 0.42, 0.08) * T.flash * 0.5 * leak_falloff * env;
  c = c + leak;

  return c;
}
