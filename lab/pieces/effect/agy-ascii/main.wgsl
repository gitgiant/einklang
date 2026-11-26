fn pack6(r0: u32, r1: u32, r2: u32, r3: u32, r4: u32, r5: u32) -> u32 {
  return r0 | (r1 << 5u) | (r2 << 10u) | (r3 << 15u) | (r4 << 20u) | (r5 << 25u);
}

// 12-level procedural 5x6 ASCII glyph density ramp: ' ', '.', ':', '-', '=', '+', '*', 'x', '%', '#', '@', block
fn ascii_glyph_bits(idx: u32) -> u32 {
  switch (idx) {
    case 0u:  { return 0u; }                                                     // ' '
    case 1u:  { return pack6(0x00u, 0x00u, 0x00u, 0x00u, 0x04u, 0x00u); }        // '.'
    case 2u:  { return pack6(0x00u, 0x04u, 0x00u, 0x00u, 0x04u, 0x00u); }        // ':'
    case 3u:  { return pack6(0x00u, 0x00u, 0x0Eu, 0x00u, 0x00u, 0x00u); }        // '-'
    case 4u:  { return pack6(0x00u, 0x0Eu, 0x00u, 0x0Eu, 0x00u, 0x00u); }        // '='
    case 5u:  { return pack6(0x00u, 0x04u, 0x1Fu, 0x04u, 0x00u, 0x00u); }        // '+'
    case 6u:  { return pack6(0x00u, 0x15u, 0x0Eu, 0x15u, 0x00u, 0x00u); }        // '*'
    case 7u:  { return pack6(0x00u, 0x11u, 0x0Au, 0x04u, 0x0Au, 0x11u); }        // 'x'
    case 8u:  { return pack6(0x0Bu, 0x0Bu, 0x04u, 0x04u, 0x1Au, 0x1Au); }        // '%'
    case 9u:  { return pack6(0x0Au, 0x1Fu, 0x0Au, 0x0Au, 0x1Fu, 0x0Au); }        // '#'
    case 10u: { return pack6(0x0Eu, 0x11u, 0x15u, 0x1Du, 0x01u, 0x0Eu); }        // '@'
    default:  { return pack6(0x1Fu, 0x1Bu, 0x1Fu, 0x1Fu, 0x1Bu, 0x1Fu); }        // dense block
  }
}

fn sample_glyph(idx: u32, local: vec2f) -> f32 {
  // 6x8 virtual grid inside each cell: 5x6 glyph with 1px horizontal and 2px vertical breathing margin
  let gx = i32(floor(local.x * 6.0));
  let gy = i32(floor(local.y * 8.0)) - 1;
  if (gx < 0 || gx >= 5 || gy < 0 || gy >= 6) {
    return 0.0;
  }
  let bits = ascii_glyph_bits(idx);
  let shift = u32(gy * 5 + gx);
  return f32((bits >> shift) & 1u);
}

// Recursive 8x8 ordered Bayer matrix normalized to [0, 1)
fn bayer8(p: vec2u) -> f32 {
  let x = p.x & 7u;
  let y = p.y & 7u;
  let xc = x ^ y;
  var v = 0u;
  v = (v << 2u) | (((xc >> 2u) & 1u) << 1u) | ((y >> 2u) & 1u);
  v = (v << 2u) | (((xc >> 1u) & 1u) << 1u) | ((y >> 1u) & 1u);
  v = (v << 2u) | ((xc & 1u) << 1u) | (y & 1u);
  return (f32(v) + 0.5) / 64.0;
}

fn tonemap_01(c: vec3f) -> vec3f {
  let p = max(c, vec3f(0.0));
  return p / (vec3f(0.55) + p);
}

fn shade(uv: vec2f) -> vec4f {
  let res = resolution();
  let src = tex_in(uv).rgb;
  let scale = res.y / 1080.0;

  let b = bass();
  let r = rms();
  let hit = onset();
  let beat_kick = pow(max(0.0, 1.0 - phase() * 2.4), 2.0) * smoothstep(0.10, 0.45, b);
  let punch = clamp(hit * 0.95 + beat_kick * 0.75, 0.0, 1.4);
  let energy = clamp(b * 0.65 + r * 0.55, 0.0, 1.5);

  // Cell size breathes visibly with bass and kicks
  let cell_mod = max(0.42, 1.0 + p_bass() * (b * 1.25 + punch * 0.42));
  let cell_h = max(4.0, p_cell() * cell_mod * scale);
  let cell_w = max(3.0, cell_h * 0.64);
  let cell_sz = vec2f(cell_w, cell_h);

  let mode = i32(round(p_mode()));
  let col_mode = i32(round(p_color()));
  let con = p_contrast() * (0.90 + b * 0.35 + punch * 0.30);

  let px = uv * res;
  var out_col: vec3f;

  if (mode == 1) {
    // Pure ordered 8x8 Bayer dither on bass-breathing pixel blocks
    let block = max(2.0, cell_h * 0.38);
    let blk_idx = floor(px / block);
    let blk_uv = clamp((blk_idx + 0.5) * block / res, vec2f(0.001), vec2f(0.999));
    let c_raw = tex_in(blk_uv).rgb;
    let c_tm = tonemap_01(c_raw * (0.92 + energy * 0.65 + punch * 0.35));
    let thr = bayer8(vec2u(blk_idx)) - 0.5;
    let lvls = max(2.0, round(p_levels()));
    let denom = lvls - 1.0;

    let luma = clamp(dot(c_tm, vec3f(0.2126, 0.7152, 0.0722)) * con, 0.0, 1.0);
    let q_luma = clamp(floor(luma * denom + thr + 0.5) / denom, 0.0, 1.0);

    if (col_mode == 0) {
      let q_rgb = clamp(floor(clamp(c_tm * con, vec3f(0.0), vec3f(1.0)) * denom + vec3f(thr) + 0.5) / denom, vec3f(0.0), vec3f(1.0));
      out_col = mix(p_bg(), q_rgb * (1.05 + punch * 0.35), smoothstep(0.0, 0.08, q_luma + 0.05));
    } else if (col_mode == 1) {
      out_col = mix(p_bg(), p_ink() * (1.15 + punch * 0.45), q_luma);
    } else {
      let pcol = palette(q_luma);
      out_col = mix(p_bg(), pcol * (0.25 + q_luma * (1.15 + punch * 0.40)), smoothstep(0.0, 0.06, q_luma));
    }
  } else {
    // ASCII glyph mode (0 = direct luma ramp, 2 = Bayer-dithered ASCII glyph ramp)
    let cell_idx = floor(px / cell_sz);
    let local = fract(px / cell_sz);
    let cell_uv = clamp((cell_idx + 0.5) * cell_sz / res, vec2f(0.001), vec2f(0.999));

    let c_raw = tex_in(cell_uv).rgb;
    let c_tm = tonemap_01(c_raw * (0.95 + energy * 0.72 + punch * 0.40));
    var luma = clamp(dot(c_tm, vec3f(0.2126, 0.7152, 0.0722)) * con, 0.0, 1.0);
    // Keep subtle minimum glyph activity on quiet passages so the terminal grid stays alive
    luma = clamp(luma + 0.04 + r * 0.05, 0.0, 1.0);

    var ramp = luma * 11.0;
    if (mode == 2) {
      // Hybrid: Bayer 8x8 dither across cell coordinates selects between adjacent glyphs
      let d = bayer8(vec2u(cell_idx)) - 0.5;
      ramp = clamp(ramp + d * 1.15, 0.0, 11.0);
    }
    let glyph_i = u32(clamp(floor(ramp + 0.5), 0.0, 11.0));
    let mask = sample_glyph(glyph_i, local);

    // Subtle phosphor glow bleed inside the cell so glyphs look luminous at 1080p
    let cell_glow = (1.0 - length(local - vec2f(0.5)) * 1.15) * luma * 0.14;
    let boost = 1.05 + energy * 0.35 + punch * 0.48;

    var fg: vec3f;
    if (col_mode == 0) {
      fg = max(c_tm, vec3f(0.06)) * (1.25 * boost);
    } else if (col_mode == 1) {
      fg = p_ink() * (0.35 + luma * 0.95) * boost;
    } else {
      fg = palette(clamp(luma * 0.92 + punch * 0.08, 0.0, 1.0)) * (0.32 + luma * 1.05) * boost;
    }

    let bg_lit = p_bg() + fg * max(cell_glow, 0.0);
    out_col = mix(bg_lit, fg, mask);
  }

  // Subtle horizontal CRT scanlines
  let sl = 1.0 - p_scanlines() * (0.5 + 0.5 * sin(px.y * 1.5707963));
  out_col *= sl;

  return vec4f(mix(src, out_col, p_mix()), 1.0);
}
