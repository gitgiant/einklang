fn shade(uv: vec2f) -> vec4f {
  var k = tex_key(uv).x;
  if (p_invert() > 0.5) { k = 1.0 - k; }
  let th = p_threshold() - bass() * p_bass() * 0.5;
  let s = p_soft();
  let m = smoothstep(th - s, th + s, k);
  let rim = exp(-pow((k - th) / (s * 0.6 + 0.01), 2.0)) * p_rim() * (0.5 + 0.5 * bass() + onset() * 0.5);
  let col = mix(tex_bg(uv).rgb, tex_fg(uv).rgb, m) + palette(fract(k + time() * 0.05)) * rim;
  return vec4f(col, 1.0);
}
