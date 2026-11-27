// Softened direct-sum N-body (O(N^2), tiled through workgroup memory) around a central mass.
// Disk in the x-z plane, y up. pos: vec4f(xyz, tag), vel: vec4f(xyz, _). G = 1, the particles
// share a total mass of 1. Per step: cs_step (all pairs + the core, symplectic Euler, a gentle
// cooling toward circular orbits so the disk survives minutes of kicks, respawn of escapers).
// cs_init seeds a disk, spiral or ring; cs_kick is the onset: a two-armed radial shove.

struct Sim {
  n: u32, seed: u32, mode: u32, _u: u32,
  dt: f32, eps2: f32, core_m: f32, core_eps2: f32,
  cool: f32, kick: f32, kick_phase: f32, pm: f32,
  escape_r: f32, disk_r: f32, thick: f32, spin: f32,
};
@group(0) @binding(0) var<uniform> sim: Sim;
@group(0) @binding(1) var<storage, read> pin: array<vec4f>;
@group(0) @binding(2) var<storage, read> vin: array<vec4f>;
@group(0) @binding(3) var<storage, read_write> pout: array<vec4f>;
@group(0) @binding(4) var<storage, read_write> vout: array<vec4f>;

const TAU: f32 = 6.28318530718;
const WG: u32 = 256u;
var<workgroup> tile: array<vec4f, 256>;

fn rng(s: ptr<function, u32>) -> f32 {
  *s = *s * 747796405u + 2891336453u;
  var w = ((*s >> ((*s >> 28u) + 4u)) ^ *s) * 277803737u;
  w = (w >> 22u) ^ w;
  return f32(w) / 4294967296.0;
}

fn gauss(s: ptr<function, u32>) -> f32 {
  let u = max(rng(s), 1e-6);
  return sqrt(-2.0 * log(u)) * cos(TAU * rng(s));
}

// mass inside radius r of an exponential disk with scale rd (total 1), plus the core
fn m_enc(r: f32) -> f32 {
  let rd = sim.disk_r * 0.35;
  let x = r / rd;
  return sim.core_m + (1.0 - exp(-x) * (1.0 + x));
}

fn circ(r: f32) -> f32 {
  return sqrt(m_enc(r) * r * r / pow(r * r + sim.eps2 + sim.core_eps2, 1.5));
}

// a fresh disk particle: position and circular velocity
fn spawn(i: u32, s: ptr<function, u32>, mode: u32) -> array<vec4f, 2> {
  let rd = sim.disk_r * 0.35;
  var r = clamp(-rd * log(max(rng(s) * rng(s), 1e-6)), 0.06, sim.disk_r * 2.2);
  var a = rng(s) * TAU;
  if (mode == 1u) {
    // two logarithmic arms, scattered
    let arm = f32(i & 1u) * 3.14159;
    a = arm + log(r / 0.05) * 2.2 + gauss(s) * 0.35;
  } else if (mode == 2u) {
    r = sim.disk_r * (0.75 + 0.12 * gauss(s));
    r = max(r, 0.1);
  }
  let y = gauss(s) * sim.thick * (0.3 + r);
  let p = vec3f(cos(a) * r, y, sin(a) * r);
  let vc = circ(r) * sim.spin;
  let t = vec3f(-sin(a), 0.0, cos(a));
  let v = t * vc * (1.0 + 0.04 * gauss(s)) + vec3f(gauss(s), gauss(s) * 0.3, gauss(s)) * 0.03 * vc;
  let tag = clamp(r / (sim.disk_r * 1.6), 0.0, 1.0);
  return array<vec4f, 2>(vec4f(p, tag), vec4f(v, 0.0));
}

@compute @workgroup_size(256) fn cs_init(@builtin(global_invocation_id) g: vec3u) {
  let i = g.x;
  if (i >= sim.n) { return; }
  var s = h32(i, sim.seed) | 1u;
  let pv = spawn(i, &s, sim.mode);
  pout[i] = pv[0];
  vout[i] = pv[1];
}

@compute @workgroup_size(256) fn cs_kick(@builtin(global_invocation_id) g: vec3u) {
  let i = g.x;
  if (i >= sim.n) { return; }
  let p = pout[i];
  let r = length(p.xz);
  if (r < 1e-4) { return; }
  let rh = p.xz / r;
  let a = atan2(p.z, p.x);
  // two-armed: the shove peaks along a seeded axis, so differential rotation winds it into arms
  let w = 0.35 + 0.65 * (0.5 + 0.5 * cos(2.0 * a - sim.kick_phase));
  var s = h32(i, sim.seed ^ 0x51ed27u) | 1u;
  let dv = sim.kick * w * circ(r) * (0.6 + 0.4 * rng(&s));
  vout[i] += vec4f(rh.x * dv, (rng(&s) - 0.5) * 0.3 * dv, rh.y * dv, 0.0);
}

@compute @workgroup_size(256) fn cs_step(@builtin(global_invocation_id) g: vec3u, @builtin(local_invocation_index) li: u32) {
  let i = g.x;
  let live = i < sim.n;
  let me = pin[min(i, sim.n - 1u)];
  let p = me.xyz;
  var acc = vec3f(0.0);
  let tiles = (sim.n + WG - 1u) / WG;
  for (var t = 0u; t < tiles; t++) {
    let j = t * WG + li;
    tile[li] = select(vec4f(0.0, 0.0, 0.0, 0.0), vec4f(pin[min(j, sim.n - 1u)].xyz, 1.0), j < sim.n);
    workgroupBarrier();
    for (var k = 0u; k < WG; k++) {
      let q = tile[k];
      let d = q.xyz - p;
      let r2 = dot(d, d) + sim.eps2;
      let inv = inverseSqrt(r2);
      acc += d * (q.w * inv * inv * inv);
    }
    workgroupBarrier();
  }
  if (!live) { return; }
  acc *= sim.pm;
  // the core
  let r2c = dot(p, p) + sim.core_eps2;
  let ic = inverseSqrt(r2c);
  acc -= p * (sim.core_m * ic * ic * ic);

  var v = vin[i].xyz + acc * sim.dt;
  // cooling: relax toward the circular orbit the local pull allows (keeps a readable disk)
  let r = length(p.xz);
  if (r > 1e-3) {
    let rh = p.xz / r;
    let ar = max(-dot(acc.xz, rh), 0.0);
    let vc = sqrt(ar * r) * sim.spin;
    let tgt = vec3f(-rh.y * vc, -p.y * 0.5, rh.x * vc);
    v = mix(v, tgt, clamp(sim.cool * sim.dt, 0.0, 1.0));
  }
  let sp = length(v);
  if (sp > 8.0) { v *= 8.0 / sp; }
  var np = p + v * sim.dt;
  var tag = me.w;
  if (!(length(np) < sim.escape_r)) {
    var s = h32(i, sim.seed ^ bitcast<u32>(np.x)) | 1u;
    let pv = spawn(i, &s, 0u);
    np = pv[0].xyz;
    v = pv[1].xyz;
    tag = pv[0].w;
  }
  pout[i] = vec4f(np, tag);
  vout[i] = vec4f(v, 0.0);
}
