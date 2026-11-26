struct U {
  dims: vec4f,          // map_w, map_h, agent_n, out_aspect
  phys: vec4f,          // speed, sensor_angle, sensor_dist, turn
  decay: vec4f,         // decay_rate, deposit, glow, repel
  audio: vec4f,         // time, rms, bass, kick
  audio2: vec4f,        // mid, high, phase, onset
  extra: vec4f,         // tick_mod, warm, 0, 0
  pal: array<vec4f, 8>, // OKLab stops
  pal_n: vec4f,         // count, 0, 0, 0
};

@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var<storage, read_write> agents: array<vec4f>;
@group(0) @binding(2) var<storage, read> trail_in: array<vec2f>;
@group(0) @binding(3) var<storage, read_write> trail_out: array<vec2f>;
@group(0) @binding(4) var<storage, read_write> dep: array<atomic<u32>>;

const TAU: f32 = 6.283185307;

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

fn wrap_idx(x: i32, y: i32) -> u32 {
  let w = i32(u.dims.x);
  let h = i32(u.dims.y);
  let wx = ((x % w) + w) % w;
  let wy = ((y % h) + h) % h;
  return u32(wy * w + wx);
}

fn sense(px: f32, py: f32, ang: f32, dist: f32, sp: f32) -> f32 {
  let w = u.dims.x;
  let h = u.dims.y;
  let sx = px + cos(ang) * dist;
  let sy = py + sin(ang) * dist;
  let ix = i32(floor(sx - floor(sx / w) * w));
  let iy = i32(floor(sy - floor(sy / h) * h));
  let v = trail_in[wrap_idx(ix, iy)];
  // own strain attracts strongly, rival strain mildly repels -> intertwined braided filaments
  return select(v.y - v.x * 0.35, v.x - v.y * 0.35, sp < 0.5);
}

@compute @workgroup_size(8, 8)
fn cs_clear(@builtin(global_invocation_id) gid: vec3u) {
  let w = u32(u.dims.x);
  let h = u32(u.dims.y);
  if (gid.x >= w || gid.y >= h) { return; }
  let i = gid.y * w + gid.x;
  trail_out[i] = vec2f(0.0);
  atomicStore(&dep[i * 2u], 0u);
  atomicStore(&dep[i * 2u + 1u], 0u);
}

@compute @workgroup_size(128)
fn cs_init(@builtin(global_invocation_id) gid: vec3u) {
  let n = u32(u.dims.z);
  let i = gid.x;
  if (i >= n) { return; }
  let w = u.dims.x;
  let h = u.dims.y;
  let f = f32(i) / f32(n);
  let r1 = f32(h32(i, 13u) & 65535u) / 65535.0;
  let r2 = f32(h32(i, 47u) & 65535u) / 65535.0;
  let ring = 0.08 + 0.42 * sqrt(r1);
  let a = f * TAU * 13.0 + r2 * TAU;
  let cx = w * 0.5 + cos(a) * ring * w * 0.92;
  let cy = h * 0.5 + sin(a) * ring * h * 0.92;
  let heading = a + 1.5707963 + (r2 - 0.5) * 1.1;
  let sp = f32(i & 1u);
  agents[i] = vec4f(
    cx - floor(cx / w) * w,
    cy - floor(cy / h) * h,
    heading,
    sp
  );
}

@compute @workgroup_size(128)
fn cs_agents(@builtin(global_invocation_id) gid: vec3u) {
  let n = u32(u.dims.z);
  let i = gid.x;
  if (i >= n) { return; }

  let w = u.dims.x;
  let h = u.dims.y;
  var ag = agents[i];
  var x = ag.x;
  var y = ag.y;
  var ang = ag.z;
  let sp = ag.w;

  let rms = u.audio.y;
  let bass = u.audio.z;
  let kick = u.audio.w;
  let mid = u.audio2.x;
  let onset = u.audio2.w;

  let sa = u.phys.y * (0.75 + 0.65 * mid);
  let sd = u.phys.z * (0.72 + 0.95 * bass + 0.35 * rms);
  let ts = u.phys.w * (0.75 + 0.7 * rms);

  let fl = sense(x, y, ang - sa, sd, sp);
  let fc = sense(x, y, ang, sd, sp);
  let fr = sense(x, y, ang + sa, sd, sp);

  let rnd = f32(h32(i ^ u32(u.extra.x), u32(u.extra.x) * 73u + 19u) & 65535u) / 65535.0;
  if (fc > fl && fc > fr) {
    ang = ang + (rnd - 0.5) * 0.08;
  } else if (fc < fl && fc < fr) {
    ang = ang + (rnd - 0.5) * 2.0 * ts;
  } else if (fl > fr) {
    ang = ang - ts * (0.7 + 0.6 * rnd);
  } else if (fr > fl) {
    ang = ang + ts * (0.7 + 0.6 * rnd);
  }

  // onset scatter + subtle orbital swirl locked to music energy
  if (onset > 0.5 && u.extra.y < 0.5) {
    let dx = x - w * 0.5;
    let dy = y - h * 0.5;
    let to_out = atan2(dy, dx);
    ang = ang + sin(to_out - ang) * 0.32 + (rnd - 0.5) * 0.65;
  }
  let swirl_dir = select(-1.0, 1.0, sp < 0.5);
  ang = ang + swirl_dir * (0.008 + 0.025 * kick);

  let spd = u.phys.x * (0.68 + 1.05 * bass + 0.45 * rms + 0.65 * kick);
  x = x + cos(ang) * spd;
  y = y + sin(ang) * spd;
  x = x - floor(x / w) * w;
  y = y - floor(y / h) * h;

  agents[i] = vec4f(x, y, ang, sp);

  let ix = u32(clamp(i32(x), 0, i32(w) - 1));
  let iy = u32(clamp(i32(y), 0, i32(h) - 1));
  let ch = select(1u, 0u, sp < 0.5);
  let amt = u32(clamp(u.decay.y * (1.0 + 0.75 * rms + 0.5 * kick) * 1024.0, 64.0, 4096.0));
  atomicAdd(&dep[(iy * u32(w) + ix) * 2u + ch], amt);
}

@compute @workgroup_size(8, 8)
fn cs_diffuse(@builtin(global_invocation_id) gid: vec3u) {
  let w = u32(u.dims.x);
  let h = u32(u.dims.y);
  if (gid.x >= w || gid.y >= h) { return; }
  let x = i32(gid.x);
  let y = i32(gid.y);
  let i = gid.y * w + gid.x;

  // 3x3 Gaussian diffusion
  let blur =
    trail_in[wrap_idx(x, y)] * 0.25 +
    (trail_in[wrap_idx(x - 1, y)] + trail_in[wrap_idx(x + 1, y)] +
     trail_in[wrap_idx(x, y - 1)] + trail_in[wrap_idx(x, y + 1)]) * 0.125 +
    (trail_in[wrap_idx(x - 1, y - 1)] + trail_in[wrap_idx(x + 1, y - 1)] +
     trail_in[wrap_idx(x - 1, y + 1)] + trail_in[wrap_idx(x + 1, y + 1)]) * 0.0625;

  let d0 = f32(atomicExchange(&dep[i * 2u], 0u)) / 1024.0;
  let d1 = f32(atomicExchange(&dep[i * 2u + 1u], 0u)) / 1024.0;

  var val = (blur + vec2f(d0, d1)) * u.decay.x;

  // onset chemoattractant ring: draws filaments into expanding harmonic rings on beats
  let kick = u.audio.w;
  if (kick > 0.15 && u.extra.y < 0.5) {
    let uv = (vec2f(f32(x), f32(y)) + 0.5) / u.dims.xy;
    let p = (uv - 0.5) * vec2f(u.dims.x / u.dims.y, 1.0);
    let r = length(p);
    let ring_r = 0.14 + (1.0 - kick) * 0.42;
    let dr = (r - ring_r) / 0.018;
    let ring = exp(-(dr * dr)) * kick * 0.18;
    val = val + vec2f(ring, ring * 0.7);
  }

  trail_out[i] = clamp(val, vec2f(0.0), vec2f(5.0));
}

fn sample_trail(fx: f32, fy: f32) -> vec2f {
  let w = u.dims.x;
  let h = u.dims.y;
  let x = fx - floor(fx / w) * w;
  let y = fy - floor(fy / h) * h;
  let x0 = i32(floor(x));
  let y0 = i32(floor(y));
  let tx = x - f32(x0);
  let ty = y - f32(y0);
  let a = trail_in[wrap_idx(x0, y0)];
  let b = trail_in[wrap_idx(x0 + 1, y0)];
  let c = trail_in[wrap_idx(x0, y0 + 1)];
  let d = trail_in[wrap_idx(x0 + 1, y0 + 1)];
  return mix(mix(a, b, tx), mix(c, d, tx), ty);
}

@fragment
fn fs_render(v: VOut) -> @location(0) vec4f {
  let w = u.dims.x;
  let h = u.dims.y;
  let fx = v.uv.x * w - 0.5;
  let fy = v.uv.y * h - 0.5;
  let tr = sample_trail(fx, fy);

  // subtle sharpening via local neighborhood contrast
  let tx = sample_trail(fx + 1.0, fy) - sample_trail(fx - 1.0, fy);
  let ty = sample_trail(fx, fy + 1.0) - sample_trail(fx, fy - 1.0);
  let edge = length(tx) + length(ty);

  let total = tr.x + tr.y;
  let density = 1.0 - exp(-total * 1.45);
  let core = 1.0 - exp(-total * 0.48);
  let balance = tr.x / max(total, 0.0001);

  let t = u.audio.x;
  let rms = u.audio.y;
  let bass = u.audio.z;
  let kick = u.audio.w;
  let high = u.audio2.y;
  let glow = u.decay.z;

  let p = (v.uv - 0.5) * vec2f(u.dims.w, 1.0);
  let rad = length(p);

  let c_a = pal(fract(0.15 + density * 0.45 + t * 0.02));
  let c_b = pal(fract(0.58 + density * 0.35 + t * 0.02));
  let c_hot = pal(fract(0.88 + high * 0.12));

  let vein_col = mix(c_b, c_a, balance);
  let bg = pal(0.05) * (0.045 + 0.055 * exp(-rad * 1.5)) * (0.75 + 0.5 * rms);
  let body = vein_col * pow(max(density, 0.0), 1.15) * glow * (0.85 + 0.55 * bass + 0.45 * kick);
  let hot = c_hot * (core * core * 0.65 + edge * (0.28 + 0.45 * high)) * glow;

  var col = bg + body + hot;
  col = col * (1.0 - 0.25 * smoothstep(0.6, 1.35, rad));
  col = clamp(col, vec3f(0.0), vec3f(3.5));
  return vec4f(col, 1.0);
}
