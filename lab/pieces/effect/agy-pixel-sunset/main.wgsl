// Pixel-art vaporwave sunset with the input media painted into the sky
// and reflected across a scrolling bass-rippled neon ocean grid.

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
  let q = fract(p * vec2f(123.34, 456.21));
  return fract(dot(q, q + 45.32));
}

fn quantize_dither(col: vec3f, dval: f32, levels: f32) -> vec3f {
  let c = max(col, vec3f(0.0));
  let peak = max(c.r, max(c.g, c.b));
  let tone = c / (1.0 + c * 0.55);
  let q = floor(clamp(tone + vec3f(dval / levels), vec3f(0.0), vec3f(0.999)) * levels) / (levels - 1.0);
  return q * (1.0 + peak * 0.42);
}

fn sample_sky_media(uv_sky: vec2f, chroma: f32) -> vec4f {
  let dx = vec2f(chroma, 0.0);
  let cr = tex_in(clamp(uv_sky + dx, vec2f(0.002), vec2f(0.998))).r;
  let cg = tex_in(clamp(uv_sky, vec2f(0.002), vec2f(0.998))).g;
  let cb = tex_in(clamp(uv_sky - dx, vec2f(0.002), vec2f(0.998))).b;
  let col = max(vec3f(cr, cg, cb), vec3f(0.0));
  let m_luma = tex_luma(clamp(uv_sky, vec2f(0.002), vec2f(0.998))).r;
  let calc_luma = dot(col, vec3f(0.2126, 0.7152, 0.0722));
  let luma = select(calc_luma, m_luma, m_luma > 0.001);
  return vec4f(col, clamp(luma, 0.0, 2.0));
}

fn eval_sky(puv: vec2f, pix: vec2f, hor: f32, asp: f32, t: f32, b: f32, on: f32, dval: f32) -> vec3f {
  let sy = clamp((hor - puv.y) / max(hor, 0.01), 0.0, 1.0);

  // Base vaporwave sunset sky gradient (deep indigo zenith -> magenta -> warm peach horizon)
  let sky_pal_t = clamp(1.0 - sy * 0.92 + dval * 0.09, 0.0, 1.0);
  let deep_zenith = vec3f(0.035, 0.015, 0.11);
  let mid_magenta = mix(vec3f(0.45, 0.07, 0.38), palette(0.35), 0.55);
  let warm_hor = mix(vec3f(1.15, 0.42, 0.28), palette(0.75), 0.45);
  var sky = mix(warm_hor, mid_magenta, smoothstep(0.0, 0.48, sy + dval * 0.06));
  sky = mix(sky, deep_zenith, smoothstep(0.38, 0.96, sy + dval * 0.07));
  sky *= 0.85 + b * 0.28 + on * 0.22;

  // Map input media into the sky dome with gentle beat-reactive chroma split
  let uv_sky = vec2f(puv.x, clamp(puv.y / max(hor, 0.01), 0.0, 1.0));
  let chroma = (0.002 + b * 0.006 + on * 0.014);
  let ms = sample_sky_media(uv_sky, chroma);
  let mcol = ms.rgb;
  let ml = clamp(ms.a, 0.0, 1.4);
  let edge_v = tex_edges(uv_sky).xy;
  let edge_mag = length(edge_v);

  // Paint media into sunset sky: preserve recognizable colors + grade into sunset clouds
  let m_tone = mcol / (1.0 + mcol * 0.5);
  let sunset_tint = mix(palette(clamp(0.18 + ml * 0.72, 0.0, 1.0)), m_tone * 1.45, 0.55);
  let cloud_mask = smoothstep(0.05, 0.72, ml) * (0.45 + 0.55 * (1.0 - sy * 0.35));
  sky = mix(sky, sunset_tint * (0.65 + 0.75 * ml + b * 0.35), p_sky_mix() * clamp(0.28 + cloud_mask * 0.72, 0.0, 0.95));

  // Neon edge shimmer on media contours in the sky
  let edge_glow = smoothstep(0.18, 0.75, edge_mag) * (0.35 + b * 0.9 + on * 1.4) * p_glow();
  sky += palette(clamp(0.82 - sy * 0.4, 0.0, 1.0)) * edge_glow * p_sky_mix();

  // Twinkling pixel stars in darker upper sky regions
  let star_cell = floor(pix * 0.5);
  let sr = hash21(star_cell);
  if (sr > 0.986 && sy > 0.32) {
    let tw = 0.5 + 0.5 * sin(t * (3.0 + sr * 8.0) + sr * 40.0 + b * 4.0);
    let star_vis = smoothstep(0.32, 0.75, sy) * (1.0 - clamp(ml * 0.85, 0.0, 0.9));
    sky += vec3f(0.85, 0.92, 1.2) * tw * star_vis * (0.7 + on * 0.9);
  }

  // Slatted retro synthwave sun sitting on the horizon
  let sun_r = p_sun_size() * (1.0 + b * 0.09 + on * 0.07);
  let sun_c = vec2f(0.5, hor - sun_r * 0.52);
  let dp = vec2f((puv.x - sun_c.x) * asp, puv.y - sun_c.y);
  let dist = length(dp);

  // Soft sun halo
  let halo = exp(-dist * 3.8 / max(sun_r, 0.05)) * (0.42 + b * 0.35 + on * 0.3) * p_glow();
  sky += mix(vec3f(1.0, 0.22, 0.55), vec3f(1.0, 0.78, 0.25), clamp(1.0 - dist * 1.8, 0.0, 1.0)) * halo;

  if (dist < sun_r) {
    let sun_t = clamp((sun_c.y + sun_r - puv.y) / (2.0 * sun_r), 0.0, 1.0);
    // Horizontal retro slats across the lower 60% of the sun
    var slat = 1.0;
    if (sun_t < 0.62) {
      let stripe_phase = fract(sun_t * 11.0 - t * 0.35 * p_speed());
      let cut_w = mix(0.46, 0.06, sun_t / 0.62) * (1.0 + b * 0.22);
      slat = step(cut_w, stripe_phase);
    }
    if (slat > 0.5) {
      let sun_col = mix(
        vec3f(1.15, 0.14, 0.58),
        vec3f(1.55, 1.18, 0.32),
        smoothstep(0.08, 0.92, sun_t + dval * 0.08)
      ) * p_glow() * (0.95 + b * 0.25 + on * 0.28);
      // Subtle double-exposure bleed of media highlights across the sun
      let media_bleed = mix(sun_col, sun_col * (0.72 + 0.55 * ml) + m_tone * 0.38, p_sky_mix() * 0.45);
      sky = media_bleed;
    }
  }

  // Horizon atmospheric glow band
  let h_glow = exp(-sy * 14.0) * (0.55 + b * 0.45 + on * 0.45) * p_glow();
  sky += mix(palette(0.65), vec3f(1.1, 0.35, 0.75), 0.5) * h_glow;

  return sky;
}

fn mountain_height(x: f32, layer: f32, b: f32) -> f32 {
  let sx = x * (5.5 + layer * 3.5) + layer * 2.1;
  let peak1 = abs(fract(sx * 0.5) - 0.5) * 2.0;
  let peak2 = abs(fract(sx * 1.15 + 0.37) - 0.5) * 2.0;
  let base_h = (peak1 * 0.6 + peak2 * 0.4) * (0.11 - layer * 0.032);

  // Audio spectrum sculpting across 16 bands (mirrored symmetrically around center)
  let sym = abs(x - 0.5) * 2.0;
  let bidx = clamp(i32(floor(sym * 14.0)), 0, 15);
  let spec = band(bidx);

  // Also let media luma near the horizon gently sculpt the ridge
  let ml = tex_luma(vec2f(clamp(x, 0.01, 0.99), 0.52)).r;
  let valley = smoothstep(0.08, 0.46, abs(x - 0.5));
  return (base_h + spec * (0.075 - layer * 0.02) + ml * 0.035) * (0.35 + 0.65 * valley) * (1.0 + b * 0.2);
}

fn palm_mask(puv: vec2f, base_x: f32, hor: f32, dir: f32, t: f32, b: f32) -> f32 {
  let sway = sin(t * 2.1 + base_x * 9.0) * (0.012 + b * 0.014);
  let h_norm = clamp((hor + 0.16 - puv.y) / 0.54, 0.0, 1.0);
  if (puv.y > hor + 0.16 || puv.y < hor - 0.42) {
    return 0.0;
  }
  let trunk_x = base_x + dir * (h_norm * h_norm * 0.075) + sway * h_norm * h_norm;
  let trunk_w = mix(0.022, 0.007, h_norm);
  if (abs(puv.x - trunk_x) < trunk_w && h_norm < 0.88) {
    return 1.0;
  }
  // Crown fronds
  let crown = vec2f(base_x + dir * 0.062 + sway, hor - 0.31);
  let d = puv - crown;
  let r = length(d * vec2f(aspect(), 1.0));
  if (r < 0.22) {
    let ang = atan2(d.y, d.x * aspect());
    let frond = cos(ang * 5.0 + dir * 0.6 + sway * 12.0);
    let droop = smoothstep(0.22, 0.02, r);
    if (frond > 0.28 - droop * 0.42 && d.y > -0.11) {
      return 1.0;
    }
  }
  return 0.0;
}

fn shade(uv: vec2f) -> vec4f {
  let t = time();
  let b = bass();
  let on = onset();
  let r = rms();
  let asp = aspect();
  let hor = p_horizon();

  // Crisp low-res pixel grid
  let cells = max(64.0, floor(p_cells() * (1.0 - on * 0.06)));
  let grid = vec2f(floor(cells * asp), cells);
  let pix = floor(uv * grid);
  let puv = (pix + 0.5) / grid;
  let dval = (bayer4(vec2i(pix)) - 0.5) * p_dither();

  var col = vec3f(0.0);

  if (puv.y < hor) {
    col = eval_sky(puv, pix, hor, asp, t, b, on, dval);

    // Far & near pixel spectrum mountains
    let mh_far = mountain_height(puv.x, 0.0, b);
    let mh_near = mountain_height(puv.x, 1.0, b);
    let y_above = hor - puv.y;

    if (y_above < mh_far) {
      let rim = smoothstep(0.012, 0.0, mh_far - y_above);
      let far_col = mix(vec3f(0.09, 0.03, 0.22), palette(0.22), 0.35);
      col = far_col + palette(0.75) * rim * (0.7 + b * 0.8 + on * 0.9) * p_glow();
    }
    if (y_above < mh_near) {
      let rim = smoothstep(0.011, 0.0, mh_near - y_above);
      let near_col = vec3f(0.03, 0.012, 0.08);
      col = near_col + vec3f(0.0, 0.95, 1.15) * rim * (0.85 + b * 0.9 + on * 1.1) * p_glow();
    }
  } else {
    // Water & scrolling neon outrun grid reflecting the media sky + sun
    let dy = max(puv.y - hor, 0.004);
    let z = 0.22 / dy;
    let ripple = sin(z * 1.8 - t * 3.2 * p_speed()) * (0.006 + b * 0.018 + on * 0.012) * clamp(dy * 3.0, 0.0, 1.0);
    let ref_y = clamp(hor - dy * 0.92, 0.002, hor - 0.002);
    let ref_uv = vec2f(clamp(puv.x + ripple, 0.002, 0.998), ref_y);

    let sky_ref = eval_sky(ref_uv, pix, hor, asp, t, b, on, dval);
    let water_base = mix(vec3f(0.03, 0.01, 0.09), sky_ref * 0.62, 0.72);

    // Perspective scrolling neon grid over the water
    let gx = (puv.x - 0.5) * asp * z * 2.2;
    let gz = z * 1.4 - t * 2.4 * p_speed();
    let fx = abs(fract(gx) - 0.5);
    let fz = abs(fract(gz) - 0.5);
    let line_x = smoothstep(0.055, 0.012, fx);
    let line_z = smoothstep(0.065, 0.015, fz);
    let grid_m = max(line_x, line_z) * smoothstep(0.004, 0.05, dy);

    let grid_col = mix(vec3f(1.0, 0.16, 0.72), vec3f(0.0, 0.96, 1.15), clamp(dy * 2.2, 0.0, 1.0));
    col = water_base + grid_col * grid_m * (0.58 + b * 0.75 + on * 0.85) * p_glow();

    // Horizon reflection gleam line
    let h_line = exp(-dy * 45.0) * (0.75 + b * 0.6 + on * 0.7) * p_glow();
    col += vec3f(1.2, 0.45, 0.88) * h_line;
  }

  // Framing pixel palm silhouettes on left and right edges
  let p_left = palm_mask(puv, 0.05, hor, 1.0, t, b);
  let p_right = palm_mask(puv, 0.95, hor, -1.0, t + 1.4, b);
  if (max(p_left, p_right) > 0.5) {
    let rim_col = mix(vec3f(0.025, 0.008, 0.06), palette(0.85) * (0.18 + on * 0.25), 0.35);
    col = rim_col;
  }

  // Bayer-dithered pixel quantization + crisp CRT-pixel scanline micro-contrast
  col = quantize_dither(col, dval, 7.0);
  let scan = 0.93 + 0.07 * select(1.0, -1.0, (i32(pix.y) & 1) == 0);
  col *= scan * (0.94 + r * 0.22 + on * 0.16);

  return vec4f(col, 1.0);
}
