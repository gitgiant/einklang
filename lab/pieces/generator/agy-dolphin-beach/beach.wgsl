// Dithered pixel-art vaporwave beach with leaping sprite dolphins.

struct U {
  dims: vec4f,    // width, height, cells, aspect
  timing: vec4f,  // time, phase, bpm, bar
  audio: vec4f,   // rms, bassEnv, onsetEnv, high
  params: vec4f,  // dolphins, jump, waves, dither
  extra: vec4f,   // glow, spr_w, spr_h, spr_frames
  bands: array<vec4f, 4>,
  pal: array<vec4f, 8>,
};

@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var sheet: texture_2d_array<f32>;

fn pal_at(t: f32) -> vec3f {
  let x = clamp(t, 0.0, 0.999) * 7.0;
  let i = i32(x);
  return mix(u.pal[i].rgb, u.pal[i + 1].rgb, x - f32(i));
}

fn band_at(i: i32) -> f32 {
  let c = clamp(i, 0, 15);
  let v = u.bands[c >> 2];
  let r = c & 3;
  if (r == 0) { return v.x; }
  if (r == 1) { return v.y; }
  if (r == 2) { return v.z; }
  return v.w;
}

fn sample_band(x: f32) -> f32 {
  let f = clamp(x, 0.0, 1.0) * 15.0;
  let i = i32(floor(f));
  return mix(band_at(i), band_at(min(15, i + 1)), fract(f));
}

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
  var q = fract(p * vec2f(127.1, 311.7));
  q += dot(q, q + 19.19);
  return fract(q.x * q.y);
}

fn spr_texel(p: vec2i, layer: i32) -> vec4f {
  let sz = vec2i(i32(u.extra.y), i32(u.extra.z));
  if (p.x < 0 || p.y < 0 || p.x >= sz.x || p.y >= sz.y) { return vec4f(0.0); }
  return textureLoad(sheet, p, layer, 0);
}

fn palm_silhouette(lp: vec2f, sway: f32) -> f32 {
  let h = lp.y;
  if (h < 0.0 || h > 1.4) { return 0.0; }
  let curve = sway * h * h + 0.22 * sin(h * 1.9);
  if (h <= 1.0 && abs(lp.x - curve) < mix(0.075, 0.026, h)) { return 1.0; }
  let d = lp - vec2f(curve, 1.0);
  if (length(d) > 0.68) { return 0.0; }
  for (var k = 0; k < 6; k = k + 1) {
    let side = select(-1.0, 1.0, k >= 3);
    let tier = f32(k % 3);
    let reach = 0.48 + tier * 0.06;
    let dx = d.x * side;
    if (dx > -0.02 && dx < reach) {
      let t = clamp(dx / reach, 0.0, 1.0);
      let arch = (0.26 - tier * 0.14) * t - (0.36 + tier * 0.05) * t * t;
      let thick = mix(0.058, 0.016, t) + 0.02 * sin(t * 20.0);
      if (abs(d.y - arch) < thick) { return 1.0; }
    }
  }
  return 0.0;
}

@fragment fn fs_beach(v: VOut) -> @location(0) vec4f {
  let cells = max(64.0, floor(u.dims.z));
  let asp = u.dims.w;
  let grid = vec2f(floor(cells * asp), cells);
  let pix = floor(v.uv * grid);
  let puv = (pix + 0.5) / grid;
  let dval = bayer4(vec2i(pix));

  let t = u.timing.x;
  let ph = u.timing.y;
  let bpm = max(60.0, u.timing.z);
  let beats = t * bpm / 60.0;

  let rms = u.audio.x;
  let bass = u.audio.y;
  let onset = u.audio.z;
  let hi = u.audio.w;
  let energy = clamp(bass * 0.65 + onset * 0.5 + rms * 0.4, 0.0, 1.6);

  let dither = u.params.w;
  let wave_amp = u.params.z;
  let glow = u.extra.x;

  let c_night = pal_at(0.02) * 0.35;
  let c_purp  = pal_at(0.22);
  let c_pink  = pal_at(0.46);
  let c_peach = pal_at(0.66);
  let c_cyan  = pal_at(0.84);
  let c_mint  = pal_at(0.98);

  let hor = 0.48;
  let shore = 0.82 + sin(puv.x * 9.0 + t * 1.4) * 0.015 * wave_amp;

  var col = vec3f(0.0);

  if (puv.y < hor) {
    // --- DITHERED VAPORWAVE SUNSET SKY ---
    let sy = clamp(puv.y / hor, 0.0, 1.0);
    let q = floor(clamp(sy + (dval - 0.5) * dither / 6.0, 0.0, 1.0) * 6.0) / 6.0;
    let sky_lo = mix(c_night, c_purp, smoothstep(0.0, 0.5, q));
    let sky_hi = mix(c_pink, c_peach, smoothstep(0.45, 1.0, q));
    col = mix(sky_lo, sky_hi, smoothstep(0.3, 0.95, q)) * (0.78 + energy * 0.42);

    // Pixel clouds drifting across the upper sky
    let cx = puv.x * 4.5 + t * 0.08;
    let cy = sy * 3.5;
    let cloud = sin(cx * 2.1 + sin(cy * 2.7)) * cos(cx * 0.9 - cy * 1.4);
    if (sy > 0.16 && sy < 0.72 && cloud > (0.58 - rms * 0.12)) {
      let c_d = step(dval, (cloud - 0.45) * 1.8);
      col = mix(col, mix(c_pink, c_peach, 0.65) * (0.85 + bass * 0.45), c_d * 0.45);
    }

    // Stars
    if (sy < 0.48 && hash21(pix) > 0.989) {
      let tw = 0.5 + 0.5 * sin(t * 7.0 + pix.x);
      col += mix(c_cyan, vec3f(1.0), 0.5) * tw * (0.65 + hi * 1.6 + onset * 1.1);
    }

    // Slatted sunset sun resting on the ocean horizon
    let sun_c = vec2f(0.5, hor - 0.105);
    let sd = vec2f((puv.x - sun_c.x) * asp, puv.y - sun_c.y);
    let sr = 0.18 + bass * 0.042 + onset * 0.025;
    let d_sun = length(sd);
    col += mix(c_pink, c_peach, 0.5) * exp(-d_sun * (4.4 - energy * 0.8)) * (0.5 + energy * 0.6);

    if (d_sun < sr) {
      let sv = clamp((sd.y + sr) / (2.0 * sr), 0.0, 1.0);
      let slat_p = fract(sv * 10.0 - t * 0.35);
      let cut = mix(0.06, 0.52, pow(clamp((sv - 0.38) / 0.62, 0.0, 1.0), 1.3));
      if (sv < 0.44 || slat_p > cut) {
        let qv = floor(clamp(sv + (dval - 0.5) * 0.14 * dither, 0.0, 1.0) * 5.0) / 5.0;
        col = mix(vec3f(1.0, 0.95, 0.58), mix(c_peach, c_pink, qv), qv) * (1.1 + bass * 0.65 + onset * 0.4) * glow;
      }
    }
  } else if (puv.y < shore) {
    // --- SHIMMERING PIXEL OCEAN ---
    let wy = clamp((puv.y - hor) / max(0.01, shore - hor), 0.0, 1.0);
    let z = 0.14 / max(0.012, wy);
    let spec = sample_band(clamp(abs(puv.x - 0.5) * 1.8, 0.0, 1.0));

    // Horizontal scan-shifted pixel waves
    let ripple = sin(z * 3.8 - t * 3.2 * wave_amp + sin(puv.x * 14.0 + t) * 1.5);
    let scan_shift = ripple * 0.028 * (0.4 + wy) * wave_amp;

    // Deep teal/purple water with dithered depth bands
    let q_wy = floor(clamp(wy + (dval - 0.5) * dither * 0.22, 0.0, 1.0) * 5.0) / 5.0;
    let water = mix(c_purp * 0.55, c_cyan * 0.42, q_wy * 0.75 + 0.15);
    col = water * (0.72 + energy * 0.45);

    // Sun reflection pillar broken into dancing pixel bars
    let refl_w = 0.17 + wy * 0.14 + bass * 0.06;
    let dx = abs(puv.x - 0.5 + scan_shift);
    let refl = smoothstep(refl_w, 0.0, dx) * (0.55 + 0.45 * step(-0.1, ripple));
    let r_dith = step(dval, refl * (0.85 + bass * 0.4));
    col = mix(col, mix(c_peach, c_pink, wy * 0.7) * (1.15 + bass * 0.7 + onset * 0.5) * glow, r_dith * 0.85);

    // Spectrum-driven turquoise wave crests & foam lines
    let crest = step(0.76 - spec * 0.34 - bass * 0.14, ripple * 0.5 + 0.5);
    col += mix(c_cyan, c_mint, 0.5) * crest * (0.35 + spec * 0.95 + onset * 0.6) * glow * (0.4 + 0.6 * wy);

    // Horizon sheen
    col += mix(c_pink, c_cyan, 0.4) * exp(-wy * 22.0) * (0.85 + bass * 0.9 + onset * 0.7);
  } else {
    // --- VAPORWAVE CHECKERBOARD PROMENADE / WET SHORE ---
    let py = clamp((puv.y - shore) / max(0.01, 1.0 - shore), 0.0, 1.0);
    let pz = 0.24 / (py + 0.16);
    let px = (puv.x - 0.5) * asp * pz;
    let chk = ((i32(floor(px * 2.2)) + i32(floor(pz * 2.2 + t * 1.2))) & 1);
    let tile_a = mix(c_night * 0.5, c_purp * 0.65, 1.0 - py * 0.5);
    let tile_b = mix(c_cyan * 0.45, c_pink * 0.55, 0.5 + 0.5 * sin(t + px));
    col = select(tile_a, tile_b, chk == 0) * (0.75 + bass * 0.55 + onset * 0.45);
    // Shoreline neon foam edge
    let foam = exp(-py * 24.0);
    col += mix(c_mint, vec3f(1.0), 0.4) * foam * (1.0 + bass * 0.9 + onset * 0.8) * glow;
  }

  // --- LEAPING SPRITE DOLPHINS (pixel-perfect from agy-dolphin.spr) ---
  let n_dolphins = clamp(i32(round(u.params.x)), 1, 6);
  let frames = max(1, i32(u.extra.w));
  let spr_sz = vec2f(u.extra.y, u.extra.z);
  let jump_h = u.params.y;

  for (var i = 0; i < 6; i = i + 1) {
    if (i >= n_dolphins) { break; }
    let fi = f32(i);
    // Each dolphin leaps on a staggered 2-beat cycle
    let cycle = fract(beats * 0.5 + fi / f32(n_dolphins));
    // Active leap window 0.05..0.92
    let u_arc = clamp((cycle - 0.05) / 0.87, 0.0, 1.0);
    let active = step(0.05, cycle) * step(cycle, 0.92);
    let dir = select(-1.0, 1.0, (i & 1) == 0);

    // Parabolic jump trajectory across the ocean
    let start_x = 0.5 + dir * (-0.34 + 0.16 * fract(fi * 0.618));
    let span_x = dir * (0.34 + 0.08 * fract(fi * 0.37));
    let water_y = hor + 0.14 + 0.14 * fract(fi * 0.43);
    let arc_y = 4.0 * u_arc * (1.0 - u_arc); // 0 -> 1 -> 0
    let peak = (0.17 + 0.09 * bass + 0.07 * onset) * jump_h;

    let d_pos = vec2f(start_x + span_x * u_arc, water_y - arc_y * peak);
    let d_scale = (1.65 + 0.35 * fract(fi * 0.73)) * (0.85 + 0.15 * (water_y - hor) * 3.0);

    // Pixel splash droplets at leap takeoff & splashdown
    let splash_t = min(abs(cycle - 0.07), abs(cycle - 0.90));
    if (splash_t < 0.12) {
      let sp_age = splash_t / 0.12;
      let sp_x = select(start_x + span_x, start_x, cycle < 0.5);
      let dp = (puv - vec2f(sp_x, water_y)) * vec2f(asp, 1.0);
      let r_sp = length(dp);
      let ang = atan2(dp.y, dp.x);
      let ring = abs(r_sp - (0.015 + sp_age * 0.055));
      if (dp.y < 0.01 && ring < 0.012 && sin(ang * 9.0 + fi * 4.0) > 0.0) {
        col = mix(c_cyan, vec3f(1.0), 0.65) * (1.1 - sp_age * 0.6) * (1.0 + onset * 0.8) * glow;
      }
    }

    if (active > 0.5) {
      // Map screen pixel grid directly onto integer sprite pixels (crisp nearest-neighbor)
      let spr_pix_pos = (pix - d_pos * grid) / d_scale + spr_sz * 0.5;
      var sp = vec2i(floor(spr_pix_pos));
      if (dir < 0.0) {
        sp.x = i32(spr_sz.x) - 1 - sp.x;
      }
      // Frame follows leap arc: 0 = rising, 1 = cresting, 2 = diving, 3 = gliding
      var frame = 0;
      if (u_arc < 0.30) { frame = 0; }
      else if (u_arc < 0.55) { frame = 1; }
      else if (u_arc < 0.80) { frame = 2; }
      else { frame = 3; }
      frame = frame % frames;

      // Clip below the dolphin's water line so it emerges & submerges cleanly
      if (puv.y <= water_y + 0.015) {
        let tc = spr_texel(sp, frame);
        if (tc.a > 0.5) {
          let lin = pow(tc.rgb, vec3f(2.2));
          let luma = dot(lin, vec3f(0.2126, 0.7152, 0.0722));
          let tinted = mix(lin, pal_at(clamp(0.45 + luma * 0.5, 0.0, 0.99)) * (0.6 + luma * 0.8), 0.32 + onset * 0.25);
          col = tinted * (1.15 + bass * 0.45 + onset * 0.4) * glow;
        } else {
          // Crisp 1-pixel vaporwave dark outline around sprite
          let nb = max(
            max(spr_texel(sp + vec2i(1, 0), frame).a, spr_texel(sp - vec2i(1, 0), frame).a),
            max(spr_texel(sp + vec2i(0, 1), frame).a, spr_texel(sp - vec2i(0, 1), frame).a)
          );
          if (nb > 0.5) {
            col = c_night * 0.25;
          }
        }
      }
    }
  }

  // --- FRAMING PIXEL PALM TREES ON LEFT & RIGHT ---
  let sway_l = sin(t * 2.1 + ph * 6.2831) * (0.07 + bass * 0.12);
  let sway_r = sin(t * 2.1 + 1.8 + ph * 6.2831) * (0.07 + bass * 0.12);
  let lp_l = vec2f(((puv.x - 0.07) * asp) / 0.58, (0.96 - puv.y) / 0.58);
  let lp_r = vec2f(((0.93 - puv.x) * asp) / 0.58, (0.96 - puv.y) / 0.58);
  if (palm_silhouette(lp_l, sway_l) > 0.5) {
    let rim = select(0.0, 1.0, palm_silhouette(lp_l - vec2f(0.03, -0.02), sway_l) < 0.5);
    col = mix(c_night * 0.28, c_pink * (1.0 + bass * 0.8 + onset * 0.6), rim * 0.7);
  }
  if (palm_silhouette(lp_r, sway_r) > 0.5) {
    let rim = select(0.0, 1.0, palm_silhouette(lp_r - vec2f(0.03, -0.02), sway_r) < 0.5);
    col = mix(c_night * 0.28, c_cyan * (1.0 + bass * 0.8 + onset * 0.6), rim * 0.7);
  }

  return vec4f(max(col, vec3f(0.0)), 1.0);
}
