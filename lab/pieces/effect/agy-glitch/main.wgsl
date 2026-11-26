fn hash21(p: vec2f) -> f32 {
  var q = fract(p * vec2f(123.34, 456.21));
  q += dot(q, q + 45.32);
  return fract(q.x * q.y);
}

fn hash22(p: vec2f) -> vec2f {
  let n = hash21(p);
  return vec2f(n, hash21(p + n * 19.17 + 7.31));
}

fn shade(uv: vec2f) -> vec4f {
  let amt = p_amount();
  let t = time();

  // Snappy burst envelope from onsets, beat impact, and bass energy
  let beat_kick = pow(max(0.0, 1.0 - phase() * 3.0), 2.5) * (0.35 + 0.65 * bass());
  let energy = clamp(onset() + beat_kick + rms() * 0.4, 0.0, 1.5);
  let drive = amt * (0.25 + p_burst() * energy);

  // Quantized time step so macroblocks snap like digital codec frames
  let step_t = floor(t * 10.0 + onset() * 7.0);
  let grid = vec2f(p_blocks() * aspect(), p_blocks());
  let blk = floor(uv * grid);
  let rnd = hash22(blk + vec2f(step_t * 1.37, step_t * 0.73));

  // Horizontal tear strips triggered by bursts
  let strip_y = floor(uv.y * (p_blocks() * 2.5));
  let strip_r = hash21(vec2f(strip_y, floor(t * 18.0)));
  let strip_mask = step(1.0 - clamp(drive * 0.35, 0.0, 0.65), strip_r);
  let strip_dx = (hash21(vec2f(strip_y + 31.0, step_t)) - 0.5) * 0.16 * p_displace() * drive * strip_mask;

  // Macroblock displacement
  let blk_active = step(1.0 - clamp(drive * 0.45, 0.0, 0.75), rnd.x);
  let blk_shift = (rnd - 0.5) * vec2f(0.14, 0.07) * p_displace() * drive * blk_active;
  let disp_uv = fract(uv + blk_shift + vec2f(strip_dx, 0.0));

  // RGB channel split (stronger on displaced blocks & high energy)
  let rgb_off = (0.004 + 0.022 * drive * (0.4 + 0.6 * max(blk_active, strip_mask))) * p_rgb();
  let rgb_v = vec2f(rgb_off, rgb_off * 0.25 * (rnd.y - 0.5));
  let live_r = tex_in(clamp(disp_uv + rgb_v, vec2f(0.0), vec2f(1.0))).r;
  let live_g = tex_in(clamp(disp_uv, vec2f(0.0), vec2f(1.0))).g;
  let live_b = tex_in(clamp(disp_uv - rgb_v, vec2f(0.0), vec2f(1.0))).b;
  let live = vec3f(live_r, live_g, live_b);

  // Datamosh P-frame motion smear from the previous output
  let mv_dir = (hash22(blk + vec2f(floor(t * 3.0), 11.7)) - 0.5) * 2.0;
  let mv = mv_dir * vec2f(0.018, 0.012) * (0.3 + 0.7 * energy) * p_smear();
  let prev_uv = clamp(uv + mv + vec2f(strip_dx * 0.25, 0.0), vec2f(0.0), vec2f(1.0));
  let mosh = max(vec3f(0.0), prev(prev_uv).rgb * 0.965 - vec3f(0.002));

  // Selectively hold/smear macroblocks; refresh on fresh I-frame blocks or bright live hits
  let live_luma = dot(live, vec3f(0.2126, 0.7152, 0.0722));
  let mosh_gate = p_smear() * clamp(amt * 1.15, 0.0, 1.0) * mix(0.45, 0.95, blk_active);
  // Onsets occasionally force partial macroblock tears while letting others smear
  let keep_mosh = clamp(mosh_gate * (1.0 - smoothstep(0.65, 1.4, live_luma) * 0.55), 0.0, 0.92);

  var col = mix(live, max(mosh, live * 0.65), keep_mosh);

  // Subtle digital quantization flicker on active tear strips
  if (strip_mask > 0.5 && drive > 0.35) {
    let q = floor(col * 8.0 + 0.5) / 8.0;
    col = mix(col, q, 0.4 * amt);
  }

  return vec4f(col, 1.0);
}
