struct U {
  dims: vec4f,          // sim_w, sim_h, out_w, out_h
  sim: vec4f,           // feed, kill, pulse, swirl
  audio: vec4f,         // time, rms, bass, kick
  audio2: vec4f,        // mid, high, phase, bar
  fx: vec4f,            // relief, glow, onset, warm
  seed: vec4f,          // seed_x, seed_y, seed_r, seed_amt
  pal: array<vec4f, 8>, // OKLab stops
  pal_n: vec4f,         // count, 0, 0, 0
};

@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var<storage, read> src: array<vec2f>;
@group(0) @binding(2) var<storage, read_write> dst: array<vec2f>;

fn oklab_lin(c: vec3f) -> vec3f {
  let l_ = c.x + 0.3963377774 * c.y + 0.2158037573 * c.z;
  let m_ = c.x - 0.1055613458 * c.y - 0.0638541728 * c.z;
  let s_ = c.x - 0.0894841775 * c.y - 1.291485548 * c.z;
  let l = l_ * l_ * l_; let m = m_ * m_ * m_; let s = s_ * s_ * s_;
  return max(vec3f(0.0), vec3f(
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s
  ));
}

fn pal(x: f32) -> vec3f {
  let n = max(i32(u.pal_n.x), 1);
  let f = clamp(x, 0.0, 1.0) * f32(n - 1);
  let i = min(i32(floor(f)), n - 1);
  let j = min(i + 1, n - 1);
  return oklab_lin(mix(u.pal[i].xyz, u.pal[j].xyz, f - f32(i)));
}

fn idx(x: i32, y: i32) -> u32 {
  let w = i32(u.dims.x);
  let h = i32(u.dims.y);
  let wx = ((x % w) + w) % w;
  let wy = ((y % h) + h) % h;
  return u32(wy * w + wx);
}

fn sample_bilerp(fx: f32, fy: f32) -> vec2f {
  let w = u.dims.x;
  let h = u.dims.y;
  let x = fx - floor(fx / w) * w;
  let y = fy - floor(fy / h) * h;
  let x0 = i32(floor(x));
  let y0 = i32(floor(y));
  let tx = x - f32(x0);
  let ty = y - f32(y0);
  let a = src[idx(x0, y0)];
  let b = src[idx(x0 + 1, y0)];
  let c = src[idx(x0, y0 + 1)];
  let d = src[idx(x0 + 1, y0 + 1)];
  return mix(mix(a, b, tx), mix(c, d, tx), ty);
}

@compute @workgroup_size(8, 8)
fn cs_init(@builtin(global_invocation_id) gid: vec3u) {
  let w = u32(u.dims.x);
  let h = u32(u.dims.y);
  if (gid.x >= w || gid.y >= h) { return; }
  let uv = (vec2f(gid.xy) + 0.5) / vec2f(f32(w), f32(h));
  let asp = f32(w) / f32(h);
  let p = (uv - 0.5) * vec2f(asp, 1.0);
  let r = length(p);
  let ang = atan2(p.y, p.x);

  var v = 0.0;
  // central organic ring + harmonic reef nuclei across the canvas
  let dr1 = (r - 0.22 - 0.03 * sin(ang * 5.0)) / 0.022;
  let ring = exp(-(dr1 * dr1));
  v = max(v, ring * 0.45);
  let dr2 = (r - 0.44 + 0.04 * cos(ang * 7.0)) / 0.018;
  let outer = exp(-(dr2 * dr2));
  v = max(v, outer * 0.35);

  for (var k = 0; k < 10; k++) {
    let kf = f32(k);
    let a = kf * 2.3999632 + 0.4;
    let rad = 0.08 + 0.34 * sqrt((kf + 0.5) / 10.0);
    let c = vec2f(cos(a), sin(a)) * rad * vec2f(1.25, 0.95);
    let d = length(p - c);
    v = max(v, smoothstep(0.042, 0.014, d) * 0.5);
  }

  let n = f32(h32(gid.x * 17u + 3u, gid.y * 31u + 9u) & 1023u) / 1023.0;
  v = clamp(v * (0.75 + 0.5 * n), 0.0, 0.65);
  let uc = clamp(1.0 - v * 1.15, 0.25, 1.0);
  dst[gid.y * w + gid.x] = vec2f(uc, v);
}

@compute @workgroup_size(8, 8)
fn cs_step(@builtin(global_invocation_id) gid: vec3u) {
  let w = u32(u.dims.x);
  let h = u32(u.dims.y);
  if (gid.x >= w || gid.y >= h) { return; }
  let x = i32(gid.x);
  let y = i32(gid.y);
  let uv = (vec2f(f32(x), f32(y)) + 0.5) / u.dims.xy;
  let asp = u.dims.x / u.dims.y;
  let p = (uv - 0.5) * vec2f(asp, 1.0);
  let r = length(p);
  let ang = atan2(p.y, p.x);

  // gentle radial breathing + curl drift so colonies evolve & pulse with audio
  let t = u.audio.x;
  let bass = u.audio.z;
  let kick = u.audio.w;
  let mid = u.audio2.x;
  let pulse = u.sim.z;
  let swirl = u.sim.w;

  let radial = p / max(r, 0.03);
  let tang = vec2f(-radial.y, radial.x);
  let drift_rad = (0.04 + 0.26 * kick + 0.12 * bass) * pulse * sin(r * 5.0 - t * 1.4);
  let drift_tan = swirl * (0.14 + 0.35 * mid) * (0.5 + 0.5 * cos(r * 3.5 + t * 0.4));
  let adv = (radial * drift_rad + tang * drift_tan) * (1.0 - u.fx.w * 0.85);

  let cur = sample_bilerp(f32(x) - adv.x, f32(y) - adv.y);

  // 9-point isotropic Laplacian
  let lap =
    src[idx(x - 1, y)] * 0.20 + src[idx(x + 1, y)] * 0.20 +
    src[idx(x, y - 1)] * 0.20 + src[idx(x, y + 1)] * 0.20 +
    src[idx(x - 1, y - 1)] * 0.05 + src[idx(x + 1, y - 1)] * 0.05 +
    src[idx(x - 1, y + 1)] * 0.05 + src[idx(x + 1, y + 1)] * 0.05 -
    src[idx(x, y)];

  // spatially & musically modulated Gray-Scott feed/kill rates
  let wave = 0.0045 * sin(r * 7.0 - t * 0.8 + ang * 2.0);
  let F = clamp(u.sim.x + bass * 0.013 + wave, 0.018, 0.066);
  let k = clamp(u.sim.y + mid * 0.0035 - bass * 0.0025 + 0.0018 * cos(ang * 3.0 + t * 0.45), 0.049, 0.066);

  let uc = clamp(cur.x, 0.0, 1.0);
  let vc = clamp(cur.y, 0.0, 1.0);
  let uvv = uc * vc * vc;

  let du = 1.0;
  let dv = 0.5;
  var un = uc + (du * lap.x - uvv + F * (1.0 - uc));
  var vn = vc + (dv * lap.y + uvv - (F + k) * vc);

  // audio onset / beat ring seeding (symmetric pair for balanced visual composition)
  if (u.seed.w > 0.0005) {
    let sc = vec2f(u.seed.x, u.seed.y);
    let d1 = abs(length(p - sc) - u.seed.z);
    let d2 = abs(length(p + sc) - u.seed.z);
    let ring_add = (smoothstep(0.022, 0.0, d1) + smoothstep(0.022, 0.0, d2)) * u.seed.w;
    vn = vn + ring_add;
    un = un - ring_add * 0.5;
  }

  // subtle living heartbeat nucleus so the colony never dies out during long quiet passages
  let core_r = abs(r - (0.06 + 0.02 * sin(t * 1.1)));
  let core_add = smoothstep(0.014, 0.0, core_r) * (0.005 + 0.012 * u.audio.y);
  vn = vn + core_add;

  dst[gid.y * w + gid.x] = vec2f(clamp(un, 0.0, 1.0), clamp(vn, 0.0, 1.0));
}

@fragment
fn fs_render(v: VOut) -> @location(0) vec4f {
  let w = u.dims.x;
  let h = u.dims.y;
  let fx = v.uv.x * w - 0.5;
  let fy = v.uv.y * h - 0.5;

  let c = sample_bilerp(fx, fy);
  let cx1 = sample_bilerp(fx + 1.0, fy);
  let cx0 = sample_bilerp(fx - 1.0, fy);
  let cy1 = sample_bilerp(fx, fy + 1.0);
  let cy0 = sample_bilerp(fx, fy - 1.0);

  let val = c.y;
  let dep = 1.0 - c.x;
  let gx = (cx1.y - cx0.y) * 0.5;
  let gy = (cy1.y - cy0.y) * 0.5;
  let grad_len = length(vec2f(gx, gy));

  let t = u.audio.x;
  let rms = u.audio.y;
  let bass = u.audio.z;
  let kick = u.audio.w;
  let high = u.audio2.y;
  let relief = u.fx.x;
  let glow = u.fx.y;

  // 3D normal from V-field gradient for tactile coral/bioluminescent relief
  let n = normalize(vec3f(-gx * (12.0 * relief + 0.5), -gy * (12.0 * relief + 0.5), 1.0));
  let ldir = normalize(vec3f(cos(t * 0.45) * 0.7, sin(t * 0.37) * 0.7, 0.85));
  let diff = max(dot(n, ldir), 0.0);
  let half_v = normalize(ldir + vec3f(0.0, 0.0, 1.0));
  let spec = pow(max(dot(n, half_v), 0.0001), 22.0) * (0.45 + 0.9 * high + 0.6 * kick) * relief;
  let rim = pow(clamp(1.0 - n.z, 0.0, 1.0), 1.8) * (0.65 + 1.1 * bass + 0.8 * kick);

  let asp = u.dims.z / max(u.dims.w, 1.0);
  let p = (v.uv - 0.5) * vec2f(asp, 1.0);
  let rad = length(p);

  // OKLab palette mapping across dark abyss -> coral body -> glowing ridge crests
  let body = smoothstep(0.03, 0.36, val);
  let crest = clamp(grad_len * 9.5, 0.0, 1.4);
  let pal_t = fract(val * 1.45 + dep * 0.35 + rad * 0.18 + t * 0.025);

  let bg = pal(0.08) * (0.05 + 0.06 * exp(-rad * 1.6)) * (0.8 + 0.4 * rms);
  let base_col = pal(pal_t) * body * (0.38 + 0.68 * diff);
  let ridge_col = pal(fract(pal_t + 0.32)) * (crest * 0.78 + rim * 0.55) * glow * (0.75 + 0.65 * bass + 0.55 * kick);
  let spec_col = mix(pal(0.92), vec3f(1.0), 0.35) * spec * smoothstep(0.04, 0.2, val);

  var col = bg + base_col * glow + ridge_col + spec_col;
  // soft vignette to frame the living colony
  col = col * (1.0 - 0.28 * smoothstep(0.55, 1.35, rad));
  col = clamp(col, vec3f(0.0), vec3f(3.5));
  return vec4f(col, 1.0);
}
