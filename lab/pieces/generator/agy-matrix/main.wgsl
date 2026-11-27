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

// 24 procedural 5x6 Matrix / half-width Katakana-inspired & numeric glyphs
fn matrix_glyph_bits(idx: u32) -> u32 {
  switch (idx % 24u) {
    case 0u:  { return pack6(0x1Fu, 0x04u, 0x04u, 0x04u, 0x04u, 0x0Eu); } // テ / T-hook
    case 1u:  { return pack6(0x1Fu, 0x10u, 0x08u, 0x04u, 0x02u, 0x1Fu); } // Z / マ
    case 2u:  { return pack6(0x0Eu, 0x11u, 0x15u, 0x15u, 0x11u, 0x0Eu); } // 0 / dotted
    case 3u:  { return pack6(0x04u, 0x0Cu, 0x04u, 0x04u, 0x04u, 0x0Eu); } // 1
    case 4u:  { return pack6(0x1Fu, 0x08u, 0x1Fu, 0x08u, 0x08u, 0x04u); } // キ
    case 5u:  { return pack6(0x11u, 0x11u, 0x1Fu, 0x10u, 0x08u, 0x04u); } // ク / サ
    case 6u:  { return pack6(0x04u, 0x1Fu, 0x04u, 0x1Fu, 0x04u, 0x0Eu); } // 丰
    case 7u:  { return pack6(0x1Fu, 0x01u, 0x0Fu, 0x01u, 0x01u, 0x1Fu); } // コ / E
    case 8u:  { return pack6(0x0Au, 0x0Au, 0x1Fu, 0x04u, 0x0Au, 0x11u); } // ホ
    case 9u:  { return pack6(0x1Fu, 0x10u, 0x10u, 0x08u, 0x04u, 0x02u); } // 7 / フ
    case 10u: { return pack6(0x0Eu, 0x11u, 0x0Eu, 0x11u, 0x11u, 0x0Eu); } // 8
    case 11u: { return pack6(0x0Eu, 0x11u, 0x0Fu, 0x08u, 0x04u, 0x0Eu); } // 9
    case 12u: { return pack6(0x04u, 0x0Au, 0x11u, 0x1Fu, 0x11u, 0x11u); } // A
    case 13u: { return pack6(0x11u, 0x19u, 0x15u, 0x13u, 0x11u, 0x11u); } // N
    case 14u: { return pack6(0x1Fu, 0x04u, 0x04u, 0x1Fu, 0x04u, 0x04u); } // 干
    case 15u: { return pack6(0x02u, 0x04u, 0x1Fu, 0x04u, 0x08u, 0x10u); } // ナ / slant
    case 16u: { return pack6(0x15u, 0x15u, 0x1Fu, 0x04u, 0x04u, 0x1Fu); } // ヨ
    case 17u: { return pack6(0x1Fu, 0x11u, 0x11u, 0x1Fu, 0x04u, 0x08u); } // ロ / ヌ
    case 18u: { return pack6(0x04u, 0x1Fu, 0x15u, 0x15u, 0x04u, 0x0Au); } // 中
    case 19u: { return pack6(0x11u, 0x0Au, 0x04u, 0x0Au, 0x11u, 0x00u); } // メ
    case 20u: { return pack6(0x0Eu, 0x02u, 0x1Fu, 0x08u, 0x04u, 0x1Fu); } // ス
    case 21u: { return pack6(0x1Fu, 0x08u, 0x04u, 0x04u, 0x08u, 0x1Fu); } // ユ
    case 22u: { return pack6(0x04u, 0x04u, 0x1Fu, 0x15u, 0x11u, 0x0Eu); } // ウ
    default:  { return pack6(0x15u, 0x0Eu, 0x1Fu, 0x0Eu, 0x15u, 0x04u); } // glyph star
  }
}

fn sample_matrix_glyph(idx: u32, local: vec2f) -> f32 {
  let gx = i32(floor(local.x * 6.0));
  let gy = i32(floor(local.y * 8.0)) - 1;
  if (gx < 0 || gx >= 5 || gy < 0 || gy >= 6) {
    return 0.0;
  }
  let bits = matrix_glyph_bits(idx);
  let shift = u32(gy * 5 + gx);
  return f32((bits >> shift) & 1u);
}

struct LayerHit {
  col: vec3f,
  alpha: f32,
};

fn rain_layer(
  uv: vec2f,
  cols_f: f32,
  seed_off: u32,
  speed_mul: f32,
  bright_mul: f32,
  beat_time: f32,
  beat_surge: f32,
  flare_env: f32,
  bar_idx: u32,
) -> LayerHit {
  let asp = aspect();
  let rows_f = max(12.0, floor(cols_f / max(asp * 0.62, 0.35)));
  let grid = vec2f(cols_f, rows_f);
  let pos = uv * grid;
  let col_i = u32(max(0.0, floor(pos.x)));
  let row_i = i32(floor(pos.y));
  let local = fract(pos);

  let h_col = hash2(col_i + seed_off, 17u + seed_off);
  let h_spd = hash2(col_i + seed_off, 43u + seed_off);
  let h_len = hash2(col_i + seed_off, 97u + seed_off);
  let h_act = hash2(col_i + seed_off, 131u + seed_off);

  // Density gate so some columns rest while others stream
  if (h_act > p_density()) {
    return LayerHit(vec3f(0.0), 0.0);
  }

  let b_val = band(i32(col_i % 16u));
  let col_speed = (0.55 + h_spd * 1.15) * speed_mul;
  let cycle_rows = rows_f * (1.25 + h_len * 0.95);
  let head_y = fract((beat_time * col_speed * 0.19 + h_col) + beat_surge * 0.022) * cycle_rows - 2.0;

  // Distance behind the falling head in rows
  var dist = head_y - f32(row_i);
  if (dist < 0.0) {
    dist += cycle_rows;
  }

  let trail_len = max(4.0, rows_f * p_trail() * (0.45 + h_len * 0.65) * (0.85 + b_val * 0.35));
  let in_tail = dist >= 0.0 && dist < trail_len;

  // Onset column flare: a seeded subset of columns flares brightly on each onset / beat bar
  let flare_pick = hash2(col_i + seed_off, bar_idx * 13u + 7u);
  let col_flare = flare_env * smoothstep(0.62, 0.96, flare_pick) * p_flare();

  // Glyph selection: mutates over time (faster near head, on high glitch, and during column flare)
  let mut_rate = 1.5 + p_glitch() * 9.0 + col_flare * 10.0;
  let cell_seed = u32(max(0, row_i)) * 31u + col_i * 197u + seed_off;
  let time_step = u32(floor(time() * mut_rate * (0.5 + hash2(cell_seed, 5u))));
  let glyph_idx = hash_u32(cell_seed ^ (time_step * 2654435761u));
  let g_mask = sample_matrix_glyph(glyph_idx, local);

  var acc = vec3f(0.0);
  var alpha = 0.0;

  if (in_tail) {
    let norm_d = dist / trail_len;
    let tail_fade = pow(max(0.0, 1.0 - norm_d), 1.85);
    let is_head = dist < 1.15;
    let near_head = smoothstep(3.5, 0.0, dist);

    // Palette colors: deep tail -> bright mid-tail -> white-hot head
    let tail_col = palette(clamp(0.32 + (1.0 - norm_d) * 0.52 + col_flare * 0.16, 0.0, 1.0));
    let head_col = mix(palette(0.95), vec3f(1.0, 1.0, 1.0), 0.72);

    let cell_lum = (tail_fade * (0.65 + b_val * 0.75) + col_flare * 0.95) * p_glow() * bright_mul;
    let glyph_rgb = select(tail_col * cell_lum * 1.45, head_col * (1.85 + col_flare * 0.85) * p_glow() * bright_mul, is_head);

    // Soft phosphor halo around the head and active glyphs
    let center_d = length(local - vec2f(0.5));
    let head_halo = exp(-center_d * center_d * 5.5) * near_head * 0.42 * p_glow() * bright_mul;
    let tail_halo = exp(-center_d * center_d * 4.0) * tail_fade * (0.08 + col_flare * 0.22) * bright_mul;

    acc += glyph_rgb * g_mask + mix(tail_col, head_col, near_head) * (head_halo + tail_halo);
    alpha = clamp(tail_fade + col_flare * 0.5, 0.0, 1.0);
  }

  // Vertical onset flare beam running through flaring columns
  if (col_flare > 0.02) {
    let beam_x = exp(-pow((local.x - 0.5) * 3.6, 2.0));
    let flare_col = mix(palette(0.85), vec3f(0.95, 1.0, 1.0), 0.35);
    acc += flare_col * beam_x * col_flare * 0.26 * bright_mul * (0.55 + 0.45 * g_mask);
  }

  return LayerHit(acc, alpha);
}

fn shade(uv: vec2f) -> vec4f {
  let b = bass();
  let r = rms();
  let hit = onset();
  let beat_kick = pow(max(0.0, 1.0 - phase() * 2.5), 2.0) * smoothstep(0.10, 0.45, b);
  let flare_env = clamp(hit * 1.15 + beat_kick * 0.75, 0.0, 1.5);

  // Beat-synced rain velocity: tempo sets base fall rate, beat phase adds tactile downward pulse
  let tempo_scale = clamp(bpm() / 120.0, 0.5, 2.2);
  let beat_time = time() * tempo_scale * p_speed();
  let beat_surge = -sin(phase() * 6.2831853) * (0.35 + b * 0.85);
  let bar_idx = u32(max(0.0, floor(bar() + time() * 0.5)));

  // Deep terminal backdrop with subtle vignette and audio breathing
  let vig = 1.0 - dot(uv - vec2f(0.5), uv - vec2f(0.5)) * 0.85;
  var col = palette(0.06) * (0.045 + r * 0.04 + flare_env * 0.025) * max(vig, 0.25);

  let cols_fg = clamp(round(p_columns()), 24.0, 140.0);

  // Parallax background layer: denser, slower, atmospheric
  if (p_depth() > 0.01) {
    let bg_hit = rain_layer(
      uv + vec2f(0.004, 0.0),
      floor(cols_fg * 1.55),
      7919u,
      0.58,
      0.34 * p_depth(),
      beat_time,
      beat_surge * 0.5,
      flare_env * 0.6,
      bar_idx + 3u,
    );
    col += bg_hit.col;
  }

  // Foreground crisp rain layer
  let fg_hit = rain_layer(
    uv,
    cols_fg,
    101u,
    1.0,
    1.0,
    beat_time,
    beat_surge,
    flare_env,
    bar_idx,
  );
  col += fg_hit.col;

  // Subtle horizontal phosphor scanline texture
  let px_y = uv.y * resolution().y;
  col *= 1.0 - 0.10 * (0.5 + 0.5 * sin(px_y * 1.5707963));

  return vec4f(max(col, vec3f(0.0)), 1.0);
}
