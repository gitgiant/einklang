fn hash21(p: vec2f) -> f32 {
  var q = fract(p * vec2f(123.34, 456.21));
  q += dot(q, q + 45.32);
  return fract(q.x * q.y);
}

fn shade(uv: vec2f) -> vec4f {
  let t = time();
  let b = bass();
  let on = onset();
  let r = rms();
  let beat_kick = pow(max(0.0, 1.0 - phase() * 2.8), 2.2) * (0.35 + 0.65 * b);
  let energy = clamp(on * 1.15 + beat_kick + r * 0.45, 0.0, 1.6);

  // Onset-driven macroblock & scan-strip corruption
  let step_t = floor(t * 11.0 + on * 8.0);
  let blk = floor(uv * vec2f(14.0 * aspect(), 14.0));
  let blk_r = hash21(blk + vec2f(step_t * 1.17, step_t * 0.63));
  let blk_on = step(1.0 - clamp(p_block_glitch() * (0.1 + 0.42 * energy), 0.0, 0.65), blk_r);
  let blk_dx = (hash21(blk + vec2f(29.3, step_t)) - 0.5) * 0.11 * p_block_glitch() * (0.35 + energy) * blk_on;

  let strip_y = floor(uv.y * 32.0);
  let strip_r = hash21(vec2f(strip_y, step_t * 1.7));
  let strip_on = step(1.0 - clamp(p_block_glitch() * 0.28 * energy, 0.0, 0.55), strip_r);
  let strip_dx = (strip_r - 0.5) * 0.09 * p_block_glitch() * energy * strip_on;

  let disp_uv = clamp(uv + vec2f(blk_dx + strip_dx, 0.0), vec2f(0.0), vec2f(1.0));

  // Sample audio data texture (spectrogram / piano-roll)
  let data_col = tex_data(uv).rgb;
  let data_luma = clamp(dot(data_col, vec3f(0.299, 0.587, 0.114)), 0.0, 2.0);
  let data_peak = clamp(max(data_col.r, max(data_col.g, data_col.b)), 0.0, 2.0);
  var key = clamp(max(data_luma, data_peak * 0.85), 0.0, 1.5);
  if (p_invert() > 0.5) {
    key = clamp(1.0 - key, 0.0, 1.0);
  }

  // Dynamic threshold breathes with bass so more of the picture opens on hits
  let th = max(0.01, p_threshold() - b * 0.08 - on * 0.06);
  let s = p_soft();
  let mask = smoothstep(th - s * 0.5, th + s, key);
  let rim = exp(-pow((key - th) / max(s * 0.55, 0.02), 2.0));

  // Sample media edges for refraction and blueprint wireframe
  let edge_v = tex_edges(disp_uv).xy;
  let edge_mag = clamp(length(edge_v), 0.0, 2.2);

  // Chromatic RGB split driven by spectral mask, onsets, and block corruption
  let rgb_amt = (0.002 + 0.018 * p_rgb_split() * (0.25 + energy * 0.85 + rim * 0.55 + blk_on * 0.65));
  let refr = edge_v * 0.008 * (0.3 + mask * 0.7 + energy * 0.5);
  let sample_uv = clamp(disp_uv + refr, vec2f(0.0), vec2f(1.0));
  let media_r = tex_in(clamp(sample_uv + vec2f(rgb_amt, 0.0), vec2f(0.0), vec2f(1.0))).r;
  let media_g = tex_in(sample_uv).g;
  let media_b = tex_in(clamp(sample_uv - vec2f(rgb_amt, 0.0), vec2f(0.0), vec2f(1.0))).b;
  let media_col = vec3f(media_r, media_g, media_b);

  // Unmasked area: stylized dark blueprint of the picture + neon edge contours + fine data grid
  let media_luma = dot(media_col, vec3f(0.2126, 0.7152, 0.0722));
  let pal_wire = palette(clamp(0.2 + media_luma * 0.55 + fract(t * 0.04) * 0.25, 0.0, 1.0));
  let pal_rim = palette(clamp(0.65 + key * 0.3, 0.0, 1.0));

  let grid_x = smoothstep(0.94, 0.99, fract(uv.x * 24.0));
  let grid_y = smoothstep(0.94, 0.99, fract(uv.y * 14.0));
  let grid_line = max(grid_x, grid_y) * 0.08 * (0.5 + 0.5 * r);

  let dark_media = mix(vec3f(media_luma) * pal_wire, media_col, 0.45) * p_ghost();
  let blueprint = dark_media + pal_wire * edge_mag * p_edge_glow() * (0.45 + 0.65 * energy) + pal_wire * grid_line;

  // Masked area: vivid HDR media punched up by the spectral energy
  let revealed = media_col * (1.05 + 0.45 * mask * (0.4 + b + on * 0.6)) + data_col * (0.28 * p_data_glow());

  var col = mix(blueprint, revealed, mask);

  // Luminous spectral contour rim + data overlay flare
  col += (data_col * 0.65 + pal_rim * 0.55) * rim * p_data_glow() * (0.45 + 0.75 * energy);

  // Digital glitch block accent
  col += pal_rim * (blk_on * 0.16 + strip_on * 0.14) * energy;

  return vec4f(clamp(col, vec3f(0.0), vec3f(3.0)), 1.0);
}
