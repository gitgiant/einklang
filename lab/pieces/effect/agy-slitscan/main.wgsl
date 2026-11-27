fn hash21(p: vec2f) -> f32 {
  var q = fract(p * vec2f(127.1, 311.7));
  q += dot(q, q + 34.53);
  return fract(q.x * q.y);
}

fn shade(uv: vec2f) -> vec4f {
  let t = time();
  let b = bass();
  let on = onset();
  let r = rms();
  let ph = phase();
  let beat_kick = pow(max(0.0, 1.0 - ph * 2.8), 2.2) * (0.35 + 0.65 * b);
  let energy = clamp(on * 1.1 + beat_kick + r * 0.45, 0.0, 1.6);

  let axis = i32(round(p_axis()));
  let edge_v = tex_edges(uv).xy;
  let edge_mag = clamp(length(edge_v), 0.0, 2.0);
  let luma_v = clamp(tex_luma(uv).x, 0.0, 1.0);

  // Quantized glitch blocks & horizontal/vertical tear strips on beats/onsets
  let step_t = floor(t * 12.0 + on * 8.0 + bar() * 2.0);
  let strip_coord = select(uv.y, uv.x, axis == 1);
  let strip_id = floor(strip_coord * 26.0);
  let strip_rnd = hash21(vec2f(strip_id, step_t));
  let tear_prob = clamp(p_tear() * (0.12 + 0.45 * energy), 0.0, 0.72);
  let strip_on = step(1.0 - tear_prob, strip_rnd);
  let tear_shift = (hash21(vec2f(strip_id + 19.0, step_t * 1.3)) - 0.5) * 0.14 * p_tear() * (0.35 + energy) * strip_on;

  // Macroblock glitch offset
  let blk = floor(uv * vec2f(16.0 * aspect(), 16.0));
  let blk_r = hash21(blk + vec2f(step_t * 0.71, step_t * 1.13));
  let blk_on = step(1.0 - clamp(p_tear() * 0.35 * energy, 0.0, 0.55), blk_r);
  let blk_off = (vec2f(blk_r, hash21(blk + 41.3)) - 0.5) * 0.09 * p_tear() * (0.4 + energy) * blk_on;

  // Slit position glides smoothly with time and snaps on beats
  let slit_center = fract(t * 0.14 * (0.6 + p_drift()) + floor(bar()) * 0.125 + beat_kick * 0.06);
  let slit_w = p_slit() * (0.75 + 0.65 * b + 0.45 * on);

  // Compute history advection UV and slit capture mask by axis
  let adv_step = (0.0035 + 0.011 * p_drift()) * (0.65 + 0.85 * b + 0.7 * on);
  let edge_push = edge_v * 0.012 * p_edge_warp() * (0.4 + 0.9 * energy);

  var hist_uv = uv;
  var slit_dist = 0.0;
  var slit_dir = vec2f(1.0, 0.0);

  if (axis == 0) {
    // Horizontal rolling slit-scan: ribbons stream left/right from the slit
    let d_raw = uv.x - slit_center;
    let d_wrap = d_raw - round(d_raw);
    slit_dist = abs(d_wrap);
    let side = select(-1.0, 1.0, d_wrap >= 0.0);
    hist_uv = uv - vec2f(side * adv_step, 0.0) + edge_push + vec2f(tear_shift * 0.35, 0.0);
    slit_dir = vec2f(1.0, 0.0);
  } else if (axis == 1) {
    // Vertical waterfall slit-scan: ribbons cascade up/down
    let d_raw = uv.y - slit_center;
    let d_wrap = d_raw - round(d_raw);
    slit_dist = abs(d_wrap);
    let side = select(-1.0, 1.0, d_wrap >= 0.0);
    hist_uv = uv - vec2f(0.0, side * adv_step) + edge_push + vec2f(0.0, tear_shift * 0.35);
    slit_dir = vec2f(0.0, 1.0);
  } else {
    // Radial slit-scan: concentric time rings expand from center
    let d_c = uv - vec2f(0.5, 0.5);
    let rad = length(d_c * vec2f(aspect(), 1.0));
    let ring_pos = fract(slit_center) * 0.65;
    slit_dist = abs(rad - ring_pos);
    let dir = normalize(d_c + vec2f(1e-5, 0.0));
    hist_uv = uv - dir * adv_step * 1.15 + edge_push;
    slit_dir = dir;
  }

  let in_slit = 1.0 - smoothstep(slit_w * 0.35, slit_w, slit_dist);
  let slit_rim = exp(-pow(slit_dist / max(slit_w * 0.45, 0.01), 2.0)) * (0.25 + 0.75 * energy);

  // Sample live media with RGB split and tear/block distortion
  let live_uv = clamp(uv + vec2f(tear_shift, 0.0) + blk_off + edge_push * 0.6, vec2f(0.0), vec2f(1.0));
  let rgb_amt = (0.003 + 0.018 * p_rgb() * (0.35 + energy + edge_mag * 0.45 + strip_on * 0.6));
  let rgb_vec = slit_dir * rgb_amt + vec2f(0.0, rgb_amt * 0.25 * (strip_rnd - 0.5));
  let live_r = tex_in(clamp(live_uv + rgb_vec, vec2f(0.0), vec2f(1.0))).r;
  let live_g = tex_in(live_uv).g;
  let live_b = tex_in(clamp(live_uv - rgb_vec, vec2f(0.0), vec2f(1.0))).b;
  let live_col = vec3f(live_r, live_g, live_b);

  // Sample previous slit-scan frame with subtle chromatic drift
  let h_uv_c = clamp(hist_uv, vec2f(0.0), vec2f(1.0));
  let prev_r = prev(clamp(h_uv_c + slit_dir * (rgb_amt * 0.22), vec2f(0.0), vec2f(1.0))).r;
  let prev_g = prev(h_uv_c).g;
  let prev_b = prev(clamp(h_uv_c - slit_dir * (rgb_amt * 0.22), vec2f(0.0), vec2f(1.0))).b;
  let hist_col = max(vec3f(0.0), vec3f(prev_r, prev_g, prev_b) * p_decay());

  // Subject punch-through: bright media regions and active slit refresh the history
  let subject_gate = smoothstep(0.28, 0.88, luma_v) * p_live_mix() * (0.65 + 0.55 * b);
  let refresh = clamp(max(in_slit, max(subject_gate, blk_on * 0.65)), 0.0, 1.0);
  var col = mix(hist_col, live_col, refresh);

  // Accentuate slit scanline and strong media edges with palette energy
  let pal_acc = palette(fract(luma_v * 0.7 + t * 0.08 + strip_rnd * 0.2));
  col += pal_acc * (slit_rim * 0.38 + edge_mag * 0.24 * (0.3 + energy) + strip_on * 0.18 * energy);

  // Subtle scanline texture for crisp video-glitch feel
  let scan = 0.94 + 0.06 * sin(uv.y * resolution().y * 1.5);
  col *= scan;

  return vec4f(clamp(col, vec3f(0.0), vec3f(3.0)), 1.0);
}
