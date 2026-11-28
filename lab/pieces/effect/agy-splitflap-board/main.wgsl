// Kinetic architectural split-flap & magnetic flip-dot board.
// Mechanical tiles physically fold through 2.5D perspective waves synced to the beat,
// revealing the user's media as tactile Solari cards and perforated flip-dot matrices.

fn hash_u32(x: u32) -> u32 {
  var v = x * 747796405u + 2891336453u;
  v = ((v >> ((v >> 28u) + 4u)) ^ v) * 277803737u;
  return (v >> 22u) ^ v;
}

fn hash2(a: u32, b: u32) -> f32 {
  return f32(hash_u32(a ^ hash_u32(b * 374761393u + 668265263u)) & 0xFFFFu) / 65536.0;
}

fn soft_clip(c: vec3f) -> vec3f {
  let m = max(c, vec3f(0.0));
  return m / (vec3f(1.0) + m * 0.25);
}

// Render the graphic face of a flap at local card UV (0..1 x 0..1)
fn flap_face(
  face_uv: vec2f,
  base_col: vec3f,
  luma_val: f32,
  edge_val: f32,
  style_i: i32,
  is_alt: bool,
  accent: vec3f
) -> vec3f {
  let card_bg = vec3f(0.045, 0.044, 0.048);

  if (style_i == 0) {
    // Classic Solari matte pigment card with subtle micro-grain and edge corner notch
    let grain = (fract(sin(dot(floor(face_uv * 24.0), vec2f(12.9898, 78.233))) * 43758.5453) - 0.5) * 0.045;
    var face = mix(card_bg, base_col, select(0.92, 0.78, is_alt)) + grain;
    // Crisp inset border pinstripe on bright or high-edge cards
    let inset = min(min(face_uv.x, 1.0 - face_uv.x), min(face_uv.y, 1.0 - face_uv.y));
    let rim = smoothstep(0.11, 0.08, inset) * smoothstep(0.04, 0.07, inset);
    face += accent * rim * (0.14 + edge_val * 0.35);
    return face;
  }

  if (style_i == 1) {
    // Magnetic flip-dot disc mounted on a dark matte backing
    let d = length(face_uv - vec2f(0.5, 0.5));
    let disc_r = 0.24 + clamp(luma_val * 0.21 + edge_val * 0.08, 0.0, 0.22);
    let disc = smoothstep(disc_r + 0.04, disc_r - 0.04, d);
    let spec = smoothstep(0.28, 0.02, length(face_uv - vec2f(0.38, 0.34))) * 0.22 * disc;
    let col_active = select(base_col * 1.15, mix(card_bg * 2.2, accent * 0.7, 0.55), is_alt);
    return mix(card_bg, col_active + spec, disc);
  }

  // Hybrid (style 2): Split-flap card stamped with a crisp 3x3 flip-dot matrix pattern
  let sub = fract(face_uv * 3.0) - 0.5;
  let sub_d = length(sub);
  let dot_r = 0.19 + clamp(luma_val * 0.24 + edge_val * 0.12, 0.0, 0.25);
  let dot_mask = smoothstep(dot_r + 0.07, dot_r - 0.07, sub_d);
  let backing = mix(card_bg, base_col * 0.34, 0.55);
  let dot_col = select(base_col * 1.24 + accent * edge_val * 0.28, mix(base_col * 0.45, accent * 1.05, 0.65), is_alt);
  return mix(backing, dot_col, dot_mask);
}

fn shade(uv: vec2f) -> vec4f {
  let t = time();
  let b = bass();
  let on = onset();
  let r = rms();
  let ph = phase();
  let br = bar();
  let asp = max(aspect(), 0.5);

  let beat_kick = pow(max(0.0, 1.0 - ph * 2.6), 2.0) * (0.25 + 0.75 * b);
  let music_act = clamp(r * 1.15 + b * 0.75 + on * 1.1, 0.0, 1.8);

  // Subtle architectural brushed-aluminum bezel around the arrival board
  let mx = 0.036;
  let my = 0.055;
  let buv = (uv - vec2f(mx, my)) / vec2f(1.0 - 2.0 * mx, 1.0 - 2.0 * my);

  // Overhead gallery spotlight illumination across the board
  let spot_d = length((uv - vec2f(0.5, 0.18)) * vec2f(0.85, 1.15));
  let overhead = (0.78 + 0.42 * exp(-spot_d * spot_d * 1.4)) * p_glow();

  if (buv.x < 0.0 || buv.x > 1.0 || buv.y < 0.0 || buv.y > 1.0) {
    let clamped = clamp(buv, vec2f(0.0), vec2f(1.0));
    let bd = length((buv - clamped) * vec2f(asp, 1.0));
    // Brushed charcoal metal frame with hairline horizontal brush texture
    let brush = 0.94 + 0.06 * sin(uv.y * 420.0);
    var frame_col = vec3f(0.055, 0.056, 0.062) * brush * overhead;
    frame_col *= 0.65 + 0.35 * smoothstep(0.0, 0.025, bd);

    // Top bezel beat-bar counter & 16-band indicator pips
    if (buv.y < 0.0 && buv.x > 0.02 && buv.x < 0.98) {
      let pip_x = buv.x * 24.0;
      let pip_i = i32(floor(pip_x));
      let pf = fract(pip_x) - 0.5;
      let py = (buv.y + 0.028) * 32.0;
      let pd = length(vec2f(pf, py));
      if (pip_i < 4) {
        let is_lit = select(0.15, 1.35, pip_i == i32(floor(br)) % 4);
        frame_col += palette(0.82) * is_lit * smoothstep(0.32, 0.08, pd);
      } else {
        let bv = band((pip_i - 4) % 16);
        frame_col += palette(f32((pip_i - 4) % 16) / 15.0) * (0.1 + bv * 1.45 + on * 0.4) * smoothstep(0.28, 0.06, pd);
      }
    }
    return vec4f(soft_clip(frame_col), 1.0);
  }

  // Mechanical tile grid (tall Solari proportions)
  let cols = max(16.0, floor(p_columns()));
  let rows = max(10.0, floor(cols / max(asp * 0.82, 0.45)));
  let grid = vec2f(cols, rows);
  let pos = buv * grid;
  let cell_f = floor(pos);
  let cell_id = vec2u(u32(max(0.0, cell_f.x)), u32(max(0.0, cell_f.y)));
  let local = fract(pos);
  let cell_uv = clamp((cell_f + 0.5) / grid, vec2f(0.001), vec2f(0.999));
  let cell_seed = cell_id.x * 193u + cell_id.y * 617u;

  // Sample media color, luma, and edges at tile center
  let src_rgb = max(tex_in(cell_uv).rgb, vec3f(0.0));
  let luma_m = clamp(tex_luma(cell_uv).x, 0.0, 1.0);
  let edge_m = clamp(length(tex_edges(cell_uv).xy), 0.0, 2.0);
  let col_band = band(i32(cell_id.x % 16u));

  // Station-board palette color blended with source media
  let pal_col = palette(clamp(luma_m * 0.88 + 0.06, 0.0, 1.0)) * (0.28 + luma_m * 1.12);
  let accent = palette(clamp(0.45 + col_band * 0.45, 0.0, 1.0));
  let dst_col = mix(pal_col, src_rgb * (0.95 + b * 0.28), p_color_mix()) * (0.88 + beat_kick * 0.32 + on * 0.24);

  // Alternate / prior flip face (contrasting high-contrast palette card that flips into the picture!)
  let alt_luma = clamp(pow(luma_m, 1.35) * 0.75 + edge_m * 0.4, 0.0, 1.0);
  let alt_col = palette(clamp(1.0 - alt_luma * 0.75, 0.08, 0.96)) * (0.35 + alt_luma * 0.9 + col_band * 0.4);

  // --- BEAT-SYNCED FLIP CASCADE WAVE ---
  let wmode = i32(floor(p_wave_mode() + 0.5));
  var delay = cell_uv.x * 0.58 + cell_uv.y * 0.42;
  if (wmode == 1) {
    delay = cell_uv.x;
  } else if (wmode == 2) {
    delay = clamp(length((cell_uv - vec2f(0.5)) * vec2f(asp, 1.0)) * 0.95, 0.0, 1.0);
  } else if (wmode == 3) {
    delay = cell_uv.y * 0.72 + hash2(cell_id.x, 37u) * 0.28;
  }
  // Tiny per-tile mechanical jitter so neighboring flaps snap slightly staggered like real hardware
  delay = fract(delay + hash2(cell_seed, 19u) * 0.08);

  // Beat wave sweeps across the board every beat; depth scales clearly with audio energy
  let wave_amp = clamp(p_flip() * (0.08 + music_act * 0.72), 0.0, 1.0);
  let wave_raw = fract(ph - delay * 0.65 + 1.0);
  let flip_dur = clamp(0.24 + wave_amp * 0.28, 0.18, 0.54);
  let in_wave = wave_raw < flip_dur && (hash2(cell_seed, u32(floor(br + t * 0.5))) < (0.14 + wave_amp * 0.86));
  var flip_t = select(0.0, clamp(wave_raw / flip_dur, 0.0, 1.0), in_wave);

  // Secondary mechanical chatter on onsets along media edges & high-band columns
  let chat_gate = clamp(p_chatter() * (on * 0.85 + col_band * 0.42) * (0.25 + edge_m * 0.95), 0.0, 1.0);
  let chat_roll = hash2(cell_seed, u32(floor(t * 11.0)));
  if (flip_t == 0.0 && chat_roll < chat_gate * 0.45) {
    flip_t = fract(t * 9.0 + hash2(cell_seed, 53u));
  }

  // Smooth mechanical acceleration (gravity-assisted snap)
  let eased_t = flip_t * flip_t * (3.0 - 2.0 * flip_t);
  let angle = eased_t * 3.14159265;
  let ca = cos(angle);
  let sa = sin(angle);

  // --- PHYSICAL SPLIT-FLAP HOUSING, HINGE & 2.5D FALLING LEAF ---
  // Outer recessed dark slot between adjacent mechanical tiles
  let pad = vec2f(0.07, 0.055);
  let in_slot = local.x > pad.x && local.x < (1.0 - pad.x) && local.y > pad.y && local.y < (1.0 - pad.y);
  let cavity = vec3f(0.015, 0.016, 0.020);
  if (!in_slot) {
    // Subtle dark aluminum housing dividers
    let div_light = 0.032 * overhead;
    return vec4f(soft_clip(cavity + vec3f(div_light)), 1.0);
  }

  // Remap inside card (0..1 x 0..1)
  let card_uv = (local - pad) / (vec2f(1.0) - 2.0 * pad);
  let style_i = i32(floor(p_style() + 0.5));

  var col = cavity;
  let is_flipping = flip_t > 0.001 && flip_t < 0.999;

  if (!is_flipping) {
    // Resting tile showing the crisp live picture
    col = flap_face(card_uv, dst_col, luma_m, edge_m, style_i, false, accent);
    // Subtle top-vs-bottom lighting gradient on the two flap leaves
    col *= select(0.92, 1.04, card_uv.y < 0.5);
  } else if (card_uv.y < 0.5) {
    // UPPER HALF of the tile
    if (ca > 0.0) {
      let leaf_top = 0.5 - 0.5 * ca;
      if (card_uv.y >= leaf_top) {
        // Foreshortened falling upper flap (showing departing/alt face catching overhead light!)
        let mapped_y = clamp((card_uv.y - leaf_top) / max(0.5 * ca, 0.02) * 0.5, 0.0, 0.5);
        let f_col = flap_face(vec2f(card_uv.x, mapped_y), alt_col, alt_luma, edge_m, style_i, true, accent);
        let spec = pow(sa, 2.2) * 0.55;
        col = f_col * (0.55 + 0.55 * ca) + vec3f(0.95, 0.92, 0.85) * spec;
      } else {
        // Newly uncovered destination top half behind the falling leaf
        let d_col = flap_face(card_uv, dst_col, luma_m, edge_m, style_i, false, accent);
        let ao = 0.72 + 0.28 * smoothstep(leaf_top, leaf_top - 0.22, card_uv.y);
        col = d_col * 1.04 * ao;
      }
    } else {
      // Past 90 degrees: destination top half fully revealed!
      col = flap_face(card_uv, dst_col, luma_m, edge_m, style_i, false, accent) * 1.04;
    }
  } else {
    // LOWER HALF of the tile
    if (ca >= 0.0) {
      // Waiting bottom half receiving soft moving shadow from the falling top leaf
      let o_col = flap_face(card_uv, alt_col, alt_luma, edge_m, style_i, true, accent);
      let shadow = 1.0 - 0.58 * sa * exp(-(card_uv.y - 0.5) * 4.5);
      col = o_col * 0.92 * shadow;
    } else {
      let leaf_bot = 0.5 + 0.5 * (-ca);
      if (card_uv.y <= leaf_bot) {
        // Falling flap slapping down onto the bottom half (destination face gleaming!)
        let mapped_y = 0.5 + clamp((card_uv.y - 0.5) / max(0.5 * (-ca), 0.02) * 0.5, 0.0, 0.5);
        let d_col = flap_face(vec2f(card_uv.x, mapped_y), dst_col, luma_m, edge_m, style_i, false, accent);
        let glint = pow(sa, 2.5) * 0.48;
        col = d_col * (0.62 + 0.38 * (-ca)) + (accent * 0.4 + vec3f(0.6)) * glint;
      } else {
        // Old bottom half about to be covered
        let o_col = flap_face(card_uv, alt_col, alt_luma, edge_m, style_i, true, accent);
        col = o_col * 0.78;
      }
    }
  }

  // Center mechanical split-flap hinge seam & metallic side pins (for split-flap & hybrid styles)
  if (style_i != 1) {
    let hinge_d = abs(card_uv.y - 0.5);
    if (hinge_d < 0.032) {
      col *= 0.16;
    } else if (hinge_d < 0.055) {
      col *= 0.78;
    }
    // Tiny steel hinge pins on left & right edge of center split
    if (hinge_d < 0.075 && (card_uv.x < 0.09 || card_uv.x > 0.91)) {
      col = vec3f(0.24, 0.25, 0.28) * overhead;
    }
  }

  // Apply overhead architectural lighting
  col *= overhead;

  return vec4f(soft_clip(col), 1.0);
}
