// Amiga copper bars: horizontal bars painted back to front, each shaded like a lit metal rod.

fn sky(uv: vec2f) -> vec3f {
  let n = i32(p_bars());
  let under = tex_in(uv).rgb;
  var col = under;
  let beats = time() * select(120.0, bpm(), bpm() > 0.0) / 60.0;
  let px = 1.0 / resolution().y;
  // high bands first, so the bass bars end up in front
  for (var j = 0; j < n; j++) {
    let i = n - 1 - j;
    let lo = i * 16 / n;
    let hi = (i + 1) * 16 / n;
    var e = 0.0;
    for (var b = lo; b < hi; b++) { e += band(b); }
    e /= f32(hi - lo);
    let ph = beats * p_speed() * 6.2831853 + f32(i) * p_spread();
    let y = p_center() + p_amp() * sin(ph) * (0.8 + 0.2 * sin(ph * 0.37 + 1.7))
      + p_twist() * sin(uv.x * aspect() * 3.0 + time() * 1.3 + f32(i) * 0.7);
    let hh = p_thickness() * (1.0 + p_react() * e * e);
    let d = (uv.y - y) / hh;
    let cover = clamp((1.0 - abs(d)) * hh / px, 0.0, 1.0);
    if (cover <= 0.0) { continue; }
    let round_ = sqrt(max(0.0, 1.0 - d * d));
    let base = palette(f32(i) / f32(max(n - 1, 1)));
    let shine = exp(-(d + 0.25) * (d + 0.25) * 22.0);
    let c = (base * (0.08 + 0.92 * round_ * round_) + vec3f(shine * (0.25 + 0.6 * e))) * p_glow() * (0.65 + 0.6 * e);
    col = mix(col, c, cover);
  }
  let lum = clamp(max(under.r, max(under.g, under.b)), 0.0, 1.0);
  return mix(col, max(col, under), (1.0 - p_front()) * lum);
}

fn shade(uv: vec2f) -> vec4f {
  let h = p_horizon();
  if (h >= 1.0 || uv.y <= h) { return vec4f(sky(uv), 1.0); }
  // water: mirror about the horizon, ripples growing toward the viewer, darker with depth
  let d = uv.y - h;
  let wave = sin(d * d * 900.0 + d * 120.0 - time() * 3.0 + sin(uv.x * 9.0) * 1.5);
  let m = vec2f(uv.x + wave * d * 0.05, h - d * 1.6 + wave * d * 0.12);
  let water = sky(clamp(m, vec2f(0.0), vec2f(1.0, h))) * (0.55 - d * 0.8) * (0.85 + 0.15 * wave);
  let line = exp(-d * resolution().y * 0.5) * (0.15 + 0.5 * bass());
  return vec4f(max(water, vec3f(0.0)) + palette(0.8) * line, 1.0);
}
