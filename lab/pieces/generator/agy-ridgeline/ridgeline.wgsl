// Spectrum terrain / ridgeline: Joy-Division stacked history ridges with back-to-front occlusion and HDR glow.

struct U {
  // res.xy, time, rows
  a: vec4f,
  // height, perspective, glow, thickness
  b: vec4f,
  // fill, rms, bass, kick
  c: vec4f,
  // phase, bar, segments, _pad
  d: vec4f,
  pal: array<vec4f, 8>,
};

@group(0) @binding(0) var<uniform> u: U;
// Per-instance metadata (painter's order: 0 = farthest back, rows-1 = closest front):
// x = depth [0..1), y = ridgeId, z = onsetHit [0..1], w = energy [0..1]
@group(0) @binding(1) var<storage, read> row_meta: array<vec4f>;
// Per-instance 16 spectrum bands packed as 4 vec4fs per row
@group(0) @binding(2) var<storage, read> row_spec: array<vec4f>;

fn pal_at(t: f32) -> vec3f {
  let f = clamp(t, 0.0, 1.0) * 7.0;
  let i = min(i32(floor(f)), 6);
  return mix(u.pal[i].rgb, u.pal[i + 1].rgb, f - f32(i));
}

fn read_band(row: u32, idx: i32) -> f32 {
  let b = clamp(idx, 0, 15);
  return row_spec[row * 4u + u32(b / 4)][b % 4];
}

// Smooth cubic Catmull-Rom interpolation across the 16 spectrum bands
fn sample_spectrum(row: u32, x01: f32) -> f32 {
  // Mirror-fold subtly or map low-to-high with bass centered like Unknown Pleasures:
  // Put low/mid energy toward the center-left and high energy fanning toward center-right,
  // while keeping edges cleanly tapered.
  let pos = clamp(x01, 0.0, 1.0) * 15.0;
  let i1 = i32(floor(pos));
  let f = pos - f32(i1);
  let p0 = read_band(row, i1 - 1);
  let p1 = read_band(row, i1);
  let p2 = read_band(row, i1 + 1);
  let p3 = read_band(row, i1 + 2);
  let f2 = f * f;
  let f3 = f2 * f;
  let v = 0.5 * (
    (2.0 * p1) +
    (-p0 + p2) * f +
    (2.0 * p0 - 5.0 * p1 + 4.0 * p2 - p3) * f2 +
    (-p0 + 3.0 * p1 - 3.0 * p2 + p3) * f3
  );
  return max(0.0, v);
}

fn ridge_noise(x: f32, ridge_id: f32) -> f32 {
  let n1 = sin(x * 13.0 + ridge_id * 0.73) * 0.5 + 0.5;
  let n2 = sin(x * 29.0 - ridge_id * 1.17 + 1.4) * 0.5 + 0.5;
  let n3 = sin(x * 53.0 + ridge_id * 2.03) * 0.5 + 0.5;
  return n1 * 0.55 + n2 * 0.30 + n3 * 0.15;
}

// Compute the screen-space (uv) position of a vertex along a ridge
fn eval_ridge(row: u32, s: f32) -> vec3f {
  let m = row_meta[row];
  let depth = m.x;       // 0 = front (bottom), 1 = far horizon (top)
  let rid = m.y;
  let onset_hit = m.z;
  let energy = m.w;
  let persp = u.b.y;

  // Perspective z-foreshortening: front rows spread wider, distant rows compress near the horizon
  let z_persp = 1.0 / mix(1.0, 1.0 + depth * 3.2, persp);
  let y_lin = mix(0.95, 0.22, depth);
  let y_persp = mix(0.20, 0.96, (z_persp - 1.0 / 4.2) / (1.0 - 1.0 / 4.2));
  let base_y = mix(y_lin, y_persp, persp);

  // Horizontal span narrows into perspective
  let half_w = mix(0.45, 0.48 * mix(1.0, z_persp * 1.15, persp), 1.0);
  let uv_x = 0.5 + (s - 0.5) * 2.0 * half_w;

  // Classic Joy-Division bell envelope: tall mountain range in center, flat plains at edges
  let centered = (s - 0.5) * 2.0;
  let env = exp(-centered * centered * 3.1) * smoothstep(1.0, 0.72, abs(centered));

  // Map s across spectrum: fold so bass sits strongly near the center, highs out on shoulders
  let spec_x = abs(centered);
  let spec_lo = sample_spectrum(row, spec_x * 0.85);
  let spec_full = sample_spectrum(row, s);
  let spec_val = mix(spec_lo, spec_full, 0.45);

  // Subtle living geological baseline so quiet passages still show calm, drifting mountain silhouettes
  let terrain = ridge_noise(s, rid) * (0.09 + 0.04 * sin(rid * 0.19 + s * 6.0));
  let micro = (ridge_noise(s * 2.1 + 0.3, rid * 1.7) - 0.5) * 0.04 * (0.3 + spec_val);

  let elev_scale = mix(1.0, 0.32 + 0.88 * z_persp, persp);
  let peak_h = (terrain + spec_val * 0.92 + micro + onset_hit * 0.08 * spec_val) * env * u.b.x * 0.24 * elev_scale;
  let ridge_y = base_y - peak_h;

  // Return (uv_x, ridge_y, normalized_peak_intensity)
  let intensity = clamp(spec_val * 1.15 + onset_hit * 0.45 + energy * 0.25, 0.0, 2.0);
  return vec3f(uv_x, ridge_y, intensity);
}

@fragment fn fs_bg(v: VOut) -> @location(0) vec4f {
  let uv = v.uv;
  let horizon = mix(0.22, 0.20, u.b.y);
  let sky_d = abs(uv.y - horizon);

  // Subtle midnight sky gradient + soft luminous horizon aura reacting to bass & kicks
  let top_col = pal_at(0.08) * 0.05;
  let hor_col = pal_at(0.55) * (0.11 + u.c.y * 0.16 + u.c.z * 0.14 + u.c.w * 0.22);
  let glow_band = exp(-sky_d * 9.5) * (0.65 + 0.35 * exp(-pow((uv.x - 0.5) * 2.4, 2.0)));
  let deep_floor = pal_at(0.04) * 0.025;

  // Faint stars above the horizon
  var stars = 0.0;
  if (uv.y < horizon + 0.08) {
    let p = vec2f(uv.x * u.a.x / u.a.y, uv.y) * 58.0;
    let cell = floor(p);
    let f = fract(p) - 0.5;
    let h = h32(u32(i32(cell.x) + 1024), u32(i32(cell.y) + 1024));
    if (f32(h >> 22u) / 1023.0 > 0.955) {
      let off = vec2f(f32(h & 1023u) / 1023.0, f32((h >> 10u) & 1023u) / 1023.0) - 0.5;
      let d = length(f - off * 0.65);
      let twinkle = 0.65 + 0.35 * sin(u.a.z * 2.3 + f32(h & 255u));
      stars = smoothstep(0.09, 0.0, d) * twinkle * smoothstep(horizon + 0.06, horizon - 0.12, uv.y);
    }
  }

  let base = mix(top_col, deep_floor, smoothstep(horizon - 0.05, horizon + 0.25, uv.y));
  let col = base + hor_col * glow_band + mix(vec3f(0.85, 0.92, 1.0), pal_at(0.85), 0.35) * stars * 0.45;
  return vec4f(col, 1.0);
}

struct ROut {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
  @location(1) ridge_y: f32,
  @location(2) peak: f32,
  @location(3) depth: f32,
  @location(4) s: f32,
  @location(5) onset_hit: f32,
};

@vertex fn vs_ridge(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> ROut {
  let seg = vi / 6u;
  let k = vi % 6u;
  let segs = u.d.z;
  let s0 = f32(seg) / segs;
  let s1 = f32(seg + 1u) / segs;

  // Quad corners: 0=(left,top), 1=(right,top), 2=(left,bot), 3=(left,bot), 4=(right,top), 5=(right,bot)
  let is_right = (k == 1u || k == 4u || k == 5u);
  let is_bot = (k == 2u || k == 3u || k == 5u);
  let s = select(s0, s1, is_right);

  let r = eval_ridge(ii, s);
  let m = row_meta[ii];
  let depth = m.x;

  // Upward glow halo padding (in uv units) above the ridge crest, occluder skirt extends down below
  let glow_pad = (0.028 + 0.018 * u.b.z) * mix(1.0, 0.45, depth);
  let skirt_y = min(1.05, r.y + mix(0.24, 0.14, depth));
  let y = select(r.y - glow_pad, skirt_y, is_bot);

  var out: ROut;
  out.pos = vec4f(r.x * 2.0 - 1.0, 1.0 - y * 2.0, 0.0, 1.0);
  out.uv = vec2f(r.x, y);
  out.ridge_y = r.y;
  out.peak = r.z;
  out.depth = depth;
  out.s = s;
  out.onset_hit = m.z;
  return out;
}

@fragment fn fs_ridge(in: ROut) -> @location(0) vec4f {
  // Signed vertical distance in pixels from the ridge crest: negative = above crest, positive = inside mountain body
  let dy_px = (in.uv.y - in.ridge_y) * u.a.y;
  let depth = in.depth;

  // Smooth entry fade at the very front and smooth horizon fade at the very back
  let fade_front = smoothstep(0.0, 0.06, depth);
  let fade_back = smoothstep(1.0, 0.88, depth);
  let row_vis = fade_front * fade_back;

  // Perspective-scaled line width
  let lw = u.b.w * mix(1.15, 0.55, depth * (0.4 + 0.6 * u.b.y)) * (1.0 + 0.25 * in.onset_hit);

  // Anti-aliased occluder body alpha (0 above line, 1 below line)
  let body_alpha = smoothstep(-0.75, 0.75, dy_px) * row_vis;

  // Crisp glowing ridge line + multi-tier soft bloom halo
  let ad = abs(dy_px);
  let core = exp(-pow(ad / max(lw * 0.65, 0.4), 2.0));
  let inner_glow = exp(-ad / max(lw * 2.6, 1.2));
  let outer_glow = exp(-ad / max(lw * 9.0, 4.0));

  // Color along palette: valleys/back are cooler, active peaks & front shift toward bright palette crests
  let pal_t = clamp(0.18 + (1.0 - depth) * 0.35 + in.peak * 0.35 + in.onset_hit * 0.15, 0.0, 1.0);
  let line_tint = pal_at(pal_t);
  let crest_hot = mix(line_tint, vec3f(1.0, 0.98, 0.96), clamp(0.32 + in.peak * 0.35, 0.0, 0.78));

  // Distance fog attenuates distant ridges for rich depth separation
  let dist_att = mix(1.0, 0.28, depth * depth);
  let glow_amp = u.b.z * (0.55 + 0.75 * in.peak + 0.45 * in.onset_hit) * dist_att;

  // Occluding mountain face fill: dark obsidian/indigo base + subtle slope contour shading near crest
  let slope_falloff = exp(-max(dy_px, 0.0) / mix(42.0, 14.0, depth));
  let fog_col = pal_at(0.35) * (0.04 + 0.05 * u.c.y);
  let dark_face = mix(vec3f(0.008, 0.010, 0.018), fog_col, depth * 0.75);
  let slope_tint = line_tint * (0.08 + 0.22 * in.peak) * slope_falloff * u.c.x * dist_att;
  let fill_rgb = dark_face + slope_tint;

  // Luminous crest + halo (halo extends above the ridge with alpha=0 for additive-like glow over behind ridges)
  let line_rgb = (crest_hot * core * 1.45 + line_tint * inner_glow * 0.55 + line_tint * outer_glow * 0.18) * glow_amp * row_vis;

  // Premultiplied output: body occludes behind (alpha = body_alpha), line glow adds light smoothly
  let out_rgb = fill_rgb * body_alpha + line_rgb;
  return vec4f(out_rgb, body_alpha);
}
