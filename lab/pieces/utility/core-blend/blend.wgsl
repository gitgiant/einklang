fn shade(uv: vec2f) -> vec4f {
  let a = tex_a(uv).rgb;
  let bt = tex_b(uv);
  let b0 = bt.rgb;
  let b = b0 * p_amount();
  let m = i32(p_mode());
  var c = a + b;
  if (m == 1) { c = 1.0 - (1.0 - clamp(a, vec3f(0.0), vec3f(1.0))) * (1.0 - clamp(b, vec3f(0.0), vec3f(1.0))); }
  else if (m == 2) { c = a * b; }
  else if (m == 3) { c = abs(a - b); }
  else if (m == 4) { c = mix(a, b0, clamp(p_amount(), 0.0, 1.0)); }
  // over: b is premultiplied (sprites, text) and covers a where it is opaque
  else if (m == 5) { let k = clamp(p_amount(), 0.0, 1.0); c = a * (1.0 - bt.a * k) + b0 * k; }
  return vec4f(c, 1.0);
}
