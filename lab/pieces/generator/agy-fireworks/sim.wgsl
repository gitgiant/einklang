// Starburst fireworks compute simulation: onset-spawned shells with drag, gravity, and sparkle.

const MAX_PARTICLES: u32 = 16384u;
const PI: f32 = 3.14159265;
const TAU: f32 = 6.28318530;

struct SimU {
  // dt, gravity, time, sparkle_amt
  u0: vec4f,
  // spawn_start, spawn_count, burst_x, burst_y
  u1: vec4f,
  // burst_speed, burst_size, burst_life, burst_shape
  u2: vec4f,
  // burst_seed, loudness, treble, drag_base
  u3: vec4f,
  // primary and secondary linear HDR RGB colors from palette
  col_a: vec4f,
  col_b: vec4f,
};

@group(0) @binding(0) var<uniform> u: SimU;
@group(0) @binding(1) var<storage, read_write> pts: array<vec4f>;

fn h11(n: u32) -> f32 {
  var x = n;
  x = (x ^ 61u) ^ (x >> 16u);
  x = x + (x << 3u);
  x = x ^ (x >> 4u);
  x = x * 0x27d4eb2du;
  x = x ^ (x >> 15u);
  return f32(x) / 4294967296.0;
}

@compute @workgroup_size(128)
fn cs_clear(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if (i >= MAX_PARTICLES) { return; }
  pts[i * 3u + 0u] = vec4f(0.0, 0.0, 0.0, 0.0);
  pts[i * 3u + 1u] = vec4f(0.0, 0.0, 0.0, -1.0);
  pts[i * 3u + 2u] = vec4f(1.0, 1.0, 1.0, 0.0);
}

@compute @workgroup_size(128)
fn cs_step(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if (i >= MAX_PARTICLES) { return; }

  let spawn_count = u32(u.u1.y);
  let spawn_start = u32(u.u1.x);
  var in_spawn = false;
  var local_id: u32 = 0u;

  if (spawn_count > 0u) {
    let dist = (i + MAX_PARTICLES - spawn_start) % MAX_PARTICLES;
    if (dist < spawn_count) {
      in_spawn = true;
      local_id = dist;
    }
  }

  if (in_spawn) {
    let seed = u32(u.u3.x) * 7919u + local_id * 104729u + 17u;
    let r0 = h11(seed);
    let r1 = h11(seed + 1u);
    let r2 = h11(seed + 2u);
    let r3 = h11(seed + 3u);
    let r4 = h11(seed + 4u);

    let shape = i32(u.u2.w + 0.5);
    let base_spd = u.u2.x;
    let base_size = u.u2.y;
    let base_life = u.u2.z;
    let drag_base = u.u3.w;

    var dir = vec2f(cos(r0 * TAU), sin(r0 * TAU));
    var spd = base_spd;
    var life = base_life * (0.78 + 0.44 * r2);
    var size = base_size * (0.75 + 0.55 * r3);
    var drag = drag_base * (0.85 + 0.35 * r4);
    var col = mix(u.col_a.rgb, u.col_b.rgb, r1 * 0.45);

    // 10% bright inner pistil/core sparks for explosive onset punch
    let frac = f32(local_id) / max(1.0, f32(spawn_count));
    if (frac < 0.11) {
      let a = r0 * TAU;
      let rad = sqrt(r1) * 0.38;
      dir = vec2f(cos(a), sin(a));
      spd = base_spd * (0.2 + rad);
      life = base_life * (0.45 + 0.35 * r2);
      size = base_size * 1.25;
      col = mix(u.col_b.rgb, vec3f(1.0, 0.96, 0.88), 0.55);
    } else if (shape == 0) {
      // Chrysanthemum: 3D spherical shell projected to 2D
      let cos_t = 2.0 * r1 - 1.0;
      let sin_t = sqrt(max(0.0, 1.0 - cos_t * cos_t));
      let phi = r0 * TAU;
      let v3 = vec3f(sin_t * cos(phi), cos_t, sin_t * sin(phi));
      dir = v3.xy;
      let shell = 0.72 + 0.34 * r2;
      spd = base_spd * shell;
      col = mix(u.col_a.rgb, u.col_b.rgb, clamp(0.5 + 0.5 * v3.z, 0.0, 1.0));
    } else if (shape == 1) {
      // Willow: heavy drooping arcs, longer life, golden-tinted tails
      let cos_t = 2.0 * r1 - 1.0;
      let sin_t = sqrt(max(0.0, 1.0 - cos_t * cos_t));
      let phi = r0 * TAU;
      dir = vec2f(sin_t * cos(phi), cos_t);
      spd = base_spd * (0.65 + 0.45 * r2);
      life = base_life * (1.2 + 0.45 * r3);
      drag = drag_base * 0.68;
      col = mix(u.col_a.rgb, vec3f(1.0, 0.78, 0.35), 0.38);
    } else if (shape == 2) {
      // Tilted ring / Saturn halo
      let a = r0 * TAU;
      let tilt = 0.42 + 0.38 * h11(u32(u.u3.x) * 31u + 5u);
      let rot = h11(u32(u.u3.x) * 97u + 3u) * PI;
      let rx = cos(a);
      let ry = sin(a) * tilt;
      let cr = cos(rot);
      let sr = sin(rot);
      dir = vec2f(rx * cr - ry * sr, rx * sr + ry * cr);
      spd = base_spd * (0.94 + 0.14 * r1);
      col = mix(u.col_a.rgb, u.col_b.rgb, 0.5 + 0.5 * sin(a * 2.0));
    } else if (shape == 3) {
      // Double concentric peony
      let is_inner = frac < 0.48;
      let cos_t = 2.0 * r1 - 1.0;
      let sin_t = sqrt(max(0.0, 1.0 - cos_t * cos_t));
      let phi = r0 * TAU;
      dir = vec2f(sin_t * cos(phi), cos_t);
      if (is_inner) {
        spd = base_spd * (0.48 + 0.14 * r2);
        col = u.col_b.rgb * 1.15;
        life = base_life * (0.75 + 0.25 * r3);
      } else {
        spd = base_spd * (0.92 + 0.2 * r2);
        col = u.col_a.rgb;
      }
    } else {
      // Starburst / palm spokes
      let spokes = 9.0 + floor(h11(u32(u.u3.x) * 53u + 11u) * 5.0);
      let spoke_i = floor(r0 * spokes);
      let base_ang = (spoke_i / spokes) * TAU + h11(u32(u.u3.x) * 19u) * 0.5;
      let spread = (r1 - 0.5) * 0.16;
      dir = vec2f(cos(base_ang + spread), sin(base_ang + spread));
      spd = base_spd * (0.35 + 0.85 * pow(r2, 0.65));
      size = base_size * (0.8 + 0.6 * r2);
      col = mix(u.col_b.rgb, u.col_a.rgb, r2);
    }

    let origin = vec2f(u.u1.z, u.u1.w);
    let vel = dir * spd;
    // Slight initial upward lift so bursts arc naturally before falling
    let vel_lifted = vec2f(vel.x, vel.y + 0.12 * base_spd);
    let start_pos = origin + dir * (0.008 * r4);

    pts[i * 3u + 0u] = vec4f(start_pos, vel_lifted);
    pts[i * 3u + 1u] = vec4f(col, 0.0);
    pts[i * 3u + 2u] = vec4f(life, size, drag, r4);
    return;
  }

  let p1 = pts[i * 3u + 1u];
  let age = p1.w;
  if (age < 0.0) { return; }

  let dt = u.u0.x;
  let gravity = u.u0.y;
  let p2 = pts[i * 3u + 2u];
  let max_life = p2.x;
  let next_age = age + dt;

  if (next_age >= max_life) {
    pts[i * 3u + 1u] = vec4f(p1.rgb, -1.0);
    return;
  }

  let p0 = pts[i * 3u + 0u];
  var pos = p0.xy;
  var vel = p0.zw;
  let drag = p2.z;

  // Air resistance + gravity arc
  vel = vel * exp(-drag * dt);
  vel.y = vel.y - gravity * dt;
  pos = pos + vel * dt;

  pts[i * 3u + 0u] = vec4f(pos, vel);
  pts[i * 3u + 1u] = vec4f(p1.rgb, next_age);
}
