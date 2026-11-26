// Boids on a uniform grid. World: x 0..aspect, y 0..1 (screen heights). Boid: vec4f(pos.xy, vel.xy).
// Per step: cs_clear zeroes the cell counters, cs_bin drops each boid into its cell (up to CAP slots),
// cs_step reads the 3x3 cells around each boid (from src) and writes the new boid to dst.
// Separation, alignment and cohesion within `radius`, soft walls, a pull toward a roaming attractor,
// and an onset scatter (push away from a point).

struct Sim {
  n: u32, gw: u32, gh: u32, _p0: u32,
  aspect: f32, radius: f32, cell: f32, dt: f32,
  sep: f32, ali: f32, coh: f32, speed: f32,
  attract: vec2f, pull: f32, wall: f32,
  scatter_c: vec2f, scatter: f32, sep_r: f32,
};
@group(0) @binding(0) var<uniform> sim: Sim;
@group(0) @binding(1) var<storage, read> src: array<vec4f>;
@group(0) @binding(2) var<storage, read_write> dst: array<vec4f>;
@group(0) @binding(3) var<storage, read_write> counts: array<atomic<u32>>;
@group(0) @binding(4) var<storage, read_write> slots: array<u32>;

const CAP: u32 = 24u;

fn cell_of(p: vec2f) -> vec2i {
  return clamp(vec2i(floor(p / sim.cell)), vec2i(0), vec2i(i32(sim.gw) - 1, i32(sim.gh) - 1));
}

@compute @workgroup_size(256) fn cs_clear(@builtin(global_invocation_id) g: vec3u) {
  if (g.x < sim.gw * sim.gh) { atomicStore(&counts[g.x], 0u); }
}

@compute @workgroup_size(256) fn cs_bin(@builtin(global_invocation_id) g: vec3u) {
  let i = g.x;
  if (i >= sim.n) { return; }
  let c = cell_of(src[i].xy);
  let ci = u32(c.y) * sim.gw + u32(c.x);
  let k = atomicAdd(&counts[ci], 1u);
  if (k < CAP) { slots[ci * CAP + k] = i; }
}

@compute @workgroup_size(256) fn cs_step(@builtin(global_invocation_id) g: vec3u) {
  let i = g.x;
  if (i >= sim.n) { return; }
  let b = src[i];
  let p = b.xy;
  let v = b.zw;
  let c = cell_of(p);
  var sep = vec2f(0.0);
  var ali = vec2f(0.0);
  var cen = vec2f(0.0);
  var wsum = 0.0;
  let r2 = sim.radius * sim.radius;
  let s2 = sim.sep_r * sim.sep_r;
  for (var dy = -1; dy <= 1; dy++) {
    for (var dx = -1; dx <= 1; dx++) {
      let q = c + vec2i(dx, dy);
      if (q.x < 0 || q.y < 0 || q.x >= i32(sim.gw) || q.y >= i32(sim.gh)) { continue; }
      let ci = u32(q.y) * sim.gw + u32(q.x);
      let cnt = atomicLoad(&counts[ci]);
      let m = min(cnt, CAP);
      // an overfull cell is sampled: weight what we see up to the true count
      let wgt = f32(cnt) / f32(max(m, 1u));
      for (var k = 0u; k < m; k++) {
        let j = slots[ci * CAP + k];
        if (j == i) { continue; }
        let o = src[j];
        let d = o.xy - p;
        let dd = dot(d, d);
        if (dd > r2 || dd < 1e-12) { continue; }
        ali += o.zw * wgt;
        cen += o.xy * wgt;
        wsum += wgt;
        if (dd < s2) { let dl = sqrt(dd); sep -= d / dl * (1.0 - dl / sim.sep_r) * wgt; }
      }
    }
  }
  var acc = vec2f(0.0);
  if (wsum > 0.0) {
    let sp = sim.speed;
    acc += (ali / wsum - v) * sim.ali;
    acc += (cen / wsum - p) * sim.coh;
    acc += sep * sim.sep * sp;
  }
  // roaming attractor keeps the flock on screen and wheeling
  let ta = sim.attract - p;
  acc += ta * sim.pull / (0.15 + length(ta));
  // soft walls
  let m = 0.08;
  let wx = smoothstep(m, 0.0, p.x) - smoothstep(sim.aspect - m, sim.aspect, p.x);
  let wy = smoothstep(m, 0.0, p.y) - smoothstep(1.0 - m, 1.0, p.y);
  acc += vec2f(wx, wy) * sim.wall;
  // onset scatter: an outward kick that falls off with distance
  if (sim.scatter > 0.0) {
    let e = p - sim.scatter_c;
    let el = max(length(e), 1e-4);
    acc += e / el * sim.scatter * exp(-el * 3.0);
  }
  var nv = v + acc * sim.dt;
  // cruise speed: boids keep within 0.6x..1.6x of it
  let l = max(length(nv), 1e-6);
  nv = nv / l * clamp(l, sim.speed * 0.6, sim.speed * 1.6);
  var np = p + nv * sim.dt;
  np = clamp(np, vec2f(0.001), vec2f(sim.aspect - 0.001, 0.999));
  dst[i] = vec4f(np, nv);
}

@compute @workgroup_size(256) fn cs_init(@builtin(global_invocation_id) g: vec3u) {
  let i = g.x;
  if (i >= sim.n) { return; }
  let h1 = f32(h32(i, sim._p0)) / 4294967296.0;
  let h2 = f32(h32(i, sim._p0 + 1u)) / 4294967296.0;
  let h3 = f32(h32(i, sim._p0 + 2u)) / 4294967296.0;
  let a = h1 * 6.2831853;
  let r = sqrt(h2) * 0.35;
  let p = vec2f(sim.aspect * 0.5, 0.5) + vec2f(cos(a) * 1.4, sin(a)) * r;
  let va = a + 1.5708 + (h3 - 0.5) * 0.8;
  dst[i] = vec4f(p, vec2f(cos(va), sin(va)) * sim.speed);
}
