struct Particle {
  pos_age: vec4f,  // x, y, z, age (0..1)
  vel_seed: vec4f, // vx, vy, vz, seed (0..1)
};

struct U {
  vp: mat4x4f,          // 0..15
  sim: vec4f,           // count, attractor_idx, speed, chaos
  draw: vec4f,          // streak, size, glow, aspect
  audio: vec4f,         // time, rms, bass, kick
  audio2: vec4f,        // mid, high, phase, onset
  extra: vec4f,         // tick_mod, warm, res_x, res_y
  pal: array<vec4f, 8>, // OKLab stops
  pal_n: vec4f,         // count, 0, 0, 0
};

@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var<storage, read_write> parts: array<Particle>;

fn hash01(a: u32, b: u32) -> f32 {
  return f32(h32(a, b) & 65535u) / 65535.0;
}

fn spawn_pos(i: u32, salt: u32, kind: i32) -> vec3f {
  let r1 = hash01(i, salt * 17u + 3u) * 2.0 - 1.0;
  let r2 = hash01(i, salt * 31u + 11u) * 2.0 - 1.0;
  let r3 = hash01(i, salt * 53u + 29u) * 2.0 - 1.0;
  if (kind == 0) {
    // Aizawa
    return vec3f(r1 * 0.75, r2 * 0.75, 0.3 + r3 * 0.65);
  } else if (kind == 1) {
    // Thomas
    return vec3f(r1, r2, r3) * 2.4;
  } else if (kind == 2) {
    // Dadras
    return vec3f(r1, r2, r3) * 3.5;
  } else {
    // Halvorsen
    return vec3f(-1.4, -1.4, -1.4) + vec3f(r1, r2, r3) * 3.2;
  }
}

fn deriv(p: vec3f, kind: i32, chaos: f32) -> vec3f {
  let x = p.x; let y = p.y; let z = p.z;
  if (kind == 0) {
    // Aizawa attractor
    let a = 0.95 + 0.06 * chaos;
    let b = 0.70;
    let c = 0.60;
    let d = 3.50 + 0.35 * chaos;
    let e = 0.25;
    let f = 0.10;
    return vec3f(
      (z - b) * x - d * y,
      d * x + (z - b) * y,
      c + a * z - (z * z * z) / 3.0 - (x * x + y * y) * (1.0 + e * z) + f * z * x * x * x
    );
  } else if (kind == 1) {
    // Thomas cyclically symmetric attractor
    let b = clamp(0.195 - 0.045 * chaos, 0.13, 0.22);
    return vec3f(
      sin(y) - b * x,
      sin(z) - b * y,
      sin(x) - b * z
    ) * 3.2;
  } else if (kind == 2) {
    // Dadras attractor
    let a = 3.0;
    let b = 2.7 + 0.18 * chaos;
    let c = 1.7;
    let d = 2.0;
    let e = 9.0;
    return vec3f(
      y - a * x + b * y * z,
      c * y - x * z + z,
      d * x * y - e * z
    ) * 0.28;
  } else {
    // Halvorsen attractor
    let a = 1.40 + 0.08 * chaos;
    return vec3f(
      -a * x - 4.0 * y - 4.0 * z - y * y,
      -a * y - 4.0 * z - 4.0 * x - z * z,
      -a * z - 4.0 * x - 4.0 * y - x * x
    ) * 0.24;
  }
}

fn max_radius(kind: i32) -> f32 {
  if (kind == 0) { return 3.2; }
  if (kind == 1) { return 7.5; }
  if (kind == 2) { return 18.0; }
  return 18.0;
}

fn clamp_vec(v: vec3f, lim: f32) -> vec3f {
  let l2 = dot(v, v);
  if (!(l2 < lim * lim)) {
    if (l2 > 0.00001) { return v * (lim / sqrt(l2)); }
    return vec3f(0.0);
  }
  return v;
}

@compute @workgroup_size(128)
fn cs_init(@builtin(global_invocation_id) gid: vec3u) {
  let n = u32(u.sim.x);
  let i = gid.x;
  if (i >= n) { return; }
  let kind = i32(round(u.sim.y));
  let p = spawn_pos(i, 1u, kind);
  let age = hash01(i, 97u);
  let seed = hash01(i, 131u);
  let v = clamp_vec(deriv(p, kind, 0.0), 12.0);
  parts[i] = Particle(vec4f(p, age), vec4f(v, seed));
}

@compute @workgroup_size(128)
fn cs_step(@builtin(global_invocation_id) gid: vec3u) {
  let n = u32(u.sim.x);
  let i = gid.x;
  if (i >= n) { return; }

  let kind = i32(round(u.sim.y));
  let bass = u.audio.z;
  let kick = u.audio.w;
  let rms = u.audio.y;
  let mid = u.audio2.x;
  let onset = u.audio2.w;
  let warm = u.extra.y;
  let tick_u = u32(u.extra.x);

  var pt = parts[i];
  var p = pt.pos_age.xyz;
  var age = pt.pos_age.w;
  let seed = pt.vel_seed.w;

  let chaos = u.sim.w * (0.25 + 0.85 * mid + 0.65 * kick) * (1.0 - warm * 0.8);
  let dt_base = 0.0095 * u.sim.z * (0.72 + 0.95 * bass + 0.55 * rms + 0.7 * kick);
  let dt = select(dt_base, 0.015, warm > 0.5);
  let rmax = max_radius(kind);

  // 3 RK2 midpoint substeps for accurate chaotic trajectories
  var vel = pt.vel_seed.xyz;
  for (var s = 0; s < 3; s++) {
    let k1 = clamp_vec(deriv(p, kind, chaos), 16.0);
    let mid_p = p + k1 * (dt * 0.5);
    let k2 = clamp_vec(deriv(mid_p, kind, chaos), 16.0);
    p = p + k2 * dt;
    vel = k2;
  }

  // subtle radial kick impulse on beats
  if (onset > 0.5 && warm < 0.5) {
    let len_p = max(length(p), 0.15);
    p = p + (p / len_p) * (0.045 * u.sim.w * (0.4 + seed));
  }

  age = age + select(0.0022 + 0.003 * rms, 0.0, warm > 0.5);
  let burst_respawn = (onset > 0.5 && warm < 0.5 && ((i + tick_u * 37u) % 24u == 0u));
  let escaped = !(dot(p, p) < rmax * rmax);
  if (escaped || age > 1.0 || burst_respawn) {
    p = spawn_pos(i, tick_u + 7u, kind);
    vel = clamp_vec(deriv(p, kind, chaos), 12.0);
    age = select(0.0, 0.08 * seed, burst_respawn);
  }

  parts[i] = Particle(vec4f(p, age), vec4f(vel, seed));
}
