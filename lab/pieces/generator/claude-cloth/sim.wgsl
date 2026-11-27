// Cloth: a cols x rows grid of verlet particles in world space (y up). pos: vec4f(xyz, pinned).
// cs_integrate: gravity + aerodynamic wind (force along the local normal, by how squarely the
// relative wind hits it) + verlet with damping; pinned points snap to their rest spot.
// cs_relax: one Jacobi pass over structural, shear and bend distance constraints.

struct Sim {
  grid: vec2u, mode: u32, _u: u32,
  dt: f32, damp: f32, spacing: f32, relax: f32,
  wind: vec3f, aero: f32,
  gust_dir: vec3f, turb: f32,
  time: f32, freq: f32, drag: f32, gravity: f32,
};
@group(0) @binding(0) var<uniform> sim: Sim;
@group(0) @binding(1) var<storage, read> pin: array<vec4f>;
@group(0) @binding(2) var<storage, read_write> pout: array<vec4f>;
@group(0) @binding(3) var<storage, read_write> prev: array<vec4f>;
@group(0) @binding(4) var<storage, read> rest: array<vec4f>;

fn at(x: i32, y: i32) -> vec3f {
  let w = i32(sim.grid.x);
  let h = i32(sim.grid.y);
  return pin[u32(clamp(y, 0, h - 1) * w + clamp(x, 0, w - 1))].xyz;
}

fn hash3(p: vec3f) -> f32 {
  let q = fract(p * vec3f(0.1031, 0.1030, 0.0973));
  let r = q + dot(q, q.yxz + 33.33);
  return fract((r.x + r.y) * r.z);
}

fn vnoise(p: vec3f) -> f32 {
  let i = floor(p);
  let f = p - i;
  let u = f * f * (3.0 - 2.0 * f);
  let a = mix(mix(hash3(i), hash3(i + vec3f(1, 0, 0)), u.x), mix(hash3(i + vec3f(0, 1, 0)), hash3(i + vec3f(1, 1, 0)), u.x), u.y);
  let b = mix(mix(hash3(i + vec3f(0, 0, 1)), hash3(i + vec3f(1, 0, 1)), u.x), mix(hash3(i + vec3f(0, 1, 1)), hash3(i + vec3f(1, 1, 1)), u.x), u.y);
  return mix(a, b, u.z) * 2.0 - 1.0;
}

@compute @workgroup_size(8, 8) fn cs_integrate(@builtin(global_invocation_id) g: vec3u) {
  if (g.x >= sim.grid.x || g.y >= sim.grid.y) { return; }
  let x = i32(g.x);
  let y = i32(g.y);
  let i = g.y * sim.grid.x + g.x;
  let p4 = pin[i];
  if (rest[i].w > 0.5) {
    pout[i] = rest[i];
    prev[i] = rest[i];
    return;
  }
  let p = p4.xyz;
  let o = prev[i].xyz;
  let vel = (p - o) / sim.dt;
  // local normal from the neighbours
  let tu = at(x + 1, y) - at(x - 1, y);
  let tv = at(x, y + 1) - at(x, y - 1);
  var n = cross(tu, tv);
  let nl = length(n);
  n = select(vec3f(0.0, 0.0, 1.0), n / nl, nl > 1e-8);
  // wind: steady stream + travelling turbulence (frozen noise blown along the wind) + gusts
  let flow = sim.wind + sim.gust_dir;
  let adv = p * sim.freq - flow * sim.time * sim.freq * 0.35;
  let turb = vec3f(vnoise(adv), vnoise(adv + vec3f(17.1, 3.7, 9.2)), vnoise(adv + vec3f(5.3, 29.9, 13.4)));
  let w = flow + turb * sim.turb * (0.5 + length(flow) * 0.25);
  let rel = w - vel;
  let a = n * dot(n, rel) * sim.aero + rel * sim.drag + vec3f(0.0, -sim.gravity, 0.0);
  let np = p + (p - o) * sim.damp + a * sim.dt * sim.dt;
  prev[i] = vec4f(p, 0.0);
  pout[i] = vec4f(np, 0.0);
}

fn pull(p: vec3f, q: vec3f, rl: f32, w: f32, acc: ptr<function, vec4f>) {
  let d = q - p;
  let l = length(d);
  if (l > 1e-6) {
    *acc += vec4f(d * ((l - rl) / l) * 0.5 * w, w);
  }
}

@compute @workgroup_size(8, 8) fn cs_relax(@builtin(global_invocation_id) g: vec3u) {
  if (g.x >= sim.grid.x || g.y >= sim.grid.y) { return; }
  let x = i32(g.x);
  let y = i32(g.y);
  let W = i32(sim.grid.x);
  let H = i32(sim.grid.y);
  let i = g.y * sim.grid.x + g.x;
  if (rest[i].w > 0.5) { pout[i] = rest[i]; return; }
  let p = pin[i].xyz;
  let h = sim.spacing;
  var acc = vec4f(0.0);
  // structural
  if (x > 0) { pull(p, at(x - 1, y), h, 1.0, &acc); }
  if (x < W - 1) { pull(p, at(x + 1, y), h, 1.0, &acc); }
  if (y > 0) { pull(p, at(x, y - 1), h, 1.0, &acc); }
  if (y < H - 1) { pull(p, at(x, y + 1), h, 1.0, &acc); }
  // shear
  let hd = h * 1.41421356;
  if (x > 0 && y > 0) { pull(p, at(x - 1, y - 1), hd, 0.5, &acc); }
  if (x < W - 1 && y > 0) { pull(p, at(x + 1, y - 1), hd, 0.5, &acc); }
  if (x > 0 && y < H - 1) { pull(p, at(x - 1, y + 1), hd, 0.5, &acc); }
  if (x < W - 1 && y < H - 1) { pull(p, at(x + 1, y + 1), hd, 0.5, &acc); }
  // bend (two apart): keeps it from crumpling like tissue
  if (x > 1) { pull(p, at(x - 2, y), h * 2.0, 0.25, &acc); }
  if (x < W - 2) { pull(p, at(x + 2, y), h * 2.0, 0.25, &acc); }
  if (y > 1) { pull(p, at(x, y - 2), h * 2.0, 0.25, &acc); }
  if (y < H - 2) { pull(p, at(x, y + 2), h * 2.0, 0.25, &acc); }
  let np = p + acc.xyz * (sim.relax / max(acc.w, 1.0)) * 2.0;
  pout[i] = vec4f(np, 0.0);
}
