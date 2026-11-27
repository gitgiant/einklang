// Scrolling time-frequency spectrogram backed by a persistent ring-buffer texture.

struct U {
  // width, height, time, headU
  a: vec4f,
  // direction, freq_scale, gain, gamma
  b: vec4f,
  // pal_mode, mirror, onset_mark, tilt
  c: vec4f,
  // glow, rms, bass, kick
  d: vec4f,
  // phase, bar, subOffsetU, histW
  e: vec4f,
  pal: array<vec4f, 8>,
};

@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var hist_tex: texture_2d<f32>;
@group(0) @binding(2) var hist_samp: sampler;

fn pal_at(t: f32) -> vec3f {
  let f = clamp(t, 0.0, 1.0) * 7.0;
  let i = min(i32(floor(f)), 6);
  return mix(u.pal[i].rgb, u.pal[i + 1].rgb, f - f32(i));
}

fn remap_freq(f: f32, scale_mode: i32) -> f32 {
  let x = clamp(f, 0.0, 1.0);
  if (scale_mode == 1) {
    // Mel-ish: emphasizes midrange while retaining bass detail
    return log2(1.0 + x * 7.0) / 3.0;
  }
  if (scale_mode == 2) {
    // Linear frequency mapped onto the log-band texture
    return log2(1.0 + x * 63.0) / 6.0;
  }
  // Native log-frequency spacing
  return x;
}

fn map_color(mag: f32, v: f32, mode: i32, glow: f32) -> vec3f {
  let floor_mask = smoothstep(0.012, 0.12, mag);
  let hot = smoothstep(0.75, 1.65, mag);

  if (mode == 1) {
    // Thermal: deep void -> dark indigo -> fiery upper palette -> incandescent peak
    let lo = mix(vec3f(0.01, 0.012, 0.03), pal_at(0.25), smoothstep(0.02, 0.3, mag));
    let mid = pal_at(clamp(0.25 + mag * 0.72, 0.0, 1.0));
    let base = mix(lo, mid, smoothstep(0.15, 0.75, mag));
    let col = mix(base, vec3f(1.0, 0.96, 0.88), hot * 0.75);
    return col * (0.14 + mag * 1.15) * floor_mask * glow;
  }
  if (mode == 2) {
    // Vivid: frequency selects palette hue, magnitude drives intensity and hot peaks
    let freq_col = pal_at(clamp(0.12 + v * 0.82, 0.0, 1.0));
    let peak_col = mix(freq_col, pal_at(0.95) + vec3f(0.35), hot * 0.7);
    return peak_col * (0.2 + mag * 1.25) * floor_mask * glow;
  }
  if (mode == 3) {
    // Mono: crisp sonar / phosphor tint from palette primary
    let tint = normalize(pal_at(0.62) + vec3f(0.08)) * 1.25;
    let col = mix(tint * 0.65, vec3f(0.95, 1.0, 0.98), hot * 0.72);
    return col * (0.16 + mag * 1.2) * floor_mask * glow;
  }
  // Mode 0: direct palette mapping by magnitude
  let pal_t = clamp(mag * 0.78, 0.0, 1.0);
  let base = pal_at(pal_t);
  let col = mix(base, vec3f(1.0, 0.98, 0.95), hot * 0.52);
  return col * (0.16 + mag * 1.12) * floor_mask * glow;
}

@fragment
fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  let time = u.a.z;
  let head_u = u.a.w;
  let dir = i32(round(u.b.x));
  let freq_scale = i32(round(u.b.y));
  let gain = u.b.z;
  let gamma = u.b.w;
  let pal_mode = i32(round(u.c.x));
  let mirror = u.c.y > 0.5;
  let onset_mark = u.c.z;
  let tilt = clamp(u.c.w, 0.0, 1.0);
  let glow = u.d.x;
  let rms = u.d.y;
  let bass = u.d.z;
  let kick = u.d.w;
  let sub_off = u.e.z;
  let hist_w = u.e.w;

  let span = (hist_w - 3.0) / hist_w;
  let horizon_y = 0.27 * tilt;
  let mist_col = pal_at(0.28) * (0.05 + 0.09 * rms + 0.06 * kick);

  // Above the perspective horizon: atmospheric sky + live spectrum horizon reflection
  if (tilt > 0.005 && uv.y < horizon_y) {
    let sky_t = uv.y / max(horizon_y, 0.001);
    let bg = mix(vec3f(0.006, 0.008, 0.016), mist_col * 1.35, pow(sky_t, 2.2));

    // Faint live spectrum silhouette glowing above the horizon line
    var hf = uv.x;
    if (mirror) {
      hf = abs(hf - 0.5) * 2.0;
    }
    let hv = remap_freq(hf, freq_scale);
    let live_s = textureSampleLevel(hist_tex, hist_samp, vec2f(fract(head_u), clamp(hv, 0.004, 0.996)), 0.0);
    let live_mag = pow(max((live_s.r / 0.85) * gain, 0.0), gamma);
    let h_dist = (horizon_y - uv.y) / max(horizon_y, 0.001);
    let ridge_glow = exp(-h_dist * (5.5 / max(0.25 + live_mag * 0.9, 0.25))) * (0.2 + 0.55 * live_mag);
    let h_line = exp(-abs(horizon_y - uv.y) * 140.0) * (0.35 + 0.55 * kick + 0.35 * bass);
    let sky_rgb = bg + pal_at(clamp(0.35 + live_mag * 0.5, 0.0, 1.0)) * (ridge_glow * 0.65 + h_line * 0.9) * glow * 0.6;
    return vec4f(sky_rgb, 1.0);
  }

  // Project screen UV onto flat wall (tilt=0) or receding 3D perspective floor (tilt>0)
  var px = uv.x;
  var py = uv.y;
  var depth = 0.0;
  var in_bounds = 1.0;

  if (tilt > 0.005) {
    let sy = clamp((uv.y - horizon_y) / max(1.0 - horizon_y, 0.001), 0.001, 1.0);
    // Perspective depth mapping: sy=1 (bottom) -> near, sy=0 (horizon) -> far
    let z_near = 1.0;
    let z_far = mix(1.0, 7.5, tilt);
    let inv_z = mix(1.0 / z_far, 1.0 / z_near, sy);
    let z = 1.0 / inv_z;
    let depth_persp = clamp((z - z_near) / max(z_far - z_near, 0.001), 0.0, 1.0);
    depth = mix(0.0, depth_persp, smoothstep(0.0, 0.25, tilt));

    // Horizontal foreshortening on the floor plane
    let x_scale = mix(1.0, 0.56 + 0.44 * z / 2.2, tilt);
    px = 0.5 + (uv.x - 0.5) * x_scale;
    py = mix(uv.y, 1.0 - depth_persp, tilt);

    // Soft side bounds with glowing rails along px=0 and px=1
    let edge_d = max(-px, px - 1.0);
    in_bounds = 1.0 - smoothstep(0.0, 0.015, edge_d);
  }

  // Map (px, py) to (age, freq) based on scroll direction
  var age = 1.0 - px;
  var freq = 1.0 - py;
  if (dir == 1) {
    age = px;
    freq = 1.0 - py;
  } else if (dir == 2) {
    age = 1.0 - py;
    freq = px;
  } else if (dir == 3) {
    age = py;
    freq = px;
  }

  if (mirror) {
    freq = abs(freq - 0.5) * 2.0;
  }

  let v = clamp(remap_freq(freq, freq_scale), 0.004, 0.996);
  let u_coord = fract(head_u - clamp(age, 0.0, 1.0) * span - sub_off);

  // Sample ring buffer texture
  let samp = textureSampleLevel(hist_tex, hist_samp, vec2f(u_coord, v), 0.0);
  let mag_raw = samp.r / 0.85;
  let onset_col = samp.g;
  let col_rms = samp.b;
  let flux = samp.a / 2.5;

  let shaped = max(mag_raw * gain + flux * 0.22, 0.0);
  let mag = pow(shaped, gamma);

  // Base spectrogram color
  var col = map_color(mag, v, pal_mode, glow);

  // Subtle dark instrument backdrop so quiet passages remain atmospheric and legible
  let bg_tint = pal_at(0.12 + 0.18 * v) * (0.018 + 0.025 * col_rms);
  col = col + bg_tint;

  // Subtle contour / height relief shading when tilted into 3D perspective
  if (tilt > 0.05) {
    let du = 1.5 / hist_w;
    let samp_prev = textureSampleLevel(hist_tex, hist_samp, vec2f(fract(u_coord - du), v), 0.0);
    let mag_prev = pow(max((samp_prev.r / 0.85) * gain, 0.0), gamma);
    let slope = clamp((mag - mag_prev) * 2.4, 0.0, 1.0);
    let relief_col = mix(pal_at(0.85), vec3f(1.0, 0.98, 0.95), 0.5);
    col = col + relief_col * slope * tilt * 0.45 * glow;
  }

  // Subtle frequency octave graticule & time ticks (instrument/SDR feel)
  let freq_grid = abs(fract(freq * 8.0 + 0.5) - 0.5);
  let time_grid = abs(fract(age * 12.0 + time * 0.0 + 0.5) - 0.5);
  let f_line = smoothstep(0.028, 0.0, freq_grid);
  let t_line = smoothstep(0.022, 0.0, time_grid);
  let grid_col = pal_at(0.45) * (0.045 + 0.05 * rms);
  col = col + grid_col * (f_line * 0.7 + t_line * 0.45);

  // Onset marker column highlight
  if (onset_mark > 0.005 && onset_col > 0.05) {
    let om = onset_col * onset_mark;
    let mark_tint = mix(pal_at(0.88), vec3f(1.0, 0.97, 0.92), 0.55);
    // Subtle full-column flash + stronger peak amplification + crisp edge tick
    let edge_tick = smoothstep(0.06, 0.0, min(freq, 1.0 - freq));
    col = col + mark_tint * (0.14 + 0.48 * min(mag, 1.4) + 0.45 * edge_tick) * om * glow;
  }

  // Crisp glowing leading-edge "playhead" where live audio enters the spectrogram
  let lead_glow = exp(-age * 95.0) * (0.28 + 0.55 * rms + 0.45 * kick + 0.65 * min(mag, 1.2));
  let lead_tint = mix(pal_at(0.82), vec3f(1.0, 0.98, 0.96), 0.5);
  col = col + lead_tint * lead_glow * glow * 0.65;

  // Apply 3D floor side rails and horizon distance fog when tilted
  if (tilt > 0.005) {
    let rail_d = min(abs(px), abs(px - 1.0));
    let rail = exp(-rail_d * 90.0) * (0.22 + 0.35 * rms + 0.35 * kick) * smoothstep(0.0, 0.25, tilt);
    let side_void = mix(vec3f(0.005, 0.007, 0.014), mist_col, pow(depth, 1.4));
    col = mix(side_void, col, in_bounds) + pal_at(0.65) * rail * glow * 0.55;

    // Distance fog toward horizon
    let fog_amt = pow(depth, 1.75) * 0.82 * tilt;
    col = mix(col, mist_col * 1.25, fog_amt);

    // Subtle horizon glow seam
    let h_seam = exp(-abs(uv.y - horizon_y) * 140.0) * (0.35 + 0.55 * kick + 0.35 * bass);
    col = col + pal_at(0.7) * h_seam * glow * 0.5;
  }

  return vec4f(max(col, vec3f(0.0)), 1.0);
}
