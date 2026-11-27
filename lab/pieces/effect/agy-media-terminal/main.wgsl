// Multi-charset live phosphor terminal (ASCII, 2x4 Braille, Hex telemetry, ANSI blocks)
// driven by media luma, directional edge wireframe lock, beat scan beam, and onset glitches.

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

// 12-step ASCII density ramp: ' ', '.', ':', '-', '=', '+', '*', 'x', '%', '#', '@', block
fn ascii_bits(idx: u32) -> u32 {
  switch (idx) {
    case 0u:  { return 0u; }
    case 1u:  { return pack6(0x00u, 0x00u, 0x00u, 0x00u, 0x04u, 0x00u); } // .
    case 2u:  { return pack6(0x00u, 0x04u, 0x00u, 0x00u, 0x04u, 0x00u); } // :
    case 3u:  { return pack6(0x00u, 0x00u, 0x0Eu, 0x00u, 0x00u, 0x00u); } // -
    case 4u:  { return pack6(0x00u, 0x0Eu, 0x00u, 0x0Eu, 0x00u, 0x00u); } // =
    case 5u:  { return pack6(0x00u, 0x04u, 0x1Fu, 0x04u, 0x00u, 0x00u); } // +
    case 6u:  { return pack6(0x00u, 0x15u, 0x0Eu, 0x15u, 0x00u, 0x00u); } // *
    case 7u:  { return pack6(0x00u, 0x11u, 0x0Au, 0x04u, 0x0Au, 0x11u); } // x
    case 8u:  { return pack6(0x0Bu, 0x0Bu, 0x04u, 0x04u, 0x1Au, 0x1Au); } // %
    case 9u:  { return pack6(0x0Au, 0x1Fu, 0x0Au, 0x0Au, 0x1Fu, 0x0Au); } // #
    case 10u: { return pack6(0x0Eu, 0x11u, 0x15u, 0x1Du, 0x01u, 0x0Eu); } // @
    default:  { return pack6(0x1Fu, 0x1Bu, 0x1Fu, 0x1Fu, 0x1Bu, 0x1Fu); } // dense
  }
}

// 16 hex digits: 0-9 A-F
fn hex_bits(idx: u32) -> u32 {
  switch (idx & 15u) {
    case 0u:  { return pack6(0x0Eu, 0x11u, 0x13u, 0x15u, 0x19u, 0x0Eu); } // 0
    case 1u:  { return pack6(0x04u, 0x0Cu, 0x04u, 0x04u, 0x04u, 0x0Eu); } // 1
    case 2u:  { return pack6(0x0Eu, 0x11u, 0x02u, 0x04u, 0x08u, 0x1Fu); } // 2
    case 3u:  { return pack6(0x0Eu, 0x11u, 0x06u, 0x01u, 0x11u, 0x0Eu); } // 3
    case 4u:  { return pack6(0x02u, 0x06u, 0x0Au, 0x1Fu, 0x02u, 0x02u); } // 4
    case 5u:  { return pack6(0x1Fu, 0x10u, 0x1Eu, 0x01u, 0x11u, 0x0Eu); } // 5
    case 6u:  { return pack6(0x0Eu, 0x10u, 0x1Eu, 0x11u, 0x11u, 0x0Eu); } // 6
    case 7u:  { return pack6(0x1Fu, 0x01u, 0x02u, 0x04u, 0x08u, 0x08u); } // 7
    case 8u:  { return pack6(0x0Eu, 0x11u, 0x0Eu, 0x11u, 0x11u, 0x0Eu); } // 8
    case 9u:  { return pack6(0x0Eu, 0x11u, 0x0Fu, 0x01u, 0x11u, 0x0Eu); } // 9
    case 10u: { return pack6(0x0Eu, 0x11u, 0x11u, 0x1Fu, 0x11u, 0x11u); } // A
    case 11u: { return pack6(0x1Eu, 0x11u, 0x1Eu, 0x11u, 0x11u, 0x1Eu); } // B
    case 12u: { return pack6(0x0Eu, 0x11u, 0x10u, 0x10u, 0x11u, 0x0Eu); } // C
    case 13u: { return pack6(0x1Cu, 0x12u, 0x11u, 0x11u, 0x12u, 0x1Cu); } // D
    case 14u: { return pack6(0x1Fu, 0x10u, 0x1Cu, 0x10u, 0x10u, 0x1Fu); } // E
    default:  { return pack6(0x1Fu, 0x10u, 0x1Cu, 0x10u, 0x10u, 0x10u); } // F
  }
}

// Directional contour glyphs: | - / \ +
fn edge_bits(dir_i: u32) -> u32 {
  switch (dir_i % 5u) {
    case 0u: { return pack6(0x04u, 0x04u, 0x04u, 0x04u, 0x04u, 0x04u); } // |
    case 1u: { return pack6(0x00u, 0x00u, 0x1Fu, 0x1Fu, 0x00u, 0x00u); } // -
    case 2u: { return pack6(0x01u, 0x02u, 0x04u, 0x08u, 0x10u, 0x10u); } // /
    case 3u: { return pack6(0x10u, 0x08u, 0x04u, 0x02u, 0x01u, 0x01u); } // \
    default: { return pack6(0x04u, 0x04u, 0x1Fu, 0x04u, 0x04u, 0x00u); } // +
  }
}

fn sample_bits(bits: u32, local: vec2f) -> f32 {
  let gx = i32(floor(local.x * 6.0));
  let gy = i32(floor(local.y * 8.0)) - 1;
  if (gx < 0 || gx >= 5 || gy < 0 || gy >= 6) {
    return 0.0;
  }
  let shift = u32(gy * 5 + gx);
  return f32((bits >> shift) & 1u);
}

fn rgb_luma(c: vec3f) -> f32 {
  let p = max(c, vec3f(0.0));
  let tm = p / (vec3f(0.55) + p);
  return clamp(dot(tm, vec3f(0.2126, 0.7152, 0.0722)), 0.0, 1.0);
}

fn shade(uv: vec2f) -> vec4f {
  let res = resolution();
  let scale = res.y / 1080.0;
  let t = time();
  let b = bass();
  let on = onset();
  let r = rms();
  let ph = phase();
  let beat_kick = pow(max(0.0, 1.0 - ph * 2.6), 2.1) * (0.35 + 0.65 * b);
  let energy = clamp(on * 1.15 + beat_kick * 0.85 + r * 0.45, 0.0, 1.6);

  // Onset-triggered horizontal terminal glitch strips
  let glitch_t = u32(floor(t * 15.0 + on * 10.0 + bar() * 3.0));
  let strip_y = u32(max(0.0, floor(uv.y * 24.0)));
  let strip_r = hash2(strip_y, glitch_t);
  let tear_prob = clamp(p_glitch() * (0.06 + 0.34 * energy), 0.0, 0.62);
  let glitch_on = step(1.0 - tear_prob, strip_r);
  let glitch_dx = (hash2(strip_y + 71u, glitch_t) - 0.5) * 0.075 * p_glitch() * (0.28 + energy) * glitch_on;
  let uv_g = clamp(uv + vec2f(glitch_dx, 0.0), vec2f(0.001), vec2f(0.999));

  // Character cell grid that breathes subtly with bass
  let cell_breath = 1.0 + 0.14 * (b * 0.8 + beat_kick * 0.55);
  let cell_h = max(5.0, p_cell() * cell_breath * scale);
  let cell_w = max(4.0, cell_h * 0.64);
  let cell_sz = vec2f(cell_w, cell_h);

  let px = uv_g * res;
  let cell_f = floor(px / cell_sz);
  let local = fract(px / cell_sz);
  let col_i = u32(max(0.0, cell_f.x));
  let row_i = u32(max(0.0, cell_f.y));
  let cell_uv = clamp((cell_f + 0.5) * cell_sz / res, vec2f(0.001), vec2f(0.999));

  // Source media sample with RGB phosphor convergence split on onsets/glitch strips
  let rgb_off = (0.0015 + 0.011 * p_glitch() * (energy * 0.55 + glitch_on * 0.85)) / max(aspect(), 0.5);
  let sr = tex_in(clamp(cell_uv + vec2f(rgb_off, 0.0), vec2f(0.001), vec2f(0.999))).r;
  let sg = tex_in(cell_uv).g;
  let sb = tex_in(clamp(cell_uv - vec2f(rgb_off, 0.0), vec2f(0.001), vec2f(0.999))).b;
  let src_col = max(vec3f(sr, sg, sb), vec3f(0.0));

  // Luma and edge gradient (use wired core-media ports if present, else compute from tex_in)
  let luma_port = clamp(tex_luma(cell_uv).x, 0.0, 1.0);
  let luma_in = rgb_luma(src_col);
  let luma_m = clamp(select(luma_port, luma_in, luma_port < 0.0005 && luma_in > 0.001), 0.0, 1.0);

  let e_port = tex_edges(cell_uv).xy;
  let step_uv = max(cell_sz / res, vec2f(2.0) / res);
  let lx = rgb_luma(tex_in(clamp(cell_uv + vec2f(step_uv.x, 0.0), vec2f(0.001), vec2f(0.999))).rgb)
         - rgb_luma(tex_in(clamp(cell_uv - vec2f(step_uv.x, 0.0), vec2f(0.001), vec2f(0.999))).rgb);
  let ly = rgb_luma(tex_in(clamp(cell_uv + vec2f(0.0, step_uv.y), vec2f(0.001), vec2f(0.999))).rgb)
         - rgb_luma(tex_in(clamp(cell_uv - vec2f(0.0, step_uv.y), vec2f(0.001), vec2f(0.999))).rgb);
  let e_in = vec2f(lx, ly) * 2.4;
  let edge_v = select(e_port, e_in, dot(e_port, e_port) < 0.0001);
  let edge_m = clamp(length(edge_v), 0.0, 2.0);

  // Audio band per terminal column + beat-locked phosphor raster scan beam
  let b_col = band(i32(col_i % 16u));
  let beam_y = fract(t * 0.24 * (0.75 + 0.45 * b) + floor(bar()) * 0.25);
  let beam_d = abs(uv.y - beam_y);
  let beam_wrap = min(beam_d, 1.0 - beam_d);
  let beam_hit = exp(-pow(beam_wrap * 11.0, 2.0)) * p_scan_beam() * (0.5 + 0.65 * energy);

  // Live byte mutation seed
  let cell_seed = row_i * 73u + col_i * 211u;
  let mut_rate = 2.0 + p_glitch() * 9.0 + energy * 6.0;
  let mut_step = u32(floor(t * mut_rate * (0.35 + hash2(cell_seed, 17u))));
  let cell_rnd = hash2(cell_seed, mut_step);

  // Contrast-boosted luma for glyph density
  let luma_drive = clamp(luma_m * (1.05 + b * 0.35 + beat_kick * 0.25) + b_col * 0.09 + beam_hit * 0.16 + 0.04, 0.0, 1.0);
  let charset = i32(round(p_charset()));

  // Directional edge glyph decision
  let edge_thresh = clamp(0.46 - 0.12 * energy, 0.22, 0.55);
  let is_edge = edge_m * p_edge_lock() > edge_thresh;
  let ang = atan2(edge_v.y, edge_v.x);
  // Tangent direction is perpendicular to gradient
  let tang_sector = u32(floor(fract((ang / 3.14159265) + 1.125) * 4.0));
  var edge_dir_i = 0u;
  if (tang_sector == 0u) { edge_dir_i = 0u; }      // |
  else if (tang_sector == 1u) { edge_dir_i = 2u; } // /
  else if (tang_sector == 2u) { edge_dir_i = 1u; } // -
  else { edge_dir_i = 3u; }                        // \

  var glyph_px = 0.0;
  if (charset == 1) {
    // 2x4 Sub-sampled Braille dot matrix: samples 2x4 sub-cells of the actual media!
    let sub_col = i32(clamp(floor(local.x * 2.0), 0.0, 1.0));
    let sub_row = i32(clamp(floor(local.y * 4.0), 0.0, 3.0));
    let sub_local = fract(vec2f(local.x * 2.0, local.y * 4.0));
    let sub_off = (vec2f((f32(sub_col) + 0.5) * 0.5, (f32(sub_row) + 0.5) * 0.25) - vec2f(0.5)) * (cell_sz / res);
    let sub_uv = clamp(cell_uv + sub_off, vec2f(0.001), vec2f(0.999));
    let sub_luma = rgb_luma(tex_in(sub_uv).rgb) * (1.05 + b * 0.35 + beat_kick * 0.28) + b_col * 0.08;
    // Ordered threshold per dot so gradients resolve cleanly into Braille patterns
    let dot_id = sub_row * 2 + sub_col;
    let dot_thr = 0.14 + f32((dot_id * 5 + 1) % 8) * 0.088;
    let dot_lit = select(0.0, 1.0, sub_luma + edge_m * 0.25 * p_edge_lock() + beam_hit * 0.18 > dot_thr || (glitch_on > 0.5 && cell_rnd > 0.45));
    let dot_dist = length(sub_local - vec2f(0.5));
    let dot_shape = smoothstep(0.42, 0.22, dot_dist);
    glyph_px = dot_lit * dot_shape;
  } else if (charset == 2) {
    // Hex telemetry dump: 0-9 A-F driven by luma + live mutation + edge crosshairs
    if (is_edge && p_edge_lock() > 0.35 && glitch_on < 0.5) {
      let ebits = select(edge_bits(edge_dir_i), edge_bits(4u), edge_m > 0.85);
      glyph_px = sample_bits(ebits, local);
    } else {
      let hex_i = u32(clamp(floor(luma_drive * 15.0 + cell_rnd * (2.5 + 8.0 * glitch_on + 3.0 * energy)), 0.0, 15.0));
      let cell_on = step(0.11, luma_drive + glitch_on * 0.35);
      glyph_px = sample_bits(hex_bits(hex_i), local) * cell_on;
    }
  } else if (charset == 3) {
    // ANSI shade blocks (░▒▓█▄▀) with crisp edge brackets
    if (is_edge && p_edge_lock() > 0.45) {
      glyph_px = sample_bits(edge_bits(edge_dir_i), local);
    } else {
      let bx = u32(floor(local.x * 4.0));
      let by = u32(floor(local.y * 4.0));
      let checker = ((bx + by) & 1u) == 0u;
      let sparse = ((bx & 1u) == 0u) && ((by & 1u) == 0u);
      let in_pad = local.x > 0.08 && local.x < 0.92 && local.y > 0.08 && local.y < 0.92;
      if (in_pad) {
        if (luma_drive > 0.78) { glyph_px = 1.0; }
        else if (luma_drive > 0.56) { glyph_px = select(0.45, 1.0, checker || local.y < 0.5); }
        else if (luma_drive > 0.34) { glyph_px = select(0.0, 1.0, checker); }
        else if (luma_drive > 0.14) { glyph_px = select(0.0, 1.0, sparse); }
      }
    }
  } else {
    // Classic ASCII density ramp + directional wireframe edges
    if (is_edge && p_edge_lock() > 0.35 && glitch_on < 0.5) {
      glyph_px = sample_bits(edge_bits(edge_dir_i), local);
    } else {
      var ramp = luma_drive * 11.0;
      if (glitch_on > 0.5) {
        ramp = fract(cell_rnd + t * 0.7) * 11.0;
      }
      let gi = u32(clamp(floor(ramp + 0.5), 0.0, 11.0));
      glyph_px = sample_bits(ascii_bits(gi), local);
    }
  }

  // Phosphor palette color blended with source media colors
  let pal_bg = palette(0.04) * 0.14;
  let pal_fg = palette(clamp(0.24 + luma_drive * 0.62 + beam_hit * 0.18, 0.0, 1.0));
  let pal_hi = mix(palette(0.96), vec3f(1.0, 1.0, 1.0), 0.52);

  let src_tm = src_col / (vec3f(0.48) + src_col);
  let base_ink = mix(pal_fg, max(src_tm * 1.4, pal_fg * 0.25), p_color_mix());
  let edge_boost_k = select(0.0, clamp(edge_m * 0.55 * p_edge_lock(), 0.0, 1.0), is_edge);
  let ink_col = mix(base_ink, pal_hi, clamp(edge_boost_k * 0.65 + beam_hit * 0.45, 0.0, 1.0));

  // Subtle internal phosphor bleed inside each character cell
  let cell_glow = base_ink * (0.07 + 0.18 * luma_drive) * (1.0 - length(local - vec2f(0.5)) * 0.85);
  let glyph_energy = (0.48 + 0.88 * luma_drive + edge_boost_k * 0.55 + beam_hit * 0.75 + beat_kick * 0.28 + on * 0.32) * p_glow();

  var col = pal_bg + max(cell_glow, vec3f(0.0)) + ink_col * glyph_px * glyph_energy;

  // Raster scan beam + onset glitch line highlight
  col += palette(0.85) * beam_hit * 0.22 * (0.35 + 0.65 * glyph_px);
  col += palette(0.72) * glitch_on * (0.14 + 0.26 * energy) * (0.35 + 0.65 * glyph_px);

  // Subtle CRT scanlines
  let scan = 1.0 - p_scanlines() * (0.5 + 0.5 * sin(uv.y * res.y * 1.5707963));
  col *= scan;

  return vec4f(clamp(col, vec3f(0.0), vec3f(3.2)), 1.0);
}
