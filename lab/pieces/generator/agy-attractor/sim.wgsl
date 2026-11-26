// Strange attractors compute pass: seeds and steps Lorenz, Clifford, and Peter de Jong particles.

struct SimU {
  // count, kind (0=lorenz, 1=clifford, 2=dejong), speed, morph
  a: vec4f,
  // time, bass, mid, high
  b: vec4f,
  // rms, kick, tickSeed, dt
  c: vec4f,
  // attractor params (sigma, rho, beta, 0) or (a, b, c, d)
  p: vec4f,
};

@group(0) @binding(0) var<uniform> sim: SimU;
// Per particle: [i*2] = (x, y, z, colorMetric), [i*2+1] = (prevX, prevY, prevZ, age)
@group(0) @binding(1) var<storage, read_write> pts: array<vec4f>;

fn rand01(a: u32, b: u32) -> f32 {
  return f32(h32(a, b) & 0x00ffffffu) / f32(0x01000000u);
}

fn lorenz_deriv(p: vec3f) -> vec3f {
  let sigma = sim.p.x;
  let rho = sim.p.y;
  let beta = sim.p.z;
  return vec3f(
    sigma * (p.y - p.x),
    p.x * (rho - p.z) - p.y,
    p.x * p.y - beta * p.z,
  );
}

fn lorenz_rk2(p: vec3f, dt: f32) -> vec3f {
  let k1 = lorenz_deriv(p);
  let mid = p + k1 * (0.5 * dt);
  let k2 = lorenz_deriv(mid);
  return p + k2 * dt;
}

fn clifford_step(p: vec3f) -> vec3f {
  let a = sim.p.x;
  let b = sim.p.y;
  let c = sim.p.z;
  let d = sim.p.w;
  let nx = sin(a * p.y) + c * cos(a * p.x);
  let ny = sin(b * p.x) + d * cos(b * p.y);
  let nz = 0.55 * sin(c * p.x - d * p.y) + 0.35 * cos(a * p.y + b * p.x);
  return vec3f(nx, ny, nz);
}

fn dejong_step(p: vec3f) -> vec3f {
  let a = sim.p.x;
  let b = sim.p.y;
  let c = sim.p.z;
  let d = sim.p.w;
  let nx = sin(a * p.y) - cos(b * p.x);
  let ny = sin(c * p.x) - cos(d * p.y);
  let nz = 0.48 * (sin(b * p.y - c * p.x) - cos(a * p.x - d * p.y));
  return vec3f(nx, ny, nz);
}

fn spawn_particle(id: u32, salt: u32, kind: i32) -> vec4f {
  let r0 = rand01(id, salt * 31u + 1u);
  let r1 = rand01(id, salt * 31u + 7u);
  let r2 = rand01(id, salt * 31u + 13u);
  if (kind == 0) {
    // Seed near both Lorenz butterfly wings and warm up onto the attractor
    let side = select(-1.0, 1.0, r0 > 0.5);
    var p = vec3f(side * (6.0 + r1 * 8.0), side * (5.0 + r2 * 9.0), 18.0 + fract(r0 * 7.3) * 16.0);
    for (var k = 0; k < 44; k++) {
      p = lorenz_rk2(p, 0.008);
    }
    let spd = clamp(length(lorenz_deriv(p)) / 140.0, 0.0, 1.0);
    return vec4f(p, spd);
  }
  var p = vec3f((r0 - 0.5) * 3.2, (r1 - 0.5) * 3.2, (r2 - 0.5) * 1.4);
  var prev = p;
  for (var k = 0; k < 14; k++) {
    prev = p;
    p = select(dejong_step(p), clifford_step(p), kind == 1);
  }
  let metric = clamp(length(p.xy - prev.xy) * 0.34, 0.0, 1.0);
  return vec4f(p, metric);
}

@compute @workgroup_size(256)
fn cs_seed(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if (i >= u32(sim.a.x)) { return; }
  let kind = i32(sim.a.y);
  let s = spawn_particle(i, 1u, kind);
  let age = rand01(i, 997u);
  pts[i * 2u] = s;
  pts[i * 2u + 1u] = vec4f(s.xyz, age);
}

@compute @workgroup_size(256)
fn cs_step(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if (i >= u32(sim.a.x)) { return; }
  let kind = i32(sim.a.y);
  let cur4 = pts[i * 2u];
  let info = pts[i * 2u + 1u];
  var p = cur4.xyz;
  var age = info.w;
  let tick_salt = u32(sim.c.z) + 17u;

  if (kind == 0) {
    let dt = sim.c.w;
    let prev = p;
    p = lorenz_rk2(p, dt);
    p = lorenz_rk2(p, dt);
    age += 0.0028 * sim.a.z;
    let bad = !all(p == p) || length(p) > 95.0 || age > 1.0;
    if (bad) {
      let sp = spawn_particle(i, tick_salt, 0);
      pts[i * 2u] = sp;
      pts[i * 2u + 1u] = vec4f(sp.xyz, 0.0);
      return;
    }
    let vel = length(p - prev) / max(dt * 2.0, 1e-4);
    let metric = clamp(vel / 135.0, 0.0, 1.0);
    pts[i * 2u] = vec4f(p, metric);
    pts[i * 2u + 1u] = vec4f(prev, age);
  } else {
    let prev = p;
    p = select(dejong_step(p), clifford_step(p), kind == 1);
    age += 0.006 * sim.a.z;
    let jump = length(p.xy - prev.xy);
    let bad = !all(p == p) || length(p) > 8.0 || jump < 0.005 || age > 1.0;
    if (bad) {
      let sp = spawn_particle(i, tick_salt, kind);
      pts[i * 2u] = sp;
      pts[i * 2u + 1u] = vec4f(sp.xyz, 0.0);
      return;
    }
    let metric = clamp(jump * 0.34, 0.0, 1.0);
    pts[i * 2u] = vec4f(p, metric);
    pts[i * 2u + 1u] = vec4f(prev, age);
  }
}
