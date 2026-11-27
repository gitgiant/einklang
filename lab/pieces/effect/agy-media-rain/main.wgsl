fn hash_u32(x: u32) -> u32 {
  var v = x * 747796405u + 2891336453u;
  v = ((v >> ((v >> 28u) + 4u)) ^ v) * 277803737u;
  return (v >> 22u) ^ v;
}

fn hash2(a: u32, b: u32) -> f32 {
  return f32(hash_u32(a ^ hash_u32(b * 374761393u + 668265263u)) & 0xFFFFu) / 65536.0;
}

fn pack6(r0: u32, r1: u32, r2: u32, r3: u32, r4: u32, r5: u32) -> u32 {
  return r0 | (r1 << 5u) | (r2 << 10u) | (r3 << 15u) | (r4 << 20u) | (r5 << 25u);
}

// 16 procedural 5x6 Matrix / Katakana & hex glyphs ordered roughly by ink density
fn glyph_bits(idx: u32) -> u32 {
  switch (idx % 16u) {
    case 0u:  { return pack6(0x00u, 0x04u, 0x04u, 0x00u, 0x04u, 0x00u); } // sparse dot
    case 1u:  { return pack6(0x04u, 0x04u, 0x04u, 0x04u, 0x04u, 0x0Eu); } // 1 / vertical
    case 2u:  { return pack6(0x1Fu, 0x10u, 0x08u, 0x04u, 0x02u, 0x02u); } // 7 / フ
    case 3u:  { return pack6(0x1Fu, 0x04u, 0x04u, 0x04u, 0x04u, 0x0Eu); } // テ
    case 4u:  { return pack6(0x02u, 0x04u, 0x1Fu, 0x04u, 0x08u, 0x10u); } // ナ
    case 5u:  { return pack6(0x11u, 0x0Au, 0x04u, 0x0Au, 0x11u, 0x00u); } // メ
    case 6u:  { return pack6(0x1Fu, 0x08u, 0x04u, 0x04u, 0x08u, 0x1Fu); } // ユ
    case 7u:  { return pack6(0x1Fu, 0x01u, 0x0Fu, 0x01u, 0x01u, 0x1Fu); } // コ
    case 8u:  { return pack6(0x1Fu, 0x10u, 0x08u, 0x04u, 0x02u, 0x1Fu); } // Z / マ
    case 9u:  { return pack6(0x0Eu, 0x11u, 0x15u, 0x15u, 0x11u, 0x0Eu); } // 0
    case 10u: { return pack6(0x1Fu, 0x08u, 0x1Fu, 0x08u, 0x08u, 0x04u); } // キ
    case 11u: { return pack6(0x11u, 0x11u, 0x1Fu, 0x10u, 0x08u, 0x04u); } // サ
    case 12u: { return pack6(0x04u, 0x1Fu, 0x04u, 0x1Fu, 0x04u, 0x0Eu); } // 丰
    case 13u: { return pack6(0x15u, 0x15u, 0x1Fu, 0x04u, 0x04u, 0x1Fu); } // ヨ
    case 14u: { return pack6(0x04u, 0x1Fu, 0x15u, 0x15u, 0x1Fu, 0x04u); } // 中
    default:  { return pack6(0x15u, 0x0Eu, 0x1Fu, 0x0Eu, 0x15u, 0x0Eu); } // dense star
  }
}

fn sample_glyph(idx: u32, local: vec2f) -> f32 {
  let gx = i32(floor(local.x * 6.0));
  let gy = i32(floor(local.y * 8.0)) - 1;
  if (gx < 0 || gx >= 5 || gy < 0 || gy >= 6) {
    return 0.0;
  }
  let bits = glyph_bits(idx);
  let shift = u32(gy * 5 + gx);
  return f32((bits >> shift) & 1u);
}

fn shade(uv: vec2f) -> vec4f {
  let t = time();
  let b = bass();
  let on = onset();
  let r = rms();
  let ph = phase();
  let beat_kick = pow(max(0.0, 1.0 - ph * 3.0), 2.2) * (0.3 + 0.7 * b);
  let energy = clamp(on * 1.15 + beat_kick + r * 0.45, 0.0, 1.6);

  // Horizontal glitch band offset on onsets
  let glitch_t = u32(floor(t * 14.0 + on * 9.0));
  let band_y = u32(max(0.0, floor(uv.y * 22.0)));
  let band_r = hash2(band_y, glitch_t);
  let glitch_on = step(1.0 - clamp(p_glitch() * (0.08 + 0.36 * energy), 0.0, 0.6), band_r);
  let glitch_dx = (hash2(band_y + 53u, glitch_t) - 0.5) * 0.06 * p_glitch() * (0.3 + energy) * glitch_on;
  let uv_g = clamp(uv + vec2f(glitch_dx, 0.0), vec2f(0.0), vec2f(1.0));

  // Glyph grid
  let cols_f = p_columns();
  let asp = aspect();
  let rows_f = max(16.0, floor(cols_f / max(asp * 0.65, 0.35)));
  let grid = vec2f(cols_f, rows_f);
  let pos = uv_g * grid;
  let cell_f = floor(pos);
  let col_i = u32(max(0.0, cell_f.x));
  let row_i = i32(cell_f.y);
  let local = fract(pos);
  let cell_uv = clamp((cell_f + 0.5) / grid, vec2f(0.0), vec2f(1.0));

  // Sample media color, luma, and edges at cell center (with RGB tear on glitch bands)
  let rgb_off = (0.002 + 0.012 * p_glitch() * (energy * 0.6 + glitch_on)) / max(asp, 0.5);
  let src_r = tex_in(clamp(cell_uv + vec2f(rgb_off, 0.0), vec2f(0.0), vec2f(1.0))).r;
  let src_g = tex_in(cell_uv).g;
  let src_b = tex_in(clamp(cell_uv - vec2f(rgb_off, 0.0), vec2f(0.0), vec2f(1.0))).b;
  let src_col = vec3f(src_r, src_g, src_b);

  let luma_m = clamp(tex_luma(cell_uv).x, 0.0, 1.0);
  let edge_v = tex_edges(cell_uv).xy;
  let edge_m = clamp(length(edge_v), 0.0, 2.0);
  let b_val = band(i32(col_i % 16u));

  // Falling rain stream kinematics locked to tempo
  let beat_time = t * max(bpm(), 60.0) / 60.0;
  let h_col = hash2(col_i, 19u);
  let h_spd = hash2(col_i, 47u);
  let h_len = hash2(col_i, 89u);
  let col_speed = (0.55 + h_spd * 1.15) * p_speed() * (0.85 + 0.35 * b_val);
  let cycle_rows = rows_f * (1.1 + h_len * 0.85);
  let head_y = fract(beat_time * col_speed * 0.17 + h_col + beat_kick * 0.02) * cycle_rows - 1.5;

  var dist = head_y - f32(row_i);
  if (dist < 0.0) {
    dist += cycle_rows;
  }
  let trail_len = max(5.0, rows_f * p_trail() * (0.45 + h_len * 0.65) * (0.8 + b * 0.35));
  let norm_d = clamp(dist / trail_len, 0.0, 1.0);
  let in_tail = select(0.0, pow(1.0 - norm_d, 1.65), dist >= 0.0 && dist < trail_len);
  let is_head = exp(-pow(dist * 1.35, 2.0));

  // Glyph selection: brighter image regions pick denser glyphs + live mutation on beats
  let mut_rate = 1.8 + p_glitch() * 8.0 + energy * 5.0;
  let cell_seed = u32(max(0, row_i)) * 37u + col_i * 193u;
  let mut_step = u32(floor(t * mut_rate * (0.45 + hash2(cell_seed, 11u))));
  let luma_tier = u32(clamp(floor((luma_m * 0.75 + edge_m * 0.35) * 10.0), 0.0, 10.0));
  let glyph_idx = luma_tier + (hash_u32(cell_seed ^ (mut_step * 2654435761u)) % 6u);
  let g_px = sample_glyph(glyph_idx, local);

  // Combine media image structure with cascading matrix streams
  let media_drive = clamp(pow(luma_m, 0.85) * 1.15 + edge_m * 0.55 * p_edge_boost(), 0.0, 1.8);
  let stream_drive = in_tail * (0.35 + 0.95 * media_drive) + is_head * (0.55 + 0.85 * media_drive + 0.65 * on);
  let base_image_glyph = media_drive * (0.42 + 0.38 * b + 0.35 * on);
  let glyph_energy = max(stream_drive, base_image_glyph);

  // Phosphor color blended with source image color
  let pal_bg = palette(0.03) * 0.14;
  let pal_ink = palette(clamp(0.28 + luma_m * 0.45 + in_tail * 0.22, 0.0, 1.0));
  let pal_head = mix(palette(0.95), vec3f(1.0, 1.0, 1.0), 0.65);

  let tinted_src = mix(pal_ink, src_col * 1.35 + pal_ink * 0.2, p_color_mix());
  let ink_col = mix(tinted_src, pal_head, clamp(is_head * 0.85 + edge_m * 0.25 * p_edge_boost(), 0.0, 1.0));

  // Faint underlying media glow inside each cell so silhouettes read clearly even between strokes
  let cell_glow = tinted_src * (0.08 + 0.16 * luma_m) * (0.65 + 0.45 * in_tail);
  var col = pal_bg + cell_glow + ink_col * g_px * glyph_energy * p_glow();

  // Glitch band phosphor flash
  col += palette(0.75) * glitch_on * (0.14 + 0.22 * energy) * (0.4 + 0.6 * g_px);

  // CRT scanlines
  let scan = 1.0 - p_scanlines() * (0.5 + 0.5 * sin(uv.y * resolution().y * 3.14159));
  col *= scan;

  return vec4f(clamp(col, vec3f(0.0), vec3f(3.2)), 1.0);
}
