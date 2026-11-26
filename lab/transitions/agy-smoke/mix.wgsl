// agy-smoke: domain-warped noise threshold that drifts upward like billowing smoke.

fn smk_hash2(ip: vec2i, s: u32) -> f32 {
  let ux = bitcast<u32>(ip.x) * 1597334677u;
  let uy = bitcast<u32>(ip.y) * 3812015801u;
  return rnd(ux ^ uy, s);
}

fn smk_vnoise(p: vec2f, s: u32) -> f32 {
  let i = vec2i(floor(p));
  let f = fract(p);
  let u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  let a = smk_hash2(i, s);
  let b = smk_hash2(i + vec2i(1, 0), s);
  let c = smk_hash2(i + vec2i(0, 1), s);
  let d = smk_hash2(i + vec2i(1, 1), s);
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

fn smk_fbm(p_in: vec2f, s: u32) -> f32 {
  var p = p_in;
  var acc = 0.0;
  var amp = 0.5;
  for (var i = 0; i < 4; i = i + 1) {
    acc = acc + amp * smk_vnoise(p, s + u32(i) * 131u);
    p = vec2f(p.x * 1.72 - p.y * 1.05, p.x * 1.05 + p.y * 1.72) + vec2f(9.1, 4.7);
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
  let wind = (rnd(s, 2u) - 0.5) * 0.85;
  // uv.y = 0 is top, so adding +y to sample coords makes smoke patterns rise upward.
  let drift = vec2f(wind, p_rise()) * p;
  let off = vec2f(rnd(s, 3u), rnd(s, 4u)) * 12.0;
  let q = uv * asp * sc + off;

  // Two-layer domain warp for curling smoke wisps.
  let w1 = vec2f(
    smk_fbm(q + drift * 1.25, s ^ 0x1122u),
    smk_fbm(q + drift * 1.05 + vec2f(4.3, 2.9), s ^ 0x3344u)
  ) - 0.5;
  let curl_q = q + w1 * p_warp() + drift * 0.8;
  let cloud = smk_fbm(curl_q, s ^ 0x5566u);

  // Slight bottom-to-top bias so smoke wisps tend to lift from below.
  let vertical_bias = (1.0 - uv.y) * 0.16;
  let audio_wisp = 0.03 * band(0.55) * (w1.x - w1.y);
  let field = clamp(cloud * 0.84 + vertical_bias + audio_wisp, 0.0, 1.0);

  let soft = p_soft();
  let thresh = mix(-soft, 1.0 + soft, p);
  let m = 1.0 - smoothstep(thresh - soft, thresh + soft, field);

  // Billowing vapor distortion and soft smoky haze along the dissolve edge.
  let wisp = 4.0 * m * (1.0 - m);
  let env = smoothstep(0.0, 0.06, p) * (1.0 - smoothstep(0.94, 1.0, p));
  let haze = wisp * env;

  let disp = w1 * 0.04 * haze;
  let col_a = sa(uv + disp - vec2f(0.0, 0.015 * haze));
  let col_b = sb(uv - disp * 0.65);

  var c = mix(col_a, col_b, m);
  // Subtle translucent smoke veil tinted by the scenes' own average luma.
  let luma = dot(c, vec3f(0.2126, 0.7152, 0.0722));
  let smoke_tint = vec3f(0.88, 0.91, 0.96) * (0.14 + 0.45 * luma);
  c = mix(c, smoke_tint, 0.24 * haze * (0.5 + 0.5 * cloud));

  return c;
}
