fn shade(uv: vec2f) -> vec4f {
  let c = (uv - 0.5) * vec2f(aspect(), 1.0);
  let a = p_rotate();
  let r = vec2f(c.x * cos(a) - c.y * sin(a), c.x * sin(a) + c.y * cos(a)) * (1.0 - p_zoom());
  let old = prev(r / vec2f(aspect(), 1.0) + 0.5).rgb * p_decay();
  return vec4f(max(tex_in(uv).rgb, old), 1.0);
}
