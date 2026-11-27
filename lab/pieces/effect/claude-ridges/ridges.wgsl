fn shade(uv: vec2f) -> vec4f {
  let n = i32(p_lines());
  let px = resolution().y / 1080.0;
  let amp = p_height() * (1.0 + p_bass() * bass() * 1.5);
  let th = p_thickness() * px / resolution().y;
  let beat = fract(phase());
  var col = vec3f(0.0);
  for (var j = 0; j < n; j++) {
    let v = (f32(j) + 0.5) / f32(n);
    // perspective: back rows (top) narrower and closer together
    let w = mix(1.0 - 0.45 * p_tilt(), 1.0, v);
    let xs = (uv.x - 0.5) / w + 0.5;
    if (xs < 0.0 || xs > 1.0) { continue; }
    let base = mix(0.2, 0.95, mix(v, v * v, 0.4 * p_tilt()));
    let hgt = tex_height(vec2f(xs, v)).x;
    let y = base - hgt * amp * mix(0.6, 1.0, v);
    let dy = uv.y - y;
    if (dy > 0.0) { col *= 1.0 - p_fill(); }
    let line = smoothstep(th * 1.5, 0.0, abs(dy));
    var c = vec3f(1.0);
    let mode = i32(p_colour());
    if (mode == 0) { c = tex_in(vec2f(xs, v)).rgb * 1.6 + 0.04; }
    else if (mode == 1) { c = palette(fract(hgt * 0.8 + v * 0.3)); }
    // a glow runs down the rows over each beat
    let run = exp(-pow((v - beat) * 9.0, 2.0)) * (0.5 + bass());
    col = mix(col, c * p_glow() * (1.0 + run), line);
  }
  return vec4f(col, 1.0);
}
