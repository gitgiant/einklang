// Low-res Bayer-dithered pixel-art classical Greek marble bust
// in front of a vaporwave checkerboard temple and slatted halo.

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

fn smin(a: f32, b: f32, k: f32) -> f32 {
  let h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0);
  return mix(b, a, h) - k * h * (1.0 - h);
}

fn rot2(p: vec2f, a: f32) -> vec2f {
  let c = cos(a);
  let s = sin(a);
  return vec2f(c * p.x - s * p.y, s * p.x + c * p.y);
}

fn sd_ellipsoid(p: vec3f, r: vec3f) -> f32 {
  let k0 = length(p / r);
  let k1 = length(p / (r * r));
  return k0 * (k0 - 1.0) / max(k1, 0.0001);
}

fn sd_capsule(p: vec3f, a: vec3f, b: vec3f, r: f32) -> f32 {
  let pa = p - a;
  let ba = b - a;
  let h = clamp(dot(pa, ba) / max(dot(ba, ba), 0.0001), 0.0, 1.0);
  return length(pa - ba * h) - r;
}

// Sculpted classical Greek bust + fluted pedestal
fn map_bust(p: vec3f) -> vec2f {
  // Returns vec2f(distance, material_id: 0 = marble bust, 1 = fluted pedestal)
  // Cranium + jaw
  let head = sd_ellipsoid(p - vec3f(0.0, 0.36, 0.0), vec3f(0.24, 0.31, 0.27));
  let jaw  = sd_ellipsoid(p - vec3f(0.0, 0.19, 0.06), vec3f(0.16, 0.16, 0.21));
  var d = smin(head, jaw, 0.09);

  // Classical straight nose bridge
  let nose = sd_capsule(p, vec3f(0.0, 0.39, 0.24), vec3f(0.0, 0.26, 0.295), 0.032);
  d = smin(d, nose, 0.03);

  // Brow ridge & carved eye sockets
  let brow = sd_capsule(p, vec3f(-0.11, 0.42, 0.23), vec3f(0.11, 0.42, 0.23), 0.036);
  d = smin(d, brow, 0.03);
  let eye_l = length(p - vec3f(-0.085, 0.35, 0.245)) - 0.045;
  let eye_r = length(p - vec3f( 0.085, 0.35, 0.245)) - 0.045;
  d = max(d, -min(eye_l, eye_r));

  // Lips
  let lips = sd_capsule(p, vec3f(-0.055, 0.195, 0.245), vec3f(0.055, 0.195, 0.245), 0.026);
  d = smin(d, lips, 0.02);

  // Sculpted classical curly hair crown (radial wavy curls around upper/back head)
  let hp = p - vec3f(0.0, 0.45, -0.04);
  let ang = atan2(hp.z, hp.x);
  let curls = 0.032 * sin(ang * 9.0 + hp.y * 14.0) + 0.018 * cos(hp.x * 24.0 - hp.y * 18.0);
  let hair_cap = sd_ellipsoid(hp, vec3f(0.285, 0.27, 0.295)) + curls;
  // Carve forehead opening out of the hair cap
  let face_cut = length(p - vec3f(0.0, 0.31, 0.24)) - 0.22;
  let hair = max(hair_cap, -face_cut);
  d = smin(d, hair, 0.035);

  // Neck + draped classical shoulders / chest
  let neck = sd_capsule(p, vec3f(0.0, 0.15, -0.02), vec3f(0.0, -0.08, -0.02), 0.115);
  let chest = sd_ellipsoid(p - vec3f(0.0, -0.26, -0.02), vec3f(0.46, 0.27, 0.23));
  // Cut bottom of bust cleanly like a museum sculpture
  let bust_cut = -(p.y + 0.44);
  let torso = max(smin(neck, chest, 0.08), bust_cut);
  d = smin(d, torso, 0.04);

  // Fluted Doric pedestal below the bust
  let pp = p - vec3f(0.0, -0.78, -0.02);
  let p_ang = atan2(pp.z, pp.x);
  let flutes = 0.014 * sin(p_ang * 14.0);
  let col_r = 0.21 + 0.035 * smoothstep(0.22, 0.34, abs(pp.y)) + flutes;
  let ped_cyl = max(length(pp.xz) - col_r, abs(pp.y) - 0.36);
  let cap_box = max(max(abs(pp.x) - 0.28, abs(pp.z) - 0.28), abs(pp.y - 0.34) - 0.045);
  let ped = min(ped_cyl, cap_box);

  if (ped < d) { return vec2f(ped, 1.0); }
  return vec2f(d, 0.0);
}

fn calc_normal(p: vec3f) -> vec3f {
  let e = 0.004;
  let d = map_bust(p).x;
  return normalize(vec3f(
    map_bust(p + vec3f(e, 0.0, 0.0)).x - d,
    map_bust(p + vec3f(0.0, e, 0.0)).x - d,
    map_bust(p + vec3f(0.0, 0.0, e)).x - d
  ));
}

fn shade(uv: vec2f) -> vec4f {
  let cells = max(64.0, floor(p_cells()));
  let asp = aspect();
  let grid = vec2f(floor(cells * asp), cells);
  let pix = floor(uv * grid);
  let puv = (pix + 0.5) / grid;
  let dval = bayer4(vec2i(pix));

  let t = time();
  let b = bass();
  let on = onset();
  let r = rms();
  let ph = phase();
  let hi = (band(11) + band(12) + band(13) + band(14)) * 0.25;
  let energy = clamp(b * 0.65 + on * 0.55 + r * 0.35, 0.0, 1.6);
  let dither = p_dither();
  let holo = p_holo();
  let glow = p_glow();

  let c_night = palette(0.03) * 0.3;
  let c_purp  = palette(0.22);
  let c_pink  = palette(0.46);
  let c_peach = palette(0.66);
  let c_cyan  = palette(0.84);
  let c_mint  = palette(0.98);

  // Horizontal holographic glitch tear on strong onsets
  var spuv = puv;
  let glitch_row = fract(sin(floor(puv.y * 28.0) * 91.7 + floor(t * 16.0)) * 43758.5);
  if (on > 0.3 && glitch_row > 0.74) {
    spuv.x += (glitch_row - 0.87) * 0.16 * on * holo;
  }

  // --- VAPORWAVE TEMPLE BACKDROP ---
  let hor = 0.64;
  var col = vec3f(0.0);
  if (spuv.y < hor) {
    let sy = clamp(spuv.y / hor, 0.0, 1.0);
    let q = floor(clamp(sy + (dval - 0.5) * dither / 6.0, 0.0, 1.0) * 6.0) / 6.0;
    col = mix(mix(c_night, c_purp, q), mix(c_pink, c_cyan * 0.6, q), smoothstep(0.35, 1.0, q)) * (0.7 + energy * 0.45);

    // Neon slatted halo ring behind the bust
    let hc = vec2f(0.5, 0.40);
    let hd = vec2f((spuv.x - hc.x) * asp, spuv.y - hc.y);
    let hr = length(hd);
    let ring_r = 0.29 + b * 0.05 + on * 0.03;
    let halo_fill = step(hr, ring_r);
    let slat = step(0.32, fract(spuv.y * 26.0 - t * 0.6));
    if (halo_fill > 0.5 && slat > 0.5) {
      let qh = floor(clamp(spuv.y * 1.6 + (dval - 0.5) * 0.18, 0.0, 1.0) * 4.0) / 4.0;
      col = mix(c_peach, c_pink, qh) * (0.85 + b * 0.55 + on * 0.45) * glow;
    }
    let ring_edge = exp(-abs(hr - (ring_r + 0.055)) * 45.0);
    col += c_cyan * ring_edge * (1.0 + b * 1.1 + on * 0.9) * glow;

    // Spectrum equalizer bars framing the left & right temple columns
    let side_x = abs(spuv.x - 0.5) * 2.0;
    if (side_x > 0.55) {
      let bi = clamp(i32((side_x - 0.55) / 0.45 * 15.0), 0, 15);
      let bh = band(bi) * 0.48 + 0.04;
      if (hor - spuv.y < bh) {
        let bar_d = step(0.25, fract(spuv.y * 42.0));
        col += mix(c_cyan, c_pink, f32(bi) / 15.0) * bar_d * (0.65 + b * 0.6) * glow;
      }
    }
  } else {
    // Classic vaporwave checkerboard floor
    let fy = max(0.008, spuv.y - hor);
    let z = 0.22 / fy;
    let fx = (spuv.x - 0.5) * asp * z;
    let chk = ((i32(floor(fx * 1.35)) + i32(floor(z * 1.35 + t * 1.6))) & 1);
    let fog = exp(-z * 0.12);
    let ca = mix(c_night * 0.35, c_purp * 0.55, fog);
    let cb = mix(c_cyan * 0.7, c_pink * 0.85, 0.5 + 0.5 * sin(z * 0.4 - t * 2.2));
    col = select(ca, cb, chk == 0) * (0.65 + energy * 0.55);
    col += mix(c_pink, c_cyan, 0.5) * exp(-fy * 26.0) * (0.9 + b * 0.9 + on * 0.8) * glow;
  }

  // --- RAYMARCH THE PIXEL GREEK MARBLE BUST ---
  let ndc = vec2f((spuv.x - 0.5) * asp, 0.5 - spuv.y) * 2.0;
  let ro = vec3f(0.0, -0.02, 2.35 - b * 0.12);
  let rd = normalize(vec3f(ndc * 0.62, -1.65));

  // Bust gently turns and nods on beats
  let yaw = sin(t * 0.9 * p_spin()) * 0.55 + (on - 0.2) * 0.12;
  let pitch = -0.06 + sin(ph * 6.2831) * 0.045 * (0.4 + b);

  var dist_t = 0.0;
  var hit = false;
  var mat = 0.0;
  var hit_p = vec3f(0.0);

  for (var i = 0; i < 40; i = i + 1) {
    let wp = ro + rd * dist_t;
    var bp = wp;
    bp.y -= 0.02 * sin(t * 2.0) + b * 0.04;
    let rp_xz = rot2(bp.xz, yaw);
    bp.x = rp_xz.x;
    bp.z = rp_xz.y;
    let rp_yz = rot2(bp.yz, pitch);
    bp.y = rp_yz.x;
    bp.z = rp_yz.y;

    let res = map_bust(bp);
    if (res.x < 0.004) {
      hit = true;
      mat = res.y;
      hit_p = bp;
      break;
    }
    dist_t += res.x;
    if (dist_t > 4.2) { break; }
  }

  if (hit) {
    let n = calc_normal(hit_p);
    // Two-tone vaporwave lighting: pink key light from left, cyan rim light from right
    let l1 = normalize(vec3f(-0.7, 0.65, 0.65));
    let l2 = normalize(vec3f(0.85, 0.25, 0.35));
    let diff1 = max(0.0, dot(n, l1));
    let diff2 = max(0.0, dot(n, l2));
    let fres = pow(1.0 - max(0.0, dot(n, normalize(vec3f(0.0, 0.0, 1.0)))), 2.5);

    // Subtle marble veining
    let vein = 0.5 + 0.5 * sin(hit_p.x * 16.0 + hit_p.y * 11.0 + sin(hit_p.z * 9.0) * 2.0);
    let shade_l = clamp(0.18 + diff1 * 0.68 + diff2 * 0.32 - vein * 0.08, 0.0, 1.0);

    // Quantize marble shading with 4x4 ordered Bayer dithering
    let levels = 5.0;
    let q_shade = floor(clamp(shade_l + (dval - 0.5) * dither / levels, 0.0, 1.0) * levels) / levels;

    // Classical alabaster marble tinted with vaporwave shadows & neon highlights
    let shadow_c = mix(c_purp * 0.55, c_night * 0.65, mat * 0.4);
    let mid_c = mix(vec3f(0.86, 0.80, 0.94), c_pink * 0.85, 0.22 + b * 0.18);
    let hi_c = mix(vec3f(1.0, 0.96, 1.0), c_mint, 0.22 + hi * 0.25);

    var mcol = mix(shadow_c, mid_c, smoothstep(0.0, 0.55, q_shade));
    mcol = mix(mcol, hi_c, smoothstep(0.55, 1.0, q_shade));

    // Dual neon rim lighting (magenta left, cyan right)
    let rim_col = mix(c_pink, c_cyan, step(0.0, n.x));
    mcol += rim_col * fres * (0.75 + b * 0.95 + on * 0.9) * holo;

    // Holographic scanline sweep on beats & onsets
    let scan = exp(-abs(fract(hit_p.y * 1.4 - t * 0.9) - 0.5) * 18.0);
    mcol += mix(c_cyan, c_pink, 0.5) * scan * (0.25 + on * 1.2 + b * 0.55) * holo;

    col = mcol * (0.95 + energy * 0.35) * glow;
  }

  return vec4f(max(col, vec3f(0.0)), 1.0);
}
