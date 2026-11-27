fn shade(uv: vec2f) -> vec4f {
  let g = tex_by(uv).xy;
  let s = p_swirl() * 1.5707963;
  let d = vec2f(g.x * cos(s) - g.y * sin(s), g.x * sin(s) + g.y * cos(s));
  let kick = pow(1.0 - phase(), 3.0) * p_beat() + bass() * p_bass() * 1.5 + onset() * 0.5;
  let o = d * p_amount() * (1.0 + kick) * vec2f(1.0 / aspect(), 1.0);
  let c = p_chroma();
  let col = vec3f(tex_in(uv - o * (1.0 + c)).r, tex_in(uv - o).g, tex_in(uv - o * (1.0 - c)).b);
  let e = clamp(length(g), 0.0, 1.5);
  let glow = palette(fract(time() * 0.03 + e * 0.5 + uv.y * 0.2)) * e * e * p_outline() * (0.6 + kick);
  return vec4f(col + glow, 1.0);
}
