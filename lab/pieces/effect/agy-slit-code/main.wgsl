// Slit-scan code buffer: live sweeping capture slit punches crisp media through,
// while trailing temporal feedback history smears and quantizes into live code glyphs.

fn hash_u32(x: u32) -> u32 {
  var v = x * 747796405u + 2891336453u;
  v = ((v >> ((v >> 28u) + 4u)) ^ v) * 277803737u;
  return (v >> 22u) ^ v;
}

fn hash2(a: u32, b: u32) -> f32 {
  return f32(hash_u32(a ^ hash_u32(b * 374761393u + 668265263u)) & 0xFFFFu) / 65536.0;
}

fn pack6(r0: u32, r1: u32, r2: u32, r3: u32, r4: u32, r5: u32) -> u32 {
  return r0 | (r1 << 5u) | (r2 << 10u) | (r3 << 15u) | (r4 << 20u) | (r5 << 25u);
}

// 12 code/telemetry glyphs ordered by visual density
fn code_bits(idx: u32) -> u32 {
  switch (idx % 12u) {
    case 0u:  { return pack6(0x00u, 0x00u, 0x04u, 0x00u, 0x00u, 0x00u); } // .
    case 1u:  { return pack6(0x00u, 0x04u, 0x00u, 0x04u, 0x00u, 0x00u); } // :
    case 2u:  { return pack6(0x04u, 0x04u, 0x04u, 0x04u, 0x04u, 0x0Eu); } // 1
    case 3u:  { return pack6(0x00u, 0x0Eu, 0x00u, 0x0Eu, 0x00u, 0x00u); } // =
    case 4u:  { return pack6(0x1Fu, 0x10u, 0x08u, 0x04u, 0x02u, 0x02u); } // 7 / フ
    case 5u:  { return pack6(0x02u, 0x04u, 0x1Fu, 0x04u, 0x08u, 0x10u); } // ナ
    case 6u:  { return pack6(0x0Eu, 0x11u, 0x15u, 0x15u, 0x11u, 0x0Eu); } // 0
    case 7u:  { return pack6(0x1Fu, 0x01u, 0x0Fu, 0x01u, 0x01u, 0x1Fu); } // コ
    case 8u:  { return pack6(0x0Au, 0x1Fu, 0x0Au, 0x0Au, 0x1Fu, 0x0Au); } // #
    case 9u:  { return pack6(0x1Fu, 0x08u, 0x1Fu, 0x08u, 0x08u, 0x04u); } // キ
    case 10u: { return pack6(0x04u, 0x1Fu, 0x15u, 0x15u, 0x1Fu, 0x04u); } // 中
    default:  { return pack6(0x15u, 0x0Eu, 0x1Fu, 0x0Eu, 0x15u, 0x0Eu); } // star
  }
}

fn sample_code(idx: u32, local: vec2f) -> f32 {
  let gx = i32(floor(local.x * 6.0));
  let gy = i32(floor(local.y * 8.0)) - 1;
  if (gx < 0 || gx >= 5 || gy < 0 || gy >= 6) {
    return 0.0;
  }
  let bits = code_bits(idx);
  let shift = u32(gy * 5 + gx);
  return f32((bits >> shift) & 1u);
}

fn rgb_luma(c: vec3f) -> f32 {
  let p = max(c, vec3f(0.0));
  let tm = p / (vec3f(0.55) + p);
  return clamp(dot(tm, vec3f(0.2126, 0.7152, 0.0722)), 0.0, 1.0);
}

fn shade(uv: vec2f) -> vec4f {
  let res = resolution();
  let scale = res.y / 1080.0;
  let asp = aspect();
  let t = time();
  let b = bass();
  let on = onset();
  let r = rms();
  let ph = phase();
  let beat_kick = pow(max(0.0, 1.0 - ph * 2.8), 2.1) * (0.35 + 0.65 * b);
  let energy = clamp(on * 1.15 + beat_kick * 0.85 + r * 0.45, 0.0, 1.6);

  let axis = i32(round(p_axis()));

  // Edge field and luma (use optional core-media ports if wired, else compute from tex_in)
  let luma_port = clamp(tex_luma(uv).x, 0.0, 1.0);
  let raw_in = tex_in(uv).rgb;
  let luma_in = rgb_luma(raw_in);
  let luma_v = select(luma_port, luma_in, luma_port < 0.0005 && luma_in > 0.001);

  let e_port = tex_edges(uv).xy;
  let step_uv = vec2f(2.0) / res;
  let lx = rgb_luma(tex_in(clamp(uv + vec2f(step_uv.x, 0.0), vec2f(0.001), vec2f(0.999))).rgb)
         - rgb_luma(tex_in(clamp(uv - vec2f(step_uv.x, 0.0), vec2f(0.001), vec2f(0.999))).rgb);
  let ly = rgb_luma(tex_in(clamp(uv + vec2f(0.0, step_uv.y), vec2f(0.001), vec2f(0.999))).rgb)
         - rgb_luma(tex_in(clamp(uv - vec2f(0.0, step_uv.y), vec2f(0.001), vec2f(0.999))).rgb);
  let edge_v = select(e_port, vec2f(lx, ly) * 2.3, dot(e_port, e_port) < 0.0001);
  let edge_mag = clamp(length(edge_v), 0.0, 2.0);

  // Onset tear strips & macroblock jumps
  let step_t = u32(floor(t * 14.0 + on * 9.0 + bar() * 2.0));
  let strip_coord = select(uv.y, uv.x, axis == 1);
  let strip_id = u32(max(0.0, floor(strip_coord * 24.0)));
  let strip_rnd = hash2(strip_id, step_t);
  let tear_prob = clamp(p_tear() * (0.09 + 0.42 * energy), 0.0, 0.68);
  let strip_on = step(1.0 - tear_prob, strip_rnd);
  let tear_shift = (hash2(strip_id + 37u, step_t) - 0.5) * 0.12 * p_tear() * (0.3 + energy) * strip_on;

  let blk = vec2u(floor(uv * vec2f(14.0 * asp, 14.0)));
  let blk_r = hash2(blk.x * 97u + blk.y * 31u, step_t);
  let blk_on = step(1.0 - clamp(p_tear() * 0.32 * energy, 0.0, 0.5), blk_r);
  let blk_off = (vec2f(blk_r, hash2(blk.x * 53u + blk.y * 19u, step_t + 7u)) - 0.5) * 0.08 * p_tear() * (0.35 + energy) * blk_on;

  // Rolling slit center synced to tempo & beats
  let slit_center = fract(t * 0.13 * (0.55 + p_drift()) + floor(bar()) * 0.125 + beat_kick * 0.055);
  let slit_w = p_slit() * (0.72 + 0.65 * b + 0.48 * on);

  // Feedback history advection
  let adv_step = (0.003 + 0.01 * p_drift()) * (0.62 + 0.85 * b + 0.72 * on);
  let edge_push = edge_v * 0.011 * p_edge_warp() * (0.35 + 0.9 * energy);

  var hist_uv = uv;
  var slit_dist = 0.0;
  var slit_dir = vec2f(1.0, 0.0);

  if (axis == 0) {
    let d_raw = uv.x - slit_center;
    let d_wrap = d_raw - round(d_raw);
    slit_dist = abs(d_wrap);
    let side = select(-1.0, 1.0, d_wrap >= 0.0);
    hist_uv = uv - vec2f(side * adv_step, 0.0) + edge_push + vec2f(tear_shift * 0.3, 0.0);
    slit_dir = vec2f(1.0, 0.0);
  } else if (axis == 1) {
    let d_raw = uv.y - slit_center;
    let d_wrap = d_raw - round(d_raw);
    slit_dist = abs(d_wrap);
    let side = select(-1.0, 1.0, d_wrap >= 0.0);
    hist_uv = uv - vec2f(0.0, side * adv_step) + edge_push + vec2f(0.0, tear_shift * 0.3);
    slit_dir = vec2f(0.0, 1.0);
  } else {
    let d_c = uv - vec2f(0.5, 0.5);
    let rad = length(d_c * vec2f(asp, 1.0));
    let ring_pos = fract(slit_center) * 0.62;
    slit_dist = abs(rad - ring_pos);
    let dir = normalize(d_c + vec2f(1e-5, 0.0));
    hist_uv = uv - dir * adv_step * 1.15 + edge_push;
    slit_dir = dir;
  }

  let in_slit = 1.0 - smoothstep(slit_w * 0.35, slit_w, slit_dist);
  let slit_rim = exp(-pow(slit_dist / max(slit_w * 0.4, 0.01), 2.0)) * (0.3 + 0.8 * energy);

  // Live media sample with RGB split and onset tears
  let live_uv = clamp(uv + vec2f(tear_shift, 0.0) + blk_off + edge_push * 0.5, vec2f(0.001), vec2f(0.999));
  let rgb_amt = (0.0025 + 0.016 * p_rgb() * (0.35 + energy + edge_mag * 0.4 + strip_on * 0.6));
  let rgb_vec = slit_dir * rgb_amt + vec2f(0.0, rgb_amt * 0.25 * (strip_rnd - 0.5));
  let live_r = tex_in(clamp(live_uv + rgb_vec, vec2f(0.001), vec2f(0.999))).r;
  let live_g = tex_in(live_uv).g;
  let live_b = tex_in(clamp(live_uv - rgb_vec, vec2f(0.001), vec2f(0.999))).b;
  let live_col = max(vec3f(live_r, live_g, live_b), vec3f(0.0));

  // Previous slit-scan buffer sample (clamped so feedback never runs away)
  let h_uv_c = clamp(hist_uv, vec2f(0.001), vec2f(0.999));
  let prev_r = prev(clamp(h_uv_c + slit_dir * (rgb_amt * 0.2), vec2f(0.001), vec2f(0.999))).r;
  let prev_g = prev(h_uv_c).g;
  let prev_b = prev(clamp(h_uv_c - slit_dir * (rgb_amt * 0.2), vec2f(0.001), vec2f(0.999))).b;
  let hist_raw = clamp(vec3f(prev_r, prev_g, prev_b), vec3f(0.0), vec3f(2.4)) * p_decay();

  // Quantize trailing history into live-mutating terminal code glyphs
  let cell_h = max(5.0, p_cell() * (1.0 + 0.12 * b) * scale);
  let cell_w = max(4.0, cell_h * 0.65);
  let cell_sz = vec2f(cell_w, cell_h);
  let cell_f = floor((uv * res) / cell_sz);
  let local = fract((uv * res) / cell_sz);
  let cell_uv = clamp((cell_f + 0.5) * cell_sz / res, vec2f(0.001), vec2f(0.999));

  let cell_hist_uv = clamp(cell_uv + (hist_uv - uv), vec2f(0.001), vec2f(0.999));
  let cell_hist = clamp(prev(cell_hist_uv).rgb, vec3f(0.0), vec3f(2.4)) * p_decay();
  let cell_luma = rgb_luma(cell_hist);
  let col_i = u32(max(0.0, cell_f.x));
  let row_i = u32(max(0.0, cell_f.y));
  let b_col = band(i32(col_i % 16u));

  let cell_seed = row_i * 59u + col_i * 173u;
  let mut_step = u32(floor(t * (2.5 + 7.0 * energy + 5.0 * p_tear()) * (0.4 + hash2(cell_seed, 13u))));
  let g_tier = u32(clamp(floor((cell_luma * 0.85 + b_col * 0.25) * 9.0), 0.0, 9.0));
  let g_idx = g_tier + (hash_u32(cell_seed ^ (mut_step * 2654435761u)) % 3u);
  let g_px = sample_code(g_idx, local);

  let pal_code = palette(clamp(0.22 + cell_luma * 0.65 + strip_rnd * 0.15, 0.0, 1.0));
  let code_ink = mix(pal_code, cell_hist * 1.35 + pal_code * 0.25, 0.52);
  let hist_glyph = cell_hist * 0.26 + code_ink * g_px * (0.42 + 0.95 * cell_luma + 0.35 * energy);
  let hist_col = mix(hist_raw, hist_glyph, p_glyph_mix() * (1.0 - in_slit * 0.65));

  // Refresh history inside the moving slit and bright subject core
  let subject_gate = smoothstep(0.32, 0.88, luma_v) * 0.26 * (0.65 + 0.55 * b);
  let refresh = clamp(max(in_slit, max(subject_gate, blk_on * 0.6)), 0.0, 1.0);
  var col = mix(hist_col, live_col, refresh);

  // Phosphor cursor glow on the slit rim + contour accent + glitch flash
  let pal_acc = palette(fract(luma_v * 0.65 + t * 0.09 + strip_rnd * 0.22));
  col += pal_acc * (slit_rim * 0.42 + edge_mag * 0.26 * (0.35 + energy) + strip_on * 0.2 * energy);

  // Subtle CRT scanlines
  let scan = 0.93 + 0.07 * sin(uv.y * res.y * 1.5707963);
  col *= scan;

  return vec4f(clamp(col, vec3f(0.0), vec3f(3.0)), 1.0);
}
