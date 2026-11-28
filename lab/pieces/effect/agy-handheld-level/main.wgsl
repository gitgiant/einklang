// 4-colour dot-matrix handheld game screen where the input media becomes a scrolling
// 8x8 tiled platformer level with spinning beat coins, HUD bar, and a leaping pixel runner.

fn bayer4(p: vec2i) -> f32 {
  let x = ((p.x % 4) + 4) % 4;
  let y = ((p.y % 4) + 4) % 4;
  var m = array<f32, 16>(
     0.0,  8.0,  2.0, 10.0,
    12.0,  4.0, 14.0,  6.0,
     3.0, 11.0,  1.0,  9.0,
    15.0,  7.0, 13.0,  5.0
  );
  return (m[y * 4 + x] + 0.5) / 16.0;
}

fn hash_u32(x: u32) -> u32 {
  var v = x * 747796405u + 2891336453u;
  v = ((v >> ((v >> 28u) + 4u)) ^ v) * 277803737u;
  return (v >> 22u) ^ v;
}

fn hash2i(a: i32, b: i32) -> f32 {
  let ua = bitcast<u32>(a);
  let ub = bitcast<u32>(b);
  return f32(hash_u32(ua ^ hash_u32(ub * 374761393u + 668265263u)) & 0xFFFFu) / 65536.0;
}

fn soft_clip(c: vec3f) -> vec3f {
  let m = max(c, vec3f(0.0));
  return m / (vec3f(1.0) + m * 0.22);
}

// Seamless ping-pong horizontal wrap so any still photo or video scrolls infinitely
fn world_media_uv(wx: f32, wy: f32) -> vec2f {
  let u_raw = wx / 176.0;
  let u_wrap = abs(fract(u_raw * 0.5) * 2.0 - 1.0);
  let v_wrap = clamp((wy - 10.0) / 94.0, 0.002, 0.998);
  return vec2f(clamp(u_wrap, 0.002, 0.998), v_wrap);
}

// Evaluate whether 8x8 world tile (tx, ty) is a solid platform derived from the media
fn is_solid_tile(tx: i32, ty: i32, b: f32) -> bool {
  if (ty <= 3) {
    return false; // open sky + HUD band
  }
  if (ty >= 12) {
    return true; // continuous ground bedrock
  }
  // Audio-reactive equalizer terrain bumps on rows 10..11
  let bval = band(((tx % 16) + 16) % 16);
  if ((ty == 11 && bval > 0.28) || (ty == 10 && bval > 0.58)) {
    return true;
  }

  // Sample scrolled media luma & edges at tile center
  let tuv = world_media_uv(f32(tx) * 8.0 + 4.0, f32(ty) * 8.0 + 4.0);
  let tl = clamp(tex_luma(tuv).x, 0.0, 1.0);
  let te = clamp(length(tex_edges(tuv).xy), 0.0, 2.0);

  // Carve rhythmic vertical air corridors every 5 tiles so the level stays open and playable
  if (((tx % 5) + 5) % 5 == 0 && ty < 11) {
    return false;
  }

  // Dark silhouettes or crisp high-contrast edges in the picture become steppable brick platforms
  let dark_mass = (1.0 - tl) * p_contrast() > 0.72 && ty >= 6;
  let edge_ledge = te > (0.44 - b * 0.08) && ty >= 5 && ty <= 10;
  return dark_mass || edge_ledge;
}

// 8x8 brick / platform tile art (returns LCD shade 0..3)
fn brick_tile_shade(lx: i32, ly: i32, has_above: bool, beat_glint: bool) -> i32 {
  if (!has_above) {
    // Top-surface cap tile (classic handheld grass/stone lip)
    if (ly == 0) {
      return 0; // crisp dark top outline
    }
    if (ly == 1) {
      return select(3, 2, (lx & 3) == 3 && !beat_glint);
    }
    if (ly == 2) {
      return select(1, 0, ((lx + 1) & 3) == 0);
    }
  }
  // Staggered masonry brick rows
  let row_half = ly % 4;
  if (row_half == 0) {
    return 0; // horizontal mortar
  }
  let shift = select(0, 4, ly >= 4);
  let bx = (lx + shift) % 8;
  if (bx == 0) {
    return 0; // vertical mortar
  }
  if (row_half == 1 && bx == 1) {
    return 3; // top-left pixel highlight bevel
  }
  if (row_half == 3 || bx == 7) {
    return 1; // brick lower-right shade
  }
  return 2; // mid brick face
}

// 8x8 spinning collectible coin (4-frame spin; returns -1 transparent or shade 0..3)
fn coin_sprite(lx: i32, ly: i32, frame: i32, flash: bool) -> i32 {
  let f = ((frame % 4) + 4) % 4;
  // Width narrows on frames 1 & 3, thin line on frame 2
  var half_w = 3;
  if (f == 1 || f == 3) {
    half_w = 2;
  } else if (f == 2) {
    half_w = 1;
  }
  let dx = abs(lx - 4);
  let dy = abs(ly - 4);
  if (dy > 3 || dx > half_w) {
    return -1;
  }
  if (dy == 3 && dx == half_w && half_w > 1) {
    return -1; // rounded corner
  }
  // Dark outer outline
  if (dy == 3 || dx == half_w) {
    return select(0, 3, flash);
  }
  // Center shine slit
  if (dx == 0 && dy <= 1) {
    return select(3, 0, flash);
  }
  return select(1, 3, flash);
}

// 10x12 pixel-art runner sprite (returns -1 transparent or shade 0..3)
fn runner_sprite(sx: i32, sy: i32, run_frame: i32, jumping: bool) -> i32 {
  if (sx < 0 || sx >= 10 || sy < 0 || sy >= 12) {
    return -1;
  }
  // Cap / Helmet (rows 0..2)
  if (sy == 0) {
    if (sx >= 2 && sx <= 7) { return 0; }
    return -1;
  }
  if (sy == 1) {
    if (sx == 1 || sx == 8) { return 0; }
    if (sx >= 2 && sx <= 7) { return 1; }
    return -1;
  }
  if (sy == 2) {
    if (sx >= 1 && sx <= 9) { return 0; } // cap brim facing right
    return -1;
  }
  // Face & visor (rows 3..5)
  if (sy == 3 || sy == 4) {
    if (sx == 1 || sx == 8) { return 0; }
    if (sx == 6 && sy == 4) { return 0; } // crisp pixel eye
    if (sx >= 2 && sx <= 7) { return 3; } // bright face highlight
    return -1;
  }
  if (sy == 5) {
    if (sx >= 2 && sx <= 7) { return 0; }
    return -1;
  }
  // Torso / jacket + arms (rows 6..8)
  if (sy >= 6 && sy <= 8) {
    let arm_up = jumping && sy == 6 && (sx == 0 || sx == 9);
    if (arm_up) { return 0; }
    if (sx == 2 || sx == 7) { return 0; }
    if (sx == 1 && sy == 7 && !jumping) { return 0; }
    if (sx == 8 && sy == 7 && !jumping) { return 0; }
    if (sx >= 3 && sx <= 6) {
      return select(1, 2, sy == 7 && sx == 5);
    }
    return -1;
  }
  // Belt / waist (row 9)
  if (sy == 9) {
    if (sx >= 2 && sx <= 7) { return 0; }
    return -1;
  }
  // Animated running / jumping legs (rows 10..11)
  if (jumping) {
    if (sy == 10 && (sx == 1 || sx == 2 || sx == 7 || sx == 8)) { return 0; }
    if (sy == 11 && (sx == 1 || sx == 8)) { return 1; }
    return -1;
  }
  let rf = ((run_frame % 3) + 3) % 3;
  if (rf == 0) {
    if ((sx == 2 || sx == 3 || sx == 6 || sx == 7)) { return 0; }
  } else if (rf == 1) {
    if (sy == 10 && (sx == 1 || sx == 2 || sx == 7 || sx == 8)) { return 0; }
    if (sy == 11 && (sx == 0 || sx == 1 || sx == 8 || sx == 9)) { return 0; }
  } else {
    if (sy == 10 && (sx >= 3 && sx <= 6)) { return 0; }
    if (sy == 11 && (sx == 4 || sx == 5)) { return 0; }
  }
  return -1;
}

// Tiny 5x5 pixel heart icon for the top HUD
fn heart_icon(hx: i32, hy: i32, pulse_full: bool) -> i32 {
  if (hx < 0 || hx >= 5 || hy < 0 || hy >= 5) { return -1; }
  if (hy == 0 && (hx == 1 || hx == 3)) { return 0; }
  if (hy == 1) { return select(1, 0, pulse_full || hx == 0 || hx == 4); }
  if (hy == 2) { return select(1, 0, pulse_full || hx == 0 || hx == 4); }
  if (hy == 3 && hx >= 1 && hx <= 3) { return 0; }
  if (hy == 4 && hx == 2) { return 0; }
  return -1;
}

fn lcd_palette(shade_i: i32) -> vec3f {
  let s = clamp(f32(shade_i) / 3.0, 0.0, 1.0);
  return palette(s);
}

fn shade(uv: vec2f) -> vec4f {
  let t = time();
  let b = bass();
  let on = onset();
  let r = rms();
  let ph = phase();
  let br = bar();
  let asp = max(aspect(), 0.5);

  let beat_kick = pow(max(0.0, 1.0 - ph * 2.8), 2.0) * (0.25 + 0.75 * b);

  // Subtle onset micro-shake for arcade tactile impact
  let shake_y = sin(t * 95.0) * on * 0.0055 * p_jump();
  let suv = uv + vec2f(0.0, shake_y);

  // Handheld screen bezel framing
  let by = p_bezel();
  let bx = by * 1.12;
  let luv = (suv - vec2f(bx, by)) / max(vec2f(1.0 - 2.0 * bx, 1.0 - 2.0 * by), vec2f(0.2));

  // --- OUTSIDE LCD: RETRO HANDHELD CONSOLE BEZEL ---
  if (luv.x < 0.0 || luv.x > 1.0 || luv.y < 0.0 || luv.y > 1.0) {
    let clamped = clamp(luv, vec2f(0.0), vec2f(1.0));
    let bd = length((luv - clamped) * vec2f(asp, 1.0));

    // Matte textured handheld charcoal bezel tinted lightly toward the cartridge palette
    var bezel_col = mix(vec3f(0.11, 0.115, 0.128), palette(0.18) * 0.35, 0.22);
    // Subtle recessed chamfer right around the LCD glass
    if (bd < 0.018) {
      let side_shade = select(0.55, 1.25, luv.y > 1.0 || luv.x > 1.0);
      bezel_col *= mix(side_shade, 1.0, smoothstep(0.0, 0.018, bd));
    }
    // Classic twin top bezel accent stripes
    if (luv.y < -0.024 && luv.y > -0.056 && luv.x > 0.02 && luv.x < 0.98) {
      let sy = abs(luv.y + 0.04);
      if (sy < 0.0045) {
        bezel_col = mix(vec3f(0.42, 0.10, 0.28), palette(0.45), 0.35);
      } else if (sy > 0.009 && sy < 0.0135) {
        bezel_col = mix(vec3f(0.12, 0.16, 0.42), palette(0.25), 0.35);
      }
    }
    // Left-side glowing red BATTERY power LED pulsing with bass & onsets
    let led_pos = vec2f(-bx * 0.52 / max(1.0 - 2.0 * bx, 0.2), 0.36);
    let led_d = length((luv - led_pos) * vec2f(asp, 1.0));
    let led_pow = 0.65 + b * 0.95 + on * 0.85;
    bezel_col += vec3f(1.35, 0.14, 0.05) * led_pow * exp(-led_d * led_d * 2400.0);
    bezel_col += vec3f(1.6, 0.65, 0.3) * smoothstep(0.011, 0.004, led_d) * (0.7 + r * 0.5);

    return vec4f(soft_clip(bezel_col), 1.0);
  }

  // --- INSIDE LCD: 176 x 104 4-SHADE PIXEL GAME WORLD ---
  let lcd_res = vec2f(176.0, 104.0);
  let lcd_pos = luv * lcd_res;
  let px = vec2i(floor(lcd_pos));
  let sub_uv = fract(lcd_pos);

  // Beat-synced horizontal scroll surged forward by bass, RMS, and onsets so the music drives the level
  let beat_t = t * max(bpm(), 60.0) / 60.0;
  let scroll_px = floor(beat_t * 24.0 * p_speed() + b * 44.0 + r * 36.0 + on * 22.0);

  var shade_i = 3; // lightest LCD backlight default

  if (px.y <= 9) {
    // --- TOP PIXEL-ART HUD BAR (rows 0..9) ---
    shade_i = 3;
    if (px.y == 9) {
      shade_i = 0; // crisp bottom HUD divider line
    } else if (px.y >= 2 && px.y <= 6) {
      // 3 pulsing pixel hearts on left
      let beat_pulse = ph < 0.28 || on > 0.2;
      for (var hi = 0; hi < 3; hi = hi + 1) {
        let hs = heart_icon(px.x - (6 + hi * 7), px.y - 2, beat_pulse && hi <= i32(floor(br)) % 3);
        if (hs >= 0) { shade_i = hs; }
      }
      // Center audio energy / combo meter (x = 58..118)
      if (px.x >= 58 && px.x <= 118 && px.y >= 3 && px.y <= 6) {
        if (px.x == 58 || px.x == 118 || px.y == 3 || px.y == 6) {
          shade_i = 0;
        } else {
          let fill_w = i32(clamp((r * 0.65 + b * 0.55 + on * 0.45) * 58.0, 2.0, 58.0));
          let mx = px.x - 59;
          if (mx < fill_w) {
            shade_i = select(1, 0, (mx % 4) != 3);
          } else {
            shade_i = 2;
          }
        }
      }
      // Right-side 4-beat bar indicator pips + mini coin
      if (px.x >= 136 && px.x <= 166 && px.y >= 3 && px.y <= 6) {
        let bx_i = (px.x - 136) / 6;
        let bx_l = (px.x - 136) % 6;
        if (bx_i < 4 && bx_l >= 1 && bx_l <= 3) {
          let active_b = bx_i == (i32(floor(br)) % 4);
          shade_i = select(2, 0, active_b);
        }
      }
    }
  } else {
    // --- SCROLLING MEDIA-DERIVED PLATFORMER WORLD ---
    let wx = f32(px.x) + scroll_px;
    let wy = f32(px.y);
    let tx = i32(floor(wx / 8.0));
    let ty = i32(floor(wy / 8.0));
    let lx = ((i32(floor(wx)) % 8) + 8) % 8;
    let ly = ((i32(floor(wy)) % 8) + 8) % 8;

    // Layer 1: 4-shade Bayer-dithered scrolling media picture backdrop
    let muv = world_media_uv(wx, wy);
    let bg_luma = clamp(tex_luma(muv).x, 0.0, 1.0);
    let bg_edge = clamp(length(tex_edges(muv).xy), 0.0, 2.0);
    let dval = (bayer4(vec2i(i32(floor(wx)), px.y)) - 0.5) * p_dither();

    // Map picture into crisp bright-biased handheld shades (1..3) so solid tiles (0..2) pop clearly
    let media_tone = clamp(pow(bg_luma, 0.9) * (0.78 + r * 0.35 + b * 0.42 + on * 0.35) - bg_edge * 0.24, 0.0, 1.0);
    let q_bg = i32(clamp(floor((media_tone * 0.74 + 0.24 + dval * 0.28) * 3.99), 1.0, 3.0));
    shade_i = q_bg;

    // Drifting parallax sky clouds in upper rows (y = 12..30)
    if (px.y >= 12 && px.y <= 30) {
      let cwx = f32(px.x) + floor(scroll_px * 0.35);
      let ctx = i32(floor(cwx / 24.0));
      let clx = ((i32(floor(cwx)) % 24) + 24) % 24;
      let cy0 = 14 + i32(hash2i(ctx, 19) * 8.0);
      let cdy = px.y - cy0;
      if (hash2i(ctx, 7) > 0.35 && cdy >= 0 && cdy <= 5) {
        let in_cloud = (cdy == 0 && clx >= 6 && clx <= 12)
          || (cdy == 1 && clx >= 4 && clx <= 15)
          || ((cdy == 2 || cdy == 3) && clx >= 2 && clx <= 17)
          || (cdy == 4 && clx >= 3 && clx <= 16);
        let cloud_outline = (cdy == 4 && clx >= 3 && clx <= 16) || (cdy == 0 && clx >= 6 && clx <= 12);
        if (in_cloud) {
          shade_i = select(3, 1, cloud_outline);
        }
      }
    }

    // Layer 2: Auto-tiled 8x8 brick platforms from media luma & edges
    let solid = is_solid_tile(tx, ty, b);
    if (solid) {
      let above = is_solid_tile(tx, ty - 1, b);
      let beat_glint = beat_kick > 0.35 || on > 0.25;
      shade_i = brick_tile_shade(lx, ly, above, beat_glint);
    } else {
      // Layer 3: Floating spinning beat coins above platforms & along media edges
      let below_solid = is_solid_tile(tx, ty + 1, b);
      let tile_uv = world_media_uv(f32(tx) * 8.0 + 4.0, f32(ty) * 8.0 + 4.0);
      let tile_edge = clamp(length(tex_edges(tile_uv).xy), 0.0, 2.0);
      let coin_chance = hash2i(tx, ty * 13 + 5);
      let has_coin = ty >= 4 && ty <= 10
        && ((below_solid && coin_chance < p_coins() * 0.42) || (tile_edge > 0.52 && coin_chance < p_coins() * 0.26));
      if (has_coin) {
        let bob = i32(round(sin(ph * 6.28318 + f32(tx) * 0.9) * 1.4));
        let spin_f = i32(floor(beat_t * 3.0 + f32(tx) * 0.5));
        let cs = coin_sprite(lx, ly - bob, spin_f, on > 0.3);
        if (cs >= 0) {
          shade_i = cs;
        }
      }
    }

    // Layer 4: Autonomous 10x12 Pixel-Art Runner Hero (x = 34..43)
    if (px.x >= 26 && px.x <= 46) {
      let runner_x0 = 34;
      let runner_tx = i32(floor((f32(runner_x0 + 5) + scroll_px) / 8.0));

      // Scan downward from ty = 5..12 to find highest solid platform under the runner
      var floor_ty = 12;
      for (var sty = 11; sty >= 5; sty = sty - 1) {
        if (is_solid_tile(runner_tx, sty, b)) {
          floor_ty = sty;
        }
      }
      // Beat-synced parabolic jump + extra onset leap
      let jump_arc = sin(clamp(ph * 1.35, 0.0, 1.0) * 3.14159265);
      let jump_px = i32(floor(p_jump() * (jump_arc * (7.0 + b * 14.0) + on * 14.0)));
      let foot_y = max(24, floor_ty * 8 - jump_px);
      let head_y = foot_y - 12;

      let run_f = i32(floor(beat_t * 5.0));
      let rs = runner_sprite(px.x - runner_x0, px.y - head_y, run_f, jump_px > 3);
      if (rs >= 0) {
        shade_i = rs;
      }

      // Tiny pixel dust puffs kicked up behind heels while running or launching on a beat
      if (px.x >= 27 && px.x <= 32 && px.y >= foot_y - 3 && px.y <= foot_y - 1) {
        let dust_phase = ((px.x + i32(scroll_px)) % 4 + 4) % 4;
        if (dust_phase == 0 && (jump_px <= 4 || on > 0.2)) {
          shade_i = 1;
        }
      }
    }
  }

  // --- AUTHENTIC 4-SHADE LCD MATRIX GRID, SHADOW & BACKLIGHT ---
  var col = lcd_palette(shade_i);

  // Subtle LCD inter-pixel separator grid (slightly lighter reflective olive gap)
  let gx = smoothstep(0.0, 0.14, sub_uv.x) * smoothstep(1.0, 0.86, sub_uv.x);
  let gy = smoothstep(0.0, 0.14, sub_uv.y) * smoothstep(1.0, 0.86, sub_uv.y);
  let pixel_body = mix(1.0, gx * gy, p_grid() * 0.72);
  let grid_backing = lcd_palette(3) * 0.92;
  col = mix(grid_backing, col, 0.42 + 0.58 * pixel_body);

  // Soft LCD corner vignette & musical backlight pulse
  let vig = 1.0 - 0.18 * dot(luv - 0.5, luv - 0.5) * 2.2;
  let lcd_pulse = 0.74 + r * 0.44 + beat_kick * 0.40 + on * 0.30;
  col *= vig * lcd_pulse;

  return vec4f(soft_clip(col), 1.0);
}
