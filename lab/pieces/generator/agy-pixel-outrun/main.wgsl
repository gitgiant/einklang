// Pixel-art vaporwave outrun horizon with Bayer-dithered sky, slatted sun,
// spectrum mountain skyline, neon perspective grid, and scrolling pixel palms.

fn bayer4(p: vec2i) -> f32 {
  let x = ((p.x % 4) + 4) % 4;
  let y = ((p.y % 4) + 4) % 4;
  let idx = y * 4 + x;
  let m = array<f32, 16>(
     0.0,  8.0,  2.0, 10.0,
    12.0,  4.0, 14.0,  6.0,
     3.0, 11.0,  1.0,  9.0,
    15.0,  7.0, 13.0,  5.0
  );
  return (m[idx] + 0.5) / 16.0;
}

fn hash21(p: vec2f) -> f32 {
  var q = fract(p * vec2f(123.34, 456.21));
  q += dot(q, q + 45.32);
  return fract(q.x * q.y);
}

fn sample_band(x: f32) -> f32 {
  let f = clamp(x, 0.0, 1.0) * 15.0;
  let i = i32(floor(f));
  let j = min(15, i + 1);
  return mix(band(i), band(j), fract(f));
}

// Crisp procedural pixel-art palm silhouette in local coordinates (origin at trunk base)
fn palm_mask(lp: vec2f, sway: f32) -> f32 {
  // Curved trunk
  let h = lp.y; // 0 at base, 1 at crown
  if (h < 0.0 || h > 1.38) { return 0.0; }
  let curve = sway * h * h + 0.14 * sin(h * 2.2);
  let trunk_w = mix(0.065, 0.024, clamp(h, 0.0, 1.0));
  if (h <= 1.02 && abs(lp.x - curve) < trunk_w) {
    return 1.0;
  }
  // 6 drooping palm fronds radiating from crown
  let crown = vec2f(curve, 1.0);
  let d = lp - crown;
  let r = length(d);
  if (r > 0.62) { return 0.0; }
  for (var k = 0; k < 6; k = k + 1) {
    let side = select(-1.0, 1.0, k >= 3);
    let tier = f32(k % 3); // 0 = upper, 1 = mid, 2 = lower
    let reach = 0.44 + tier * 0.06;
    let dx = d.x * side;
    if (dx > -0.02 && dx < reach) {
      let t = clamp(dx / reach, 0.0, 1.0);
      let arch = (0.24 - tier * 0.14) * t - (0.34 + tier * 0.05) * t * t;
      let thick = mix(0.055, 0.015, t) + 0.022 * sin(t * 22.0) * (1.0 - t * 0.4);
      if (abs(d.y - arch) < thick) { return 1.0; }
    }
  }
  return 0.0;
}

fn shade(uv: vec2f) -> vec4f {
  let cells = max(48.0, floor(p_cells()));
  let asp = aspect();
  let grid_res = vec2f(floor(cells * asp), cells);
  let pix = floor(uv * grid_res);
  let puv = (pix + 0.5) / grid_res;
  let dval = bayer4(vec2i(pix));

  let t = time();
  let b = bass();
  let on = onset();
  let r = rms();
  let ph = phase();
  let hi = (band(11) + band(12) + band(13) + band(14)) * 0.25;
  let mid = (band(4) + band(5) + band(6) + band(7)) * 0.25;
  let glow = p_glow();
  let dither_amt = p_dither();

  // Horizon bounces subtly on bass
  let hor = p_horizon() + (b - 0.3) * 0.018;
  let beat_pulse = pow(max(0.0, 1.0 - ph * 1.6), 2.0);
  let energy = clamp(b * 0.65 + on * 0.55 + r * 0.35, 0.0, 1.6);

  // Vaporwave palette stops
  let c_night = palette(0.02) * 0.32;
  let c_purp  = palette(0.22);
  let c_pink  = palette(0.45);
  let c_peach = palette(0.64);
  let c_cyan  = palette(0.84);
  let c_mint  = palette(0.98);

  var col = vec3f(0.0);

  if (puv.y < hor) {
    // --- SKY: Bayer-dithered vaporwave sunset gradient ---
    let sy = clamp(puv.y / max(0.05, hor), 0.0, 1.0);
    let q_steps = 6.0;
    let d_sy = clamp(sy + (dval - 0.5) * dither_amt / q_steps, 0.0, 1.0);
    let band_sy = floor(d_sy * q_steps) / q_steps;

    let sky_lo = mix(c_night, c_purp, smoothstep(0.0, 0.55, band_sy));
    let sky_hi = mix(c_pink, c_peach, smoothstep(0.5, 1.0, band_sy));
    col = mix(sky_lo, sky_hi, smoothstep(0.35, 0.95, band_sy));
    col *= (0.72 + energy * 0.48);

    // Twinkling 1-pixel stars in upper sky
    if (sy < 0.62) {
      let star_h = hash21(pix);
      if (star_h > 0.988) {
        let tw = 0.45 + 0.55 * sin(t * (4.0 + star_h * 12.0) + star_h * 50.0);
        let star_b = (0.6 + hi * 1.8 + on * 1.2) * (1.0 - sy / 0.62);
        col += mix(c_cyan, vec3f(1.0, 0.96, 1.0), fract(star_h * 17.0)) * tw * star_b;
      }
    }

    // --- SLATTED VAPORWAVE SUN ---
    let sun_center = vec2f(0.5, hor - 0.145 - b * 0.015);
    let sun_d = vec2f((puv.x - sun_center.x) * asp, puv.y - sun_center.y);
    let sun_r = 0.195 + b * 0.045 + on * 0.025 + beat_pulse * 0.012;
    let dist_sun = length(sun_d);

    // Dithered sun aura
    let aura = exp(-dist_sun * (4.2 - energy * 0.9));
    let aura_d = step(dval * 0.7, aura * dither_amt + aura * (1.0 - dither_amt));
    col += mix(c_pink, c_peach, 0.5) * aura * (0.55 + energy * 0.65) * (0.65 + 0.35 * aura_d);

    if (dist_sun < sun_r) {
      let sun_v = clamp((sun_d.y + sun_r) / (2.0 * sun_r), 0.0, 1.0); // 0 top, 1 bottom
      // Animated rising horizontal slats in lower half of the sun
      let slat_zone = smoothstep(0.42, 0.52, sun_v);
      let slat_freq = 11.0;
      let slat_phase = fract(sun_v * slat_freq - t * 0.45 * p_speed());
      let slat_cut = mix(0.08, 0.56, pow(clamp((sun_v - 0.4) / 0.6, 0.0, 1.0), 1.35));
      if (slat_zone < 0.5 || slat_phase > slat_cut) {
        let qv = floor(clamp(sun_v + (dval - 0.5) * 0.14 * dither_amt, 0.0, 1.0) * 5.0) / 5.0;
        let sun_col = mix(vec3f(1.0, 0.94, 0.55), mix(c_peach, c_pink, qv), qv);
        col = sun_col * (1.15 + b * 0.65 + on * 0.45) * glow;
      }
    }

    // --- PIXEL SPECTRUM MOUNTAIN SKYLINE ---
    let mx = abs(puv.x - 0.5) * 2.0; // symmetric valley framing the sun
    let spec_h = sample_band(mx * 0.85);
    let ridge_far = 0.045
      + 0.055 * abs(sin(puv.x * 13.0 + 0.6))
      + 0.035 * abs(sin(puv.x * 29.0 - 1.2))
      + spec_h * (0.075 + b * 0.05);
    let valley = smoothstep(0.05, 0.42, mx);
    let m_top = hor - ridge_far * (0.28 + 0.72 * valley);

    if (puv.y > m_top) {
      let depth = clamp((puv.y - m_top) / max(0.02, hor - m_top), 0.0, 1.0);
      let rim = step(depth, 0.16);
      let m_body = mix(c_purp * 0.38, c_night * 0.6, floor(clamp(depth + (dval - 0.5) * 0.25, 0.0, 1.0) * 3.0) / 3.0);
      let m_edge = mix(c_cyan, c_pink, step(0.5, fract(puv.x * 8.0))) * (0.95 + b * 0.85 + on * 0.7) * glow;
      col = mix(m_body, m_edge, rim);
    }
  } else {
    // --- GROUND: PERSPECTIVE NEON PIXEL GRID + OUTRUN HIGHWAY ---
    let gy = max(0.004, puv.y - hor);
    let z = 0.18 / gy;
    let scroll = t * 2.4 * p_speed() + beat_pulse * 0.18;
    let gx = (puv.x - 0.5) * asp * z;

    // Ground base with dithered sunset reflection
    let refl_x = exp(-abs(puv.x - 0.5) * (5.2 - b * 1.4));
    let fog = exp(-z * 0.14);
    let base_g = mix(c_night * 0.45, c_purp * 0.55, fog * 0.65);
    let d_refl = step(dval, refl_x * fog * (0.65 + energy * 0.45));
    col = base_g + mix(c_pink, c_peach, 0.45) * refl_x * fog * (0.28 + b * 0.4) * (0.5 + 0.5 * d_refl);

    // Perspective grid lines (crisp on pixel grid)
    let gz = z + scroll;
    let cell_x = abs(fract(gx * 0.95 + 0.5) - 0.5);
    let cell_z = abs(fract(gz * 0.95) - 0.5);
    let lw_x = clamp(0.032 + 0.015 * gy * 12.0, 0.025, 0.14);
    let lw_z = clamp(0.038 + 0.018 * gy * 10.0, 0.03, 0.16);
    let line_x = 1.0 - step(lw_x, cell_x);
    let line_z = 1.0 - step(lw_z, cell_z);
    let grid_line = max(line_x, line_z);

    // Traveling onset shockwave ring along z
    let wave_z = fract(z * 0.16 - t * 1.4 * p_speed());
    let shock = smoothstep(0.18, 0.0, abs(wave_z - 0.5)) * (0.35 + on * 1.4 + b * 0.8);

    // Central highway corridor
    let road_w = 0.92;
    let in_road = step(abs(gx), road_w);
    let road_edge = 1.0 - step(0.08, abs(abs(gx) - road_w));
    let center_dash = (1.0 - step(0.06, abs(gx))) * step(0.45, fract(gz * 0.75));

    // Spec-reactive grid color
    let g_band = sample_band(clamp(abs(puv.x - 0.5) * 1.8, 0.0, 1.0));
    let grid_col = mix(c_cyan, c_pink, clamp(0.35 + 0.45 * sin(z * 0.35 - t * 2.0) + on * 0.3, 0.0, 1.0));

    if (in_road > 0.5) {
      // Dark synthwave asphalt with beat-lit center dashes and neon borders
      col = mix(c_night * 0.35, c_purp * 0.25, fog) + mix(c_pink, c_peach, 0.5) * refl_x * 0.2 * (0.6 + b);
      col += c_peach * center_dash * fog * (1.2 + b * 1.1 + on * 0.8) * glow;
      col += c_cyan * line_z * 0.28 * fog * (0.6 + energy * 0.7);
    } else {
      col += grid_col * grid_line * fog * (0.85 + g_band * 0.9 + b * 0.65 + shock) * glow;
    }
    col += c_pink * road_edge * fog * (1.35 + b * 0.95 + on * 0.8) * glow;

    // Horizon neon bloom band
    let h_glow = exp(-gy * 28.0);
    col += mix(c_pink, c_cyan, 0.35 + 0.35 * sin(t * 1.5)) * h_glow * (0.95 + b * 0.95 + on * 0.85) * glow;
  }

  // --- SCROLLING PIXEL PALM SILHOUETTES ON LEFT & RIGHT ---
  let palm_vis = p_palms();
  if (palm_vis > 0.05) {
    let scroll_p = t * 0.75 * p_speed();
    for (var i = 0; i < 4; i = i + 1) {
      let fi = f32(i);
      let side = select(-1.0, 1.0, (i & 1) == 0);
      let prog = fract(scroll_p + fi * 0.25); // 0 far -> 1 close
      let persp = pow(prog, 1.75);
      let base_y = hor + 0.02 + persp * (1.05 - hor);
      let base_x = 0.5 + side * (0.14 + persp * 0.46);
      let p_scale = 0.08 + persp * 0.44;
      let sway = sin(t * 2.8 + fi * 1.7 + ph * 6.2831) * (0.08 + mid * 0.14 + b * 0.08);
      let lp = vec2f(((puv.x - base_x) * asp) / p_scale, (base_y - puv.y) / p_scale);
      if (palm_mask(lp, sway) > 0.5) {
        let rim_p = select(0.0, 1.0, palm_mask(lp - vec2f(side * 0.04, -0.02), sway) < 0.5);
        let p_col = mix(c_night * 0.3, mix(c_pink, c_cyan, 0.5 + 0.5 * side) * (0.85 + b * 0.7 + on * 0.5), rim_p * 0.75);
        col = mix(col, p_col, palm_vis * smoothstep(0.04, 0.18, prog));
      }
    }
  }

  // Subtle onset flash across the pixel art
  col += mix(c_pink, c_cyan, 0.5) * on * 0.14 * glow;

  return vec4f(max(col, vec3f(0.0)), 1.0);
}
