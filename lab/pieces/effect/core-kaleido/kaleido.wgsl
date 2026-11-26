fn shade(uv: vec2f) -> vec4f {
  let p = (uv - 0.5) * vec2f(aspect(), 1.0);
  let seg = 6.2831853 / p_segments();
  var a = atan2(p.y, p.x) + time() * p_spin() * 6.2831853;
  a = abs(a - seg * floor(a / seg) - seg * 0.5);
  let r = length(p) / p_zoom();
  return tex_in(vec2f(cos(a), sin(a)) * r / vec2f(aspect(), 1.0) + 0.5);
}
