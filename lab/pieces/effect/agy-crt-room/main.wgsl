// Pixel-art vaporwave room with a retro 4:3 CRT TV playing the input media.
// The TV's live picture dynamically illuminates the walls, checkered floor,
// potted palm, and cabinet, while a hi-fi deck below bounces to the 16-band spectrum.

fn bayer4(p: vec2i) -> f32 {
  let x = ((p.x % 4) + 4) % 4;
  let y = ((p.y % 4) + 4) % 4;
  let m = array<f32, 16>(
     0.0,  8.0,  2.0, 10.0,
    12.0,  4.0, 14.0,  6.0,
     3.0, 11.0,  1.0,  9.0,
    15.0,  7.0, 13.0,  5.0
  );
  return (m[y * 4 + x] + 0.5) / 16.0;
}

fn hash21(p: vec2f) -> f32 {
  let q = fract(p * vec2f(127.1, 311.7));
  return fract(dot(q, q + 34.5));
}

fn quantize_dither(col: vec3f, dval: f32, levels: f32) -> vec3f {
  let c = max(col, vec3f(0.0));
  let peak = max(c.r, max(c.g, c.b));
  let tone = c / (1.0 + c * 0.5);
  let q = floor(clamp(tone + vec3f(dval / levels), vec3f(0.0), vec3f(0.999)) * levels) / (levels - 1.0);
  return q * (1.0 + peak * 0.4);
}

fn sd_round_box(p: vec2f, b: vec2f, r: f32) -> f32 {
  let q = abs(p) - b + vec2f(r);
  return length(max(q, vec2f(0.0))) + min(max(q.x, q.y), 0.0) - r;
}

fn shade(uv: vec2f) -> vec4f {
  let t = time();
  let b = bass();
  let on = onset();
  let r = rms();
  let ph = phase();
  let asp = aspect();

  // Crisp low-res pixel grid
  let cells = max(80.0, floor(p_cells()));
  let grid = vec2f(floor(cells * asp), cells);
  let pix = floor(uv * grid);
  let puv = (pix + 0.5) / grid;
  let dval = (bayer4(vec2i(pix)) - 0.5) * p_dither();

  // Camera zoom + subtle bass/onset punch toward the TV
  let cam_z = p_zoom() * (1.0 + b * 0.045 + on * 0.035);
  let sway = vec2f(sin(t * 0.7) * 0.008, cos(t * 0.55) * 0.005);
  let ruv = (puv - vec2f(0.5, 0.48)) / cam_z + vec2f(0.5, 0.48) + sway;

  // Aspect-normalized room coordinates centered near the CRT TV
  let p = vec2f((ruv.x - 0.5) * asp, ruv.y - 0.48);

  // Sample average TV light spill color from 5 points of the media (fast dynamic GI)
  let s0 = tex_in(vec2f(0.5, 0.5)).rgb;
  let s1 = tex_in(vec2f(0.25, 0.3)).rgb;
  let s2 = tex_in(vec2f(0.75, 0.3)).rgb;
  let s3 = tex_in(vec2f(0.25, 0.7)).rgb;
  let s4 = tex_in(vec2f(0.75, 0.7)).rgb;
  let tv_avg = max((s0 * 2.0 + s1 + s2 + s3 + s4) / 6.0, vec3f(0.04, 0.02, 0.07));
  let tv_luma = clamp(dot(tv_avg, vec3f(0.2126, 0.7152, 0.0722)), 0.12, 1.8);
  let tv_spill_col = mix(tv_avg, palette(0.55) * tv_luma, 0.25) * p_spill() * (0.85 + b * 0.45 + on * 0.35);

  // Radial spill falloff from the CRT screen center
  let tv_center = vec2f(-0.02, -0.05);
  let dist_tv = length(p - tv_center);
  let spill_falloff = exp(-dist_tv * 1.45);

  // --- 1. ROOM BACKGROUND: BACK WALL & PERSPECTIVE CHECKERED FLOOR ---
  let floor_y = 0.26;
  var col = vec3f(0.0);

  if (p.y < floor_y) {
    // Retro striped vaporwave wallpaper
    let stripe = select(0.92, 1.06, (i32(floor((p.x + 2.0) * 14.0)) & 1) == 0);
    let wall_base = mix(vec3f(0.055, 0.025, 0.12), palette(0.15) * 0.28, 0.4) * stripe;
    col = wall_base + tv_spill_col * spill_falloff * 0.78;

    // Baseboard trim along floor_y
    if (p.y > floor_y - 0.032) {
      col = vec3f(0.09, 0.05, 0.16) + tv_spill_col * spill_falloff * 0.45;
    }

    // --- Left Window: Vaporwave Night Skyline ---
    let win_c = vec2f(-0.62, -0.14);
    let win_b = vec2f(0.18, 0.21);
    let wp = p - win_c;
    if (abs(wp.x) < win_b.x + 0.022 && abs(wp.y) < win_b.y + 0.022) {
      if (abs(wp.x) < win_b.x && abs(wp.y) < win_b.y) {
        let wuv = (wp + win_b) / (2.0 * win_b); // 0..1 inside window
        var wcol = mix(vec3f(0.03, 0.015, 0.10), palette(0.35) * 0.65, smoothstep(0.15, 0.95, wuv.y));
        // Stars outside window
        let sc = floor(wuv * vec2f(28.0, 32.0));
        let sr = hash21(sc);
        if (sr > 0.96 && wuv.y < 0.62) {
          wcol += vec3f(0.9, 0.95, 1.2) * (0.5 + 0.5 * sin(t * 4.0 + sr * 20.0));
        }
        // Glowing moon/sun disc outside
        let md = length(wuv - vec2f(0.68, 0.34));
        if (md < 0.15) {
          wcol = mix(vec3f(1.2, 0.35, 0.65), vec3f(1.4, 1.05, 0.45), smoothstep(0.15, -0.1, wuv.y - 0.34));
        }
        // Pulsing city skyline silhouettes
        let bx = floor(wuv.x * 10.0);
        let bh = 0.22 + hash21(vec2f(bx, 3.0)) * 0.26 + band(i32(bx) % 16) * 0.14;
        if (1.0 - wuv.y < bh) {
          wcol = vec3f(0.025, 0.012, 0.07);
          // Lit pixel windows in buildings
          let bwin = fract(wuv * vec2f(30.0, 48.0));
          if (bwin.x > 0.3 && bwin.x < 0.7 && bwin.y > 0.35 && bwin.y < 0.7 && hash21(floor(wuv * vec2f(30.0, 48.0))) > 0.55) {
            wcol += palette(0.75) * (0.7 + b * 0.7);
          }
        }
        // Window muntin crossbars
        if (abs(wp.x) < 0.009 || abs(wp.y) < 0.009) {
          wcol = vec3f(0.07, 0.04, 0.13) + tv_spill_col * 0.25;
        }
        col = wcol;
      } else {
        // Window frame
        col = vec3f(0.11, 0.065, 0.20) + tv_spill_col * spill_falloff * 0.55;
      }
    }

    // --- Right Wall Poster (retro neon grid art) ---
    let post_c = vec2f(0.60, -0.18);
    let post_b = vec2f(0.12, 0.15);
    let pp = p - post_c;
    if (abs(pp.x) < post_b.x + 0.015 && abs(pp.y) < post_b.y + 0.015) {
      if (abs(pp.x) < post_b.x && abs(pp.y) < post_b.y) {
        let p_local = (pp + post_b) / (2.0 * post_b);
        var pcol = mix(palette(0.15), palette(0.82), p_local.y) * 0.65;
        let pd = length(p_local - vec2f(0.5, 0.42));
        if (pd < 0.24) {
          pcol = vec3f(1.2, 0.55, 0.35) * (0.7 + b * 0.3);
        }
        col = pcol + tv_spill_col * spill_falloff * 0.35;
      } else {
        col = vec3f(0.12, 0.08, 0.19) + tv_spill_col * spill_falloff * 0.4;
      }
    }
  } else {
    // Perspective vaporwave checkered floor reflecting TV spill
    let fy = max(p.y - floor_y, 0.004);
    let fz = 0.24 / fy;
    let fx = p.x * fz * 1.45;
    let chk = ((i32(floor(fx * 2.5)) + i32(floor(fz * 2.5))) & 1) == 0;
    let tile_c = select(vec3f(0.045, 0.02, 0.11), vec3f(0.13, 0.06, 0.24), chk);
    let floor_ref = exp(-abs(p.x) * 2.2) * exp(-fy * 2.8) * tv_spill_col * 0.95;
    col = tile_c + tv_spill_col * spill_falloff * 0.35 + floor_ref;
  }

  // --- 2. POTTED PIXEL PALM ON THE RIGHT ---
  let pot_c = vec2f(0.62, 0.24);
  let pot_p = p - pot_c;
  if (abs(pot_p.x) < 0.07 - pot_p.y * 0.18 && pot_p.y > -0.05 && pot_p.y < 0.08) {
    col = vec3f(0.32, 0.12, 0.16) + tv_spill_col * spill_falloff * 0.45;
  }
  // Swaying pixel fronds
  let frond_sway = sin(t * 2.2) * (0.012 + b * 0.015);
  let f_orig = vec2f(0.62 + frond_sway, 0.15);
  let fd = p - f_orig;
  let fr = length(fd);
  if (fr < 0.19 && fd.y < 0.05) {
    let ang = atan2(fd.y, fd.x);
    let leaf = sin(ang * 5.0 + 0.5);
    if (leaf > 0.22 && fr > 0.025) {
      let leaf_lit = select(vec3f(0.06, 0.24, 0.18), vec3f(0.11, 0.38, 0.26), fd.x < 0.0);
      col = leaf_lit + tv_spill_col * spill_falloff * 0.55;
    }
  }

  // --- 3. CREDENZA / TV STAND & HI-FI SPECTRUM DECK ---
  let stand_c = vec2f(0.0, 0.28);
  let stand_b = vec2f(0.45, 0.14);
  let sp = p - stand_c;
  if (abs(sp.x) < stand_b.x && abs(sp.y) < stand_b.y) {
    // Wood/slate cabinet body
    let top_edge = smoothstep(0.025, 0.0, sp.y + stand_b.y);
    col = mix(vec3f(0.08, 0.045, 0.11), vec3f(0.17, 0.09, 0.20), top_edge) + tv_spill_col * 0.42;

    // Recessed Hi-Fi Stereo Deck with 12-band live LED spectrum analyzer
    let deck_b = vec2f(0.34, 0.085);
    if (abs(sp.x) < deck_b.x && abs(sp.y) < deck_b.y) {
      col = vec3f(0.025, 0.018, 0.045);
      // Left cassette window
      let cas_p = sp - vec2f(-0.21, 0.0);
      if (abs(cas_p.x) < 0.09 && abs(cas_p.y) < 0.05) {
        col = vec3f(0.05, 0.04, 0.09);
        // Spinning reels
        let r1 = length(cas_p - vec2f(-0.04, 0.0));
        let r2 = length(cas_p - vec2f(0.04, 0.0));
        if (r1 < 0.022 || r2 < 0.022) {
          let spoke = sin(atan2(cas_p.y, cas_p.x) * 3.0 + t * 5.0);
          col = select(vec3f(0.18, 0.14, 0.24), vec3f(0.65, 0.45, 0.85), spoke > 0.2);
        }
      }
      // Right 12-band LED EQ display driven directly by audio bands
      let eq_p = sp - vec2f(0.09, 0.0);
      let eq_b = vec2f(0.20, 0.055);
      if (abs(eq_p.x) < eq_b.x && abs(eq_p.y) < eq_b.y) {
        let eq_uv = (eq_p + eq_b) / (2.0 * eq_b); // x 0..1, y 0..1 (top=0)
        let bar_i = i32(clamp(floor(eq_uv.x * 12.0), 0.0, 11.0));
        let in_bar = fract(eq_uv.x * 12.0);
        let seg_y = 1.0 - eq_uv.y;
        let seg_step = fract(seg_y * 6.0);
        let level = clamp(band(bar_i) * 1.15 + on * 0.15, 0.06, 1.0);
        col = vec3f(0.015, 0.012, 0.03);
        if (in_bar > 0.18 && in_bar < 0.82 && seg_step > 0.22 && seg_y < level) {
          let led_col = mix(vec3f(0.0, 1.05, 0.95), vec3f(1.25, 0.18, 0.72), seg_y);
          col = led_col * (1.1 + b * 0.4);
        }
      }
    }
  }

  // --- 4. RABBIT-EAR ANTENNAS ON TOP OF THE TV ---
  let ant_base = vec2f(0.0, -0.34);
  let ap = p - ant_base;
  if (ap.y < 0.0 && ap.y > -0.17) {
    let ant_l = abs(ap.x + ap.y * 0.65);
    let ant_r = abs(ap.x - ap.y * 0.65);
    if (min(ant_l, ant_r) < 0.008) {
      col = vec3f(0.45, 0.42, 0.58) + tv_spill_col * 0.4;
    }
    // Antenna tips sparkle on onsets
    let tip_l = length(ap - vec2f(-0.105, -0.16));
    let tip_r = length(ap - vec2f(0.105, -0.16));
    if (min(tip_l, tip_r) < 0.016) {
      col = mix(vec3f(0.6, 0.55, 0.75), palette(0.85) * (1.2 + on * 1.8), 0.4 + on * 0.6);
    }
  }

  // --- 5. CHUNKY RETRO 4:3 CRT TELEVISION ---
  let tv_c = vec2f(0.0, -0.09);
  let tv_b = vec2f(0.37, 0.255);
  let tv_d = sd_round_box(p - tv_c, tv_b, 0.035);

  if (tv_d < 0.0) {
    // TV plastic bezel with bevel & dynamic screen rim light
    let bp = p - tv_c;
    let bevel = smoothstep(0.0, -0.028, tv_d);
    let top_lit = smoothstep(0.25, -0.25, bp.y);
    var bezel = mix(vec3f(0.09, 0.08, 0.13), vec3f(0.21, 0.19, 0.28), top_lit * 0.65 + bevel * 0.35);
    bezel += tv_spill_col * 0.28;
    col = bezel;

    // Right-hand control strip (knobs, speaker grille, power LED)
    let ctrl_x = 0.295;
    // Rotary UHF/VHF dials
    let d1 = length(bp - vec2f(ctrl_x, -0.11));
    let d2 = length(bp - vec2f(ctrl_x, -0.02));
    if (d1 < 0.032 || d2 < 0.032) {
      let in_ring = min(d1, d2) > 0.022;
      col = select(vec3f(0.16, 0.14, 0.22), vec3f(0.45, 0.42, 0.55), in_ring);
    }
    // Speaker grille slits
    if (abs(bp.x - ctrl_x) < 0.036 && bp.y > 0.05 && bp.y < 0.16) {
      let slit = fract(bp.y * 52.0) > 0.5;
      col = select(vec3f(0.03, 0.025, 0.05), bezel * 0.9, slit);
    }
    // Power LED pulsing on the beat
    let led_d = length(bp - vec2f(ctrl_x, 0.195));
    if (led_d < 0.013) {
      let beat_blink = 0.55 + 0.45 * pow(1.0 - ph, 2.0) + on * 0.6;
      col = vec3f(1.3, 0.15, 0.28) * beat_blink;
    }

    // Recessed dark bezel rim around the curved glass tube
    let scr_c = vec2f(-0.048, -0.09);
    let scr_b = vec2f(0.275, 0.205);
    let rim_d = sd_round_box(p - scr_c, scr_b + vec2f(0.018), 0.028);
    if (rim_d < 0.0) {
      col = vec3f(0.02, 0.018, 0.032) + tv_spill_col * 0.18;
    }

    // --- CURVED CRT GLASS SCREEN PLAYING THE MEDIA ---
    let scr_d = sd_round_box(p - scr_c, scr_b, 0.022);
    if (scr_d < 0.0) {
      // Normalized screen UV in 0..1
      let raw_suv = (p - scr_c + scr_b) / (2.0 * scr_b);
      let centered = raw_suv * 2.0 - vec2f(1.0);
      // Barrel distortion of curved CRT glass
      let r2 = dot(centered, centered);
      let curved = centered * (1.0 + 0.11 * r2);
      var suv = curved * 0.5 + vec2f(0.5);

      if (suv.x > 0.0 && suv.x < 1.0 && suv.y > 0.0 && suv.y < 1.0) {
        // VHS tracking band tear on onset
        let band_y = fract(t * 0.42 + on * 0.17);
        let in_track = smoothstep(0.09, 0.0, abs(suv.y - band_y));
        let tear = (hash21(vec2f(floor(suv.y * 64.0), floor(t * 24.0))) - 0.5)
                 * (in_track * 0.08 + on * 0.045) * p_glitch();
        suv.x = clamp(suv.x + tear, 0.002, 0.998);

        // Pixel-snapped chromatic aberration on bass & onset
        let ca = (0.003 + b * 0.008 + on * 0.016) * (0.4 + p_glitch() * 0.8);
        let mr = tex_in(clamp(suv + vec2f(ca, 0.0), vec2f(0.002), vec2f(0.998))).r;
        let mg = tex_in(suv).g;
        let mb = tex_in(clamp(suv - vec2f(ca, 0.0), vec2f(0.002), vec2f(0.998))).b;
        var vid = max(vec3f(mr, mg, mb), vec3f(0.0)) * (1.05 + b * 0.28 + on * 0.3);

        // Subtle neon phosphor contour shimmer from media.edges on beats
        let em = length(tex_edges(suv).xy);
        vid += palette(0.78) * smoothstep(0.25, 0.85, em) * (b * 0.25 + on * 0.65);

        // CRT horizontal scanlines + subtle RGB phosphor triad
        let scan_wave = 0.5 + 0.5 * sin(raw_suv.y * 120.0 * 3.14159);
        let scan_mul = mix(1.0, 0.62 + 0.38 * scan_wave, p_scanlines());
        let triad_i = i32(pix.x) % 3;
        var triad = vec3f(1.0);
        if (triad_i == 0) { triad = vec3f(1.08, 0.95, 0.95); }
        else if (triad_i == 1) { triad = vec3f(0.95, 1.08, 0.95); }
        else { triad = vec3f(0.95, 0.95, 1.08); }
        vid *= scan_mul * mix(vec3f(1.0), triad, p_scanlines() * 0.45);

        // Subtle VHS static snow in tracking band
        let snow = hash21(pix + vec2f(floor(t * 30.0) * 17.0, 0.0));
        vid += vec3f(snow) * in_track * (0.18 + on * 0.35) * p_glitch();

        // VCR OSD: blinking green PLAY triangle + beat volume bar at bottom
        if (raw_suv.x > 0.06 && raw_suv.x < 0.13 && raw_suv.y > 0.07 && raw_suv.y < 0.16) {
          let ox = (raw_suv.x - 0.06) / 0.07;
          let oy = abs((raw_suv.y - 0.115) / 0.045);
          if (oy < 1.0 - ox && fract(t * 1.2) > 0.2) {
            vid = mix(vid, vec3f(0.15, 1.35, 0.45), 0.9);
          }
        }
        // Bottom OSD audio level bar
        if (raw_suv.y > 0.88 && raw_suv.y < 0.92 && raw_suv.x > 0.12 && raw_suv.x < 0.88) {
          let bx = (raw_suv.x - 0.12) / 0.76;
          if (fract(bx * 16.0) > 0.25 && bx < clamp(0.15 + r * 0.85 + on * 0.2, 0.0, 1.0)) {
            vid = mix(vid, vec3f(0.2, 1.25, 0.75), 0.75);
          }
        }

        // Curved glass vignette + subtle top-left specular reflection
        let vig = clamp(1.0 - r2 * 0.24, 0.45, 1.0);
        let spec = exp(-length(raw_suv - vec2f(0.22, 0.18)) * 5.5) * 0.16;
        col = vid * vig + vec3f(0.65, 0.78, 1.0) * spec;
      } else {
        col = vec3f(0.015, 0.012, 0.025);
      }
    }
  }

  // Bayer-dithered pixel-art quantization across the room + TV
  col = quantize_dither(col, dval, 8.0);
  col *= 0.96 + r * 0.18 + on * 0.12;

  return vec4f(col, 1.0);
}
