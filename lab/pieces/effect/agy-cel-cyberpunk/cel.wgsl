// Cyberpunk cel shader: hard neon tone bands (magenta / cyan / acid yellow),
// glowing bass-driven ink outlines, city-night rain streaks, holographic scanlines,
// and onset-triggered chromatic glitch tears.

struct U {
  res_time: vec4f,      // width, height, time, aspect
  audio0: vec4f,        // bass, mid, high, rms
  audio1: vec4f,        // onset, hit_env, phase, bar
  params0: vec4f,       // bands, neon_mix, ink, ink_glow
  params1: vec4f,       // rain, scanlines, glitch, glow
  flags: vec4f,         // has_luma, has_edges, use_fallback, pal_count
  spec0: vec4f,         // bands 0..3
  spec1: vec4f,         // bands 4..7
  spec2: vec4f,         // bands 8..11
  spec3: vec4f,         // bands 12..15
  pal: array<vec4f, 8>, // OKLab stops
};

@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var t_src: texture_2d<f32>;
@group(0) @binding(3) var t_luma: texture_2d<f32>;
@group(0) @binding(4) var t_edges: texture_2d<f32>;

const LUMA_W = vec3f(0.2126, 0.7152, 0.0722);

fn hash11(p: f32) -> f32 {
  var x = fract(p * 0.1031);
  x *= x + 33.33;
  x *= x + x;
  return fract(x);
}

fn hash21(p: vec2f) -> f32 {
  var q = fract(p * vec2f(123.34, 456.21));
  q += dot(q, q + 45.32);
  return fract(q.x * q.y);
}

fn oklab_to_lin(c: vec3f) -> vec3f {
  let l_ = c.x + 0.3963377774 * c.y + 0.2158037573 * c.z;
  let m_ = c.x - 0.1055613458 * c.y - 0.0638541728 * c.z;
  let s_ = c.x - 0.0894841775 * c.y - 1.2914855480 * c.z;
  let l = l_ * l_ * l_;
  let m = m_ * m_ * m_;
  let s = s_ * s_ * s_;
  return max(vec3f(
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s
  ), vec3f(0.0));
}

fn sample_pal(x: f32) -> vec3f {
  let n = max(1, i32(u.flags.w));
  if (n <= 1) { return oklab_to_lin(u.pal[0].xyz); }
  let f = clamp(x, 0.0, 1.0) * f32(n - 1);
  let i = min(n - 2, i32(floor(f)));
  let t = f - f32(i);
  return oklab_to_lin(mix(u.pal[i].xyz, u.pal[i + 1].xyz, t));
}

fn spec_band(i: i32) -> f32 {
  let k = clamp(i, 0, 15);
  if (k < 4) { return u.spec0[k]; }
  if (k < 8) { return u.spec1[k - 4]; }
  if (k < 12) { return u.spec2[k - 8]; }
  return u.spec3[k - 12];
}

fn perc_luma(c: vec3f) -> f32 {
  let y = max(dot(max(c, vec3f(0.0)), LUMA_W), 0.0);
  // Tone-compressed perceptual brightness so both dim night scenes and bright HDR frames map cleanly
  return pow(y / (y + 0.55), 0.56) * 1.18;
}

fn sample_src(uv: vec2f) -> vec3f {
  return max(textureSampleLevel(t_src, samp, clamp(uv, vec2f(0.001), vec2f(0.999)), 0.0).rgb, vec3f(0.0));
}

// Hard cel quantization with a razor-thin anti-aliased edge between steps
fn cel_quant(v: f32, n: f32) -> f32 {
  let scaled = clamp(v, 0.0, 0.999) * n;
  let fl = floor(scaled);
  let fr = scaled - fl;
  let stepped = fl + smoothstep(0.46, 0.54, fr);
  return clamp(stepped / max(n - 1.0, 1.0), 0.0, 1.0);
}

// Angled cyberpunk rain layer: returns (streak_intensity, drop_glint, color_id)
fn rain_layer(p: vec2f, cols: f32, speed: f32, t: f32, slant: f32, density: f32, seed: f32) -> vec3f {
  // Tilt coordinates slightly for cyber wind slant
  let q = vec2f(p.x + p.y * slant, p.y);
  let col_x = q.x * cols;
  let cid = floor(col_x);
  let lx = fract(col_x) - 0.5;
  let r0 = hash11(cid * 17.31 + seed);
  let r1 = hash11(cid * 43.17 + seed + 9.1);
  let r2 = hash11(cid * 91.73 + seed + 21.7);

  if (r0 > density) { return vec3f(0.0); }

  let v = speed * (0.65 + 0.75 * r1);
  let period = 1.15 + 1.45 * r2;
  let y_run = fract((q.y - t * v + r0 * 7.3) / period);

  // Tail tapers upward; bright head droplet at leading tip
  let len = 0.14 + 0.22 * r1;
  let in_streak = smoothstep(0.0, 0.02, y_run) * (1.0 - smoothstep(len * 0.18, len, y_run));
  let head = exp(-pow((y_run - 0.018) * 52.0, 2.0));
  let thin = smoothstep(0.24, 0.04, abs(lx));

  return vec3f(in_streak * thin, head * thin, r2);
}

fn soft_clip(c: vec3f) -> vec3f {
  let m = max(c, vec3f(0.0));
  return m / (vec3f(1.0) + m * 0.28);
}

@fragment fn fs_cel(in: VOut) -> @location(0) vec4f {
  let uv = in.uv;
  let res = u.res_time.xy;
  let t = u.res_time.z;
  let asp = max(u.res_time.w, 0.5);

  let bass = u.audio0.x;
  let mid = u.audio0.y;
  let high = u.audio0.z;
  let rms = u.audio0.w;
  let onset = u.audio1.x;
  let hit = u.audio1.y;
  let phase = u.audio1.z;

  let p_bands = clamp(round(u.params0.x), 2.0, 8.0);
  let p_neon = u.params0.y;
  let p_ink = u.params0.z;
  let p_ink_glow = u.params0.w;
  let p_rain = u.params1.x;
  let p_scan = u.params1.y;
  let p_glitch = u.params1.z;
  let p_glow = u.params1.w;

  // Musical envelopes: calm on silence, surging sharply on beats and bass
  let beat_kick = pow(max(0.0, 1.0 - phase * 2.6), 2.2) * clamp(bass * 1.15 + rms * 0.35, 0.0, 1.25);
  let audio_energy = clamp(bass * 0.85 + mid * 0.45 + rms * 0.65 + beat_kick * 0.55, 0.0, 2.0);
  let tear_drive = clamp((hit * 1.25 + onset * 0.85 + beat_kick * 0.60 + high * 0.35) * p_glitch, 0.0, 2.4);

  // Subtle bass camera punch so beats physically breathe
  let zoom = 1.0 + (bass * 0.028 + beat_kick * 0.025 + hit * 0.022);
  let base_uv = (uv - 0.5) / zoom + 0.5;

  // --- ONSET-TRIGGERED HORIZONTAL GLITCH TEARS ---
  let step_t = floor(t * 14.0 + hit * 6.0);
  let band_y = floor(base_uv.y * 28.0);
  let strip_rnd = hash21(vec2f(band_y, step_t));
  let fine_y = floor(base_uv.y * 84.0);
  let fine_rnd = hash21(vec2f(fine_y + 13.0, step_t * 1.7));

  let tear_thresh = 1.0 - clamp(tear_drive * 0.34, 0.0, 0.68);
  let tear_mask = step(tear_thresh, strip_rnd);
  let fine_mask = step(1.0 - clamp(tear_drive * 0.22, 0.0, 0.45), fine_rnd);
  let slice_shift = ((hash21(vec2f(band_y + 7.1, step_t)) - 0.5) * 0.14 * tear_mask
                   + (hash21(vec2f(fine_y + 31.0, step_t)) - 0.5) * 0.06 * fine_mask) * tear_drive;

  // Radial + tear chromatic split offset
  let radial_ab = (base_uv.x - 0.5) * (0.002 + 0.011 * (bass * 0.7 + hit * 0.9) * p_glitch);
  let chroma_dx = radial_ab + (0.0025 + 0.018 * tear_drive * (0.25 + 0.75 * max(tear_mask, fine_mask)));

  let suv = clamp(base_uv + vec2f(slice_shift, 0.0), vec2f(0.002), vec2f(0.998));
  let px = vec2f(1.55) / max(res, vec2f(1.0));

  // --- 3x3 CHROMATIC + LUMA SOBEL & SOFT PRE-FILTER FOR CLEAN CEL ISLANDS ---
  let c_c  = sample_src(suv);
  let c_tl = sample_src(suv + vec2f(-px.x, -px.y));
  let c_tc = sample_src(suv + vec2f(0.0,   -px.y));
  let c_tr = sample_src(suv + vec2f(px.x,  -px.y));
  let c_ml = sample_src(suv + vec2f(-px.x,  0.0));
  let c_mr = sample_src(suv + vec2f(px.x,   0.0));
  let c_bl = sample_src(suv + vec2f(-px.x,  px.y));
  let c_bc = sample_src(suv + vec2f(0.0,    px.y));
  let c_br = sample_src(suv + vec2f(px.x,   px.y));

  let l_c  = perc_luma(c_c);
  let l_tl = perc_luma(c_tl); let l_tc = perc_luma(c_tc); let l_tr = perc_luma(c_tr);
  let l_ml = perc_luma(c_ml);                              let l_mr = perc_luma(c_mr);
  let l_bl = perc_luma(c_bl); let l_bc = perc_luma(c_bc); let l_br = perc_luma(c_br);

  // Luma Sobel
  let gx_l = (l_tr + 2.0 * l_mr + l_br) - (l_tl + 2.0 * l_ml + l_bl);
  let gy_l = (l_bl + 2.0 * l_bc + l_br) - (l_tl + 2.0 * l_tc + l_tr);
  let edge_l = length(vec2f(gx_l, gy_l)) * 0.42;

  // Color-channel Sobel (catches iso-luminant neon/hue boundaries)
  let gx_c = (c_tr + 2.0 * c_mr + c_br) - (c_tl + 2.0 * c_ml + c_bl);
  let gy_c = (c_bl + 2.0 * c_bc + c_br) - (c_tl + 2.0 * c_tc + c_tr);
  let edge_rgb = sqrt(max(dot(gx_c, gx_c) + dot(gy_c, gy_c), 0.0)) * 0.28;

  // Soft 5-tap cross pre-filter so cel bands stay graphic and flat, not noisy
  let smooth_c = (c_c * 2.0 + c_tc + c_bc + c_ml + c_mr) / 6.0;
  let smooth_l = (l_c * 2.0 + l_tc + l_bc + l_ml + l_mr) / 6.0;

  // Combine optional core-media luma/edges ONLY when they correspond to the active source
  var aux_edge = 0.0;
  var base_luma = smooth_l;
  if (u.flags.x > 0.5 && u.flags.z < 0.5) {
    let ml = clamp(textureSampleLevel(t_luma, samp, suv, 0.0).x, 0.0, 1.0);
    let agree = 1.0 - smoothstep(0.10, 0.30, abs(l_c - ml));
    base_luma = mix(smooth_l, mix(smooth_l, ml, 0.45), agree);
    if (u.flags.y > 0.5) {
      let me = length(textureSampleLevel(t_edges, samp, suv, 0.0).xy);
      aux_edge = me * agree;
    }
  }

  // --- HARD NEON CEL TONE BANDS ---
  // Musical contrast & exposure breathing: quiet stays moody city-night; loud beats expand bright neon cel bands!
  let cel_luma_in = clamp(base_luma * (0.80 + 0.46 * bass + 0.30 * rms + 0.28 * beat_kick) + 0.05 * hit, 0.0, 1.0);
  let q_band = cel_quant(cel_luma_in, p_bands);

  // Detect cel-band contour seam (where neighbors jump to a different cel band)
  let seam_gain = 0.80 + 0.46 * bass + 0.30 * rms + 0.28 * beat_kick;
  let q_tc = cel_quant(clamp(l_tc * seam_gain, 0.0, 1.0), p_bands);
  let q_bc = cel_quant(clamp(l_bc * seam_gain, 0.0, 1.0), p_bands);
  let q_ml = cel_quant(clamp(l_ml * seam_gain, 0.0, 1.0), p_bands);
  let q_mr = cel_quant(clamp(l_mr * seam_gain, 0.0, 1.0), p_bands);
  let band_seam = clamp((abs(q_tc - q_bc) + abs(q_ml - q_mr)) * 1.15, 0.0, 1.0);

  // Iconic cyberpunk neon triad + city-night deep indigo
  let col_night   = vec3f(0.012, 0.010, 0.048); // deep midnight indigo
  let col_violet  = vec3f(0.140, 0.020, 0.340); // electric dark violet
  let col_magenta = vec3f(1.350, 0.025, 0.480); // hot neon magenta
  let col_cyan    = vec3f(0.020, 1.080, 1.320); // electric cyan
  let col_acid    = vec3f(1.180, 1.320, 0.025); // acid yellow

  // Warm vs cool affinity from source hue: keeps subjects recognizable while snapping into cyberpunk triad!
  let max_c = max(smooth_c.r, max(smooth_c.g, smooth_c.b));
  let norm_c = smooth_c / max(max_c, 0.001);
  let warmth = clamp((norm_c.r - norm_c.b) * 0.85 + (norm_c.r - norm_c.g) * 0.25 + 0.5 + 0.14 * sin(t * 0.6 + bass * 2.2), 0.0, 1.0);

  // Hard cyberpunk neon band palette lookup
  var neon_band: vec3f;
  if (q_band < 0.18) {
    // Deep city-night shadow band
    neon_band = mix(col_night, col_violet * 0.45, q_band / 0.18);
  } else if (q_band < 0.48) {
    // Lower midtone: violet <-> cyan/magenta split
    let k = (q_band - 0.18) / 0.30;
    let mid_cool = mix(col_violet, col_cyan * 0.68, k);
    let mid_warm = mix(col_violet, col_magenta * 0.78, k);
    neon_band = mix(mid_cool, mid_warm, smoothstep(0.32, 0.68, warmth));
  } else if (q_band < 0.82) {
    // Upper midtone: electric cyan vs hot magenta punch
    let k = (q_band - 0.48) / 0.34;
    let hi_cool = mix(col_cyan * 0.92, mix(col_cyan, col_acid, 0.28), k);
    let hi_warm = mix(col_magenta * 0.96, mix(col_magenta, col_acid, 0.42), k);
    neon_band = mix(hi_cool, hi_warm, smoothstep(0.35, 0.65, warmth));
  } else {
    // Peak specular cel band: blazing acid yellow + electric white-cyan highlight
    neon_band = mix(col_acid, vec3f(0.95, 1.25, 1.30), smoothstep(0.75, 0.25, warmth) * 0.45);
  }

  // Blend in the scene's wired palette so sections/palettes steer the cyberpunk mood
  let pal_band = sample_pal(clamp(q_band * 0.88 + 0.06 + 0.08 * bass, 0.0, 1.0));
  neon_band = mix(neon_band, pal_band * (0.35 + 1.25 * q_band), 0.46);

  // Posterized source color (preserves photo/video identity cleanly with quantized luminance & boosted cyberpunk chroma)
  let poster_hue = mix(vec3f(dot(norm_c, LUMA_W)), norm_c, 1.48);
  let poster_src = max(poster_hue, vec3f(0.0)) * (0.04 + 1.05 * pow(q_band, 1.15)) + col_night * (1.0 - q_band) * 0.55;

  // Dynamic neon mix: calmer/darker on quiet passages, blazing neon on bass hits
  let eff_neon = clamp(p_neon * (0.72 + 0.36 * bass + 0.22 * rms), 0.0, 1.0);
  var cel_col = mix(poster_src, neon_band, eff_neon);

  // Graphic-novel diagonal cyber-hatching in mid-shadow cel bands
  let hatch_p = (uv.x * asp + uv.y) * res.y * 0.22;
  let hatch_line = smoothstep(0.62, 0.88, abs(fract(hatch_p) - 0.5) * 2.0);
  let shadow_zone = smoothstep(0.04, 0.16, q_band) * (1.0 - smoothstep(0.34, 0.52, q_band));
  cel_col *= 1.0 - hatch_line * shadow_zone * 0.26;

  // --- CHROMATIC GLITCH TEAR COLOR SEPARATION ---
  if (tear_drive > 0.04) {
    let r_tap = sample_src(suv + vec2f(chroma_dx, 0.0));
    let b_tap = sample_src(suv - vec2f(chroma_dx, 0.0));
    let qr = cel_quant(perc_luma(r_tap), p_bands);
    let qb = cel_quant(perc_luma(b_tap), p_bands);
    let split_sig = (qr - qb);
    let tear_boost = 0.28 + 1.15 * max(tear_mask, fine_mask);
    // CMY/Neon chromatic tear fringes (hot magenta on one edge, electric cyan on the other, acid yellow on hard strips)
    cel_col += col_magenta * max(split_sig, 0.0) * tear_drive * tear_boost * 0.85;
    cel_col += col_cyan    * max(-split_sig, 0.0) * tear_drive * tear_boost * 0.85;
    if (tear_mask > 0.5 && tear_drive > 0.38) {
      let flash_col = select(col_cyan, col_acid, hash21(vec2f(band_y, step_t + 3.0)) > 0.55);
      cel_col = mix(cel_col, flash_col * (0.45 + 0.85 * q_band), 0.38 * clamp(tear_drive, 0.0, 1.0));
    }
  }

  // Bass & beat-kick global neon luminance surge (creates unmistakable musical dynamics)
  let neon_drive = p_glow * (0.48 + 0.68 * bass + 0.42 * rms + 0.52 * beat_kick + 0.36 * hit);
  cel_col *= neon_drive;

  // --- GLOWING INK OUTLINES (DARK INK CORE + BASS-DRIVEN NEON EDGE HALO) ---
  let raw_edge = max(max(edge_l, edge_rgb), aux_edge * 0.95);
  let total_edge = max(raw_edge, band_seam * 0.36);

  // Crisp dark comic/anime ink line right on the contour
  let ink_core = smoothstep(0.17, 0.44, raw_edge * (0.75 + 0.55 * p_ink));
  let seam_core = smoothstep(0.32, 0.72, band_seam) * 0.42;
  let ink_mask = clamp(max(ink_core, seam_core) * clamp(p_ink, 0.0, 1.6), 0.0, 0.94);

  // Wider glowing neon halo hugging the ink contours, colored by edge orientation & audio
  let edge_ang = atan2(gy_l, gx_l) / 6.2831853 + 0.5;
  let halo_t = fract(edge_ang + t * 0.12 + bass * 0.25);
  var edge_neon: vec3f;
  if (halo_t < 0.38) {
    edge_neon = mix(col_cyan, col_magenta, halo_t / 0.38);
  } else if (halo_t < 0.76) {
    edge_neon = mix(col_magenta, col_acid, (halo_t - 0.38) / 0.38);
  } else {
    edge_neon = mix(col_acid, col_cyan, (halo_t - 0.76) / 0.24);
  }
  edge_neon = mix(edge_neon, sample_pal(fract(edge_ang + 0.5)), 0.35);

  let halo_env = smoothstep(0.08, 0.34, total_edge) * (1.0 - ink_core * 0.58);
  let rim_core = smoothstep(0.28, 0.72, raw_edge);
  let bass_glow = p_ink_glow * (0.22 + 1.18 * bass + 0.78 * beat_kick + 0.62 * hit);

  // Ink core darkens the center of contours, then blazing neon outline glow lights the rim
  var col = mix(cel_col, vec3f(0.008, 0.004, 0.024), ink_mask * 0.88);
  col += edge_neon * (halo_env * 0.95 + rim_core * 0.72) * bass_glow;

  // --- CITY-NIGHT ANGLED NEON RAIN STREAKS ---
  if (p_rain > 0.01) {
    let rain_spd = 0.72 + 0.65 * rms + 0.55 * bass;
    let rain_dens = clamp(0.32 + 0.32 * p_rain + 0.20 * high + 0.14 * bass, 0.0, 0.88);
    let r_far  = rain_layer(vec2f(uv.x * asp, uv.y), 92.0, rain_spd * 0.85, t, 0.16, rain_dens, 11.3);
    let r_near = rain_layer(vec2f(uv.x * asp, uv.y), 46.0, rain_spd * 1.45, t, 0.20, rain_dens * 0.68, 73.9);

    let r_col_far  = mix(col_cyan, col_magenta, step(0.62, r_far.z)) * 0.55;
    let r_col_near = select(mix(col_cyan, col_magenta, step(0.45, r_near.z)), col_acid, r_near.z > 0.82);

    // Raindrops catch extra neon specular sparkle as they cross inked subject contours
    let edge_splash = 1.0 + 1.45 * smoothstep(0.15, 0.55, raw_edge);
    let rain_gain = p_rain * (0.26 + 0.55 * high + 0.45 * bass + 0.38 * rms);
    col += r_col_far * (r_far.x * 0.55 + r_far.y * 0.9) * rain_gain;
    col += r_col_near * (r_near.x * 0.75 + r_near.y * 1.55) * rain_gain * edge_splash;
  }

  // --- HOLOGRAPHIC SCANLINES & BEAT-SWEEP VISOR ---
  if (p_scan > 0.01) {
    // Crisp high-res holographic scanline grille
    let scan_wave = 0.5 + 0.5 * sin(uv.y * res.y * 1.05 + t * 4.0);
    let scan_depth = clamp(p_scan * 0.20 * (0.7 + 0.5 * rms), 0.0, 0.30);
    col *= 1.0 - scan_depth * scan_wave;

    // Sweeping holographic scan beam locked to beat phase + slow time
    let beam_y = fract(phase * 0.5 + t * 0.24);
    let bd = min(abs(uv.y - beam_y), 1.0 - abs(uv.y - beam_y));
    let beam = exp(-bd * bd * 480.0);
    let beam_trail = exp(-fract(beam_y - uv.y) * 18.0) * smoothstep(0.18, 0.0, fract(beam_y - uv.y));
    let holo_col = mix(col_cyan, col_magenta, 0.5 + 0.5 * sin(uv.x * 9.0 - t * 3.0));
    let holo_amp = p_scan * (0.14 + 0.58 * mid + 0.55 * beat_kick + 0.42 * hit);
    col += holo_col * (beam * 0.85 + beam_trail * 0.22) * holo_amp;

    // Subtle side-edge holographic spectrum ticks (left & right visor telemetry)
    let side_d = min(uv.x, 1.0 - uv.x);
    if (side_d < 0.022) {
      let tick_i = i32(clamp(floor((1.0 - uv.y) * 16.0), 0.0, 15.0));
      let tick_f = fract(uv.y * 16.0);
      let bv = spec_band(tick_i);
      let tick_w = 0.004 + bv * 0.016;
      if (side_d < tick_w && tick_f > 0.22 && tick_f < 0.78) {
        let tick_col = mix(col_cyan, col_acid, bv);
        col += tick_col * (0.35 + 1.15 * bv) * p_scan * 0.75;
      }
    }
  }

  // City-night moody indigo framing vignette (keeps edges grounded, center vivid)
  let vig_p = (uv - 0.5) * vec2f(1.25, 1.15);
  let vig = 1.0 - smoothstep(0.45, 0.96, length(vig_p)) * 0.34;
  col = col * vig + col_night * (1.0 - vig) * (0.45 + 0.35 * bass);

  return vec4f(soft_clip(col), 1.0);
}
