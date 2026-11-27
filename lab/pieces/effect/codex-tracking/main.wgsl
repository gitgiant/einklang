fn rounded_box(p: vec2f, half_size: vec2f, radius: f32) -> f32 {
  let d = abs(p) - half_size + radius;
  return length(max(d, vec2f(0.0))) + min(max(d.x, d.y), 0.0) - radius;
}

fn shade(uv: vec2f) -> vec4f {
  let p = (uv - 0.5) * vec2f(aspect(), 1.0);
  let aa = 1.15 / resolution().y;
  let t = time();
  let hit = pow(1.0 - phase(), 6.0) * bass();
  let energy = clamp(1.45 * bass() + 0.7 * rms(), 0.0, 1.0);
  let screen_half = vec2f(0.584, 0.321);
  let case_sdf = rounded_box(p, vec2f(0.711, 0.429), 0.036);
  let case_mask = 1.0 - smoothstep(-aa, aa, case_sdf);
  let cyan = vec3f(0.15, 0.73, 0.84);
  let pink = vec3f(0.85, 0.09, 0.31);
  let green = vec3f(0.28, 0.94, 0.22);
  let tube_tint = mix(mix(cyan, pink, energy), green, p_phosphor());

  let gradient = exp(-dot(p, p) * 2.7);
  let wall = vec3f(0.012, 0.021, 0.047) + tube_tint * gradient * (0.075 + 0.22 * energy);
  let shell = vec3f(0.046, 0.055, 0.077) + max(-p.y, 0.0) * 0.15;
  var col = mix(wall, shell, case_mask);
  col += vec3f(0.10, 0.12, 0.15) * (1.0 - smoothstep(aa, aa * 2.5, abs(case_sdf + 0.004)));

  let screen = p + vec2f(0.0, 0.034);
  let well = rounded_box(screen, screen_half + vec2f(0.023), 0.061);
  col = mix(col, vec3f(0.007, 0.010, 0.015), 1.0 - smoothstep(-aa, aa, well));
  let tube = rounded_box(screen, screen_half, 0.058);
  if (tube < aa) {
    let v = screen / screen_half;
    let bent = v * (0.96 + dot(v, v) * 0.052);
    let line_y = 0.38 * sin(t * 2.2) + 0.36;
    let tracking_band = exp(-abs(v.y - line_y) * 15.0);
    let line = floor((bent.y + 1.0) * 144.0);
    let jitter = fract(sin(line * 47.2 + floor(t * 24.0) * 7.3) * 16758.23) - 0.5;
    let slip = p_tracking() * (onset() * 0.46 + hit * 0.24 + energy * 0.048);
    let offset = (0.7 + jitter * 1.6) * slip * tracking_band + jitter * slip * 0.05;
    let sample_uv = bent * 0.47 + vec2f(0.5 + offset, 0.5);
    let split = vec2f(0.0015 + 0.013 * energy + abs(offset) * 0.16, 0.0);
    let rgb = vec3f(tex_picture(sample_uv - split).r, tex_picture(sample_uv).g, tex_picture(sample_uv + split).b);
    let lum = dot(rgb, vec3f(0.2126, 0.7152, 0.0722));
    let phosphor = mix(rgb, lum * green, p_phosphor());
    let scan = 0.80 + 0.20 * cos(bent.y * 800.0);
    let sweep = pow(0.5 + 0.5 * cos(bent.y * 8.0 + t * 3.8), 8.0);
    let vignette = 1.0 - 0.27 * clamp(dot(v, v), 0.0, 1.6);
    let signal_noise = tracking_band * (0.012 + jitter * jitter) * (0.15 + slip * 3.0);
    let picture = vignette * scan * (phosphor * (0.72 + 1.85 * energy)
      + tube_tint * (0.033 + energy * 0.17 + sweep * (0.027 + hit * 0.17) + signal_noise));
    col = mix(col, picture, 1.0 - smoothstep(-aa, aa, tube));
    col += tube_tint * exp(-abs(tube + 0.003) * 650.0) * 0.15;
  }

  // The rack's sixteen-band meter and channel light remain legible at low levels.
  if (abs(p.x) < 0.422 && abs(p.y - 0.355) < 0.031) {
    let meter_x = (p.x + 0.416) / 0.052;
    let meter_y = (0.377 - p.y) / 0.044;
    col = vec3f(0.007, 0.012, 0.025);
    if (meter_x > 0.0 && meter_x < 16.0 && meter_y > 0.0 && meter_y < 1.0) {
      let lit = floor(meter_y * 5.0) < 1.0 + floor(sqrt(band(i32(meter_x))) * 4.0);
      let cell = smoothstep(0.09, 0.17, fract(meter_x)) * (1.0 - smoothstep(0.78, 0.86, fract(meter_x)))
        * (1.0 - smoothstep(0.66, 0.84, fract(meter_y * 5.0)));
      col += mix(cyan, pink, clamp(meter_y * 1.3 - 0.18, 0.0, 1.0)) * cell * select(0.043, 0.92, lit);
    }
  }
  let dial = length(p - vec2f(0.55, 0.355));
  col += (1.0 - smoothstep(0.029, 0.029 + aa, dial)) * vec3f(0.065, 0.074, 0.095);
  col += exp(-abs(dial - 0.024) * 310.0) * tube_tint * (0.14 + energy * 0.41);
  col += exp(-length(p - vec2f(-0.55, 0.355)) * 210.0) * vec3f(1.0, 0.30, 0.095) * (1.1 + onset());
  return vec4f(col, 1.0);
}
