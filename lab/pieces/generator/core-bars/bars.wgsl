fn shade(uv: vec2f) -> vec4f {
  let x = uv.x * 16.0;
  let i = i32(floor(x));
  let cell = fract(x);
  let h = band(i) * p_height();
  let y = abs(uv.y - 0.5) * 2.0;
  let col_on = step(p_gap() * 0.5, cell) * step(cell, 1.0 - p_gap() * 0.5);
  let inside = col_on * step(y, h);
  let edge = exp(-abs(y - h) * 40.0) * col_on;
  return vec4f(palette(uv.x) * (inside * 0.6 + edge * p_glow()), 1.0);
}
