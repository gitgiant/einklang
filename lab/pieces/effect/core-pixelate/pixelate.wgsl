fn shade(uv: vec2f) -> vec4f {
  let n = vec2f(p_cells() * aspect(), p_cells());
  var c = tex_in((floor(uv * n) + 0.5) / n).rgb;
  let l = p_levels();
  if (l > 0.5) { c = floor(c * l + 0.5) / l; }
  return vec4f(c, 1.0);
}
