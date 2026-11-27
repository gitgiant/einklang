// SPH liquid in the tank's own frame (x 0..tw, y 0..th, y up), Clavet-style double density
// relaxation run in parallel (Jacobi): predict, bin into a uniform grid, density + near density,
// relax positions against both pressures, collide with the walls and the bass paddle, and take the
// velocity from the position change. Tilt and shake enter as the tank-frame gravity plus inertial
// accelerations (translation and the Euler force of a turning tank), so the walls never move.

struct Sim {
  n: u32, gx: u32, gy: u32, maxper: u32,
  dt: f32, h: f32, rho0: f32, k: f32,
  kn: f32, visc: f32, tw: f32, th: f32,
  acc: vec2f, alpha: f32, paddle: f32,
  splash: vec4f, // centre x, y, radius, strength
  vmax: f32, wall: f32, ceil: f32, seed: u32,
  cols: f32, sp: f32, pivx: f32, pivy: f32,
};
@group(0) @binding(0) var<uniform> S: Sim;
@group(0) @binding(1) var<storage, read_write> P: array<vec4f>;   // pos.xy vel.xy
@group(0) @binding(2) var<storage, read_write> X: array<vec2f>;   // predicted pos
@group(0) @binding(3) var<storage, read_write> D: array<vec4f>;   // pressure, near pressure, viscosity dv.xy
@group(0) @binding(4) var<storage, read_write> counts: array<atomic<u32>>;
@group(0) @binding(5) var<storage, read_write> cells: array<u32>;

fn rnd(i: u32, k: u32) -> f32 { return f32(h32(i ^ S.seed, k) >> 8u) / 16777216.0; }

fn cell_of(p: vec2f) -> vec2i {
  return clamp(vec2i(floor(p / S.h)), vec2i(0), vec2i(i32(S.gx) - 1, i32(S.gy) - 1));
}

@compute @workgroup_size(128) fn cs_init(@builtin(global_invocation_id) id: vec3u) {
  let i = id.x;
  if (i >= S.n) { return; }
  // dam break: a block against the left wall, slightly jittered
  let cols = u32(S.cols);
  let cx = f32(i % cols);
  let cy = f32(i / cols);
  let j = vec2f(rnd(i, 1u), rnd(i, 2u)) - 0.5;
  let p = vec2f(S.sp * (cx + 0.5 + 0.3 * j.x) + S.wall, S.sp * (cy + 0.5 + 0.3 * j.y) + S.wall);
  P[i] = vec4f(p, 0.0, 0.0);
}

@compute @workgroup_size(128) fn cs_predict(@builtin(global_invocation_id) id: vec3u) {
  let i = id.x;
  if (i >= S.n) { return; }
  let p = P[i];
  var v = p.zw;
  let r = p.xy - vec2f(S.pivx, S.pivy);
  // gravity + translation inertia, then the Euler force of the turning tank (alpha ccw)
  v += (S.acc + S.alpha * vec2f(r.y, -r.x)) * S.dt;
  P[i] = vec4f(p.xy, v);
  X[i] = p.xy + v * S.dt;
}

// an onset: a crown splash, everything near a point under the surface thrown up and out
@compute @workgroup_size(128) fn cs_splash(@builtin(global_invocation_id) id: vec3u) {
  let i = id.x;
  if (i >= S.n) { return; }
  let p = P[i];
  let d = p.xy - S.splash.xy;
  let d2 = dot(d, d);
  let R2 = S.splash.z * S.splash.z;
  if (d2 >= R2) { return; }
  let w = (1.0 - d2 / R2) * S.splash.w;
  let l = sqrt(d2) + 1e-4;
  P[i] = vec4f(p.xy, p.zw + vec2f(d.x / l * w * 0.6, abs(d.y / l) * w + 0.5 * w));
}

@compute @workgroup_size(128) fn cs_clear(@builtin(global_invocation_id) id: vec3u) {
  if (id.x < S.gx * S.gy) { atomicStore(&counts[id.x], 0u); }
}

@compute @workgroup_size(128) fn cs_bin(@builtin(global_invocation_id) id: vec3u) {
  let i = id.x;
  if (i >= S.n) { return; }
  let c = cell_of(X[i]);
  let ci = u32(c.y) * S.gx + u32(c.x);
  let k = atomicAdd(&counts[ci], 1u);
  if (k < S.maxper) { cells[ci * S.maxper + k] = i; }
}

@compute @workgroup_size(128) fn cs_density(@builtin(global_invocation_id) id: vec3u) {
  let i = id.x;
  if (i >= S.n) { return; }
  let xi = X[i];
  let vi = P[i].zw;
  let c = cell_of(xi);
  var rho = 0.0;
  var rn = 0.0;
  var ws = 0.0;
  var dv = vec2f(0.0);
  let h2 = S.h * S.h;
  for (var y = max(c.y - 1, 0); y <= min(c.y + 1, i32(S.gy) - 1); y++) {
    for (var x = max(c.x - 1, 0); x <= min(c.x + 1, i32(S.gx) - 1); x++) {
      let ci = u32(y) * S.gx + u32(x);
      let m = min(atomicLoad(&counts[ci]), S.maxper);
      for (var k = 0u; k < m; k++) {
        let j = cells[ci * S.maxper + k];
        if (j == i) { continue; }
        let d = X[j] - xi;
        let r2 = dot(d, d);
        if (r2 >= h2) { continue; }
        let q = 1.0 - sqrt(r2) / S.h;
        rho += q * q;
        rn += q * q * q;
        ws += q;
        dv += (P[j].zw - vi) * q;
      }
    }
  }
  D[i] = vec4f(S.k * (rho - S.rho0), S.kn * rn, select(vec2f(0.0), dv / ws, ws > 0.0));
}

@compute @workgroup_size(128) fn cs_relax(@builtin(global_invocation_id) id: vec3u) {
  let i = id.x;
  if (i >= S.n) { return; }
  let xi = X[i];
  let di = D[i];
  let c = cell_of(xi);
  var dx = vec2f(0.0);
  let h2 = S.h * S.h;
  let dt2 = S.dt * S.dt;
  for (var y = max(c.y - 1, 0); y <= min(c.y + 1, i32(S.gy) - 1); y++) {
    for (var x = max(c.x - 1, 0); x <= min(c.x + 1, i32(S.gx) - 1); x++) {
      let ci = u32(y) * S.gx + u32(x);
      let m = min(atomicLoad(&counts[ci]), S.maxper);
      for (var k = 0u; k < m; k++) {
        let j = cells[ci * S.maxper + k];
        if (j == i) { continue; }
        let d = X[j] - xi;
        let r2 = dot(d, d);
        if (r2 >= h2 || r2 < 1e-12) { continue; }
        let r = sqrt(r2);
        let q = 1.0 - r / S.h;
        let dj = D[j];
        let m2 = dt2 * (0.5 * (di.x + dj.x) * q + 0.5 * (di.y + dj.y) * q * q);
        dx -= m2 * d / r;
      }
    }
  }
  var p = xi + dx * 0.5;
  let lo = max(S.wall, S.paddle);
  p = clamp(p, vec2f(lo, S.wall), vec2f(S.tw - S.wall, S.ceil - S.wall));
  let old = P[i].xy;
  var v = (p - old) / S.dt + S.visc * di.zw;
  let sp = length(v);
  if (sp > S.vmax) { v *= S.vmax / sp; }
  P[i] = vec4f(p, v);
}
