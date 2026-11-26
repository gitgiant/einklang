fn shade(uv: vec2f) -> vec4f {
  let p = (uv - 0.5) * vec2f(aspect(), 1.0) * p_scale();
  let t = time() * p_speed();
  let w = p_warp();
  var v = sin(p.x + t) + sin(p.y * 1.3 - t * 0.7) + sin((p.x + p.y) * 0.7 + t * 1.3);
  v += sin(length(p + vec2f(sin(t * 0.5), cos(t * 0.3)) * 2.0) * (1.5 + w * 2.0) - t);
  let x = fract(v * 0.125 + 0.5 + w * 0.1);
  return vec4f(palette(x) * p_gain() * (0.6 + 0.6 * rms()), 1.0);
}
