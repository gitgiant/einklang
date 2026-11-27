// Picture swarm: a big flock on a coarse grid. World: x 0..aspect, y 0..1 (screen heights), y down.
// Particle: vec4f(pos.xy, vel.xy). Per step: cs_clear zeroes the grid sums, cs_splat adds every bird's
// count and velocity to its cell (fixed point atomics), cs_resolve turns the sums into a smoothed
// (density, mean velocity) grid, cs_step flies every bird: alignment to the local mean velocity,
// cohesion / separation along the density gradient, a pull toward the picture's bright parts (eight
// luma sensors around it), a noise wander, soft walls and the onset scatter; then it eases to a
// cruising speed that the bright parts slow, so the flock lingers there and paints the picture.

struct Sim {
  n: u32, gw: u32, gh: u32, seed: u32,
  aspect: f32, dt: f32, cruise: f32, ali: f32,
  coh: f32, sep: f32, food: f32, reach: f32,
  wander: f32, time: f32, settle: f32, has_luma: f32,
  scatter_c: vec2f, scatter_r: f32, scatter: f32,
  gamma: f32, per_cell: f32, _a: f32, _b: f32,
};
@group(0) @binding(0) var<uniform> sim: Sim;
@group(0) @binding(1) var<storage, read_write> birds: array<vec4f>;
@group(0) @binding(2) var<storage, read_write> sums: array<atomic<i32>>;
@group(0) @binding(3) var<storage, read_write> grid: array<vec4f>;
@group(0) @binding(4) var smp: sampler;
@group(0) @binding(5) var tluma: texture_2d<f32>;
@group(0) @binding(6) var tpic: texture_2d<f32>;

const FIX: f32 = 1024.0;
const TAU: f32 = 6.28318530718;

fn rnd(i: u32, k: u32) -> f32 { return f32(h32(i, sim.seed ^ k)) / 4294967296.0; }

fn cell_of(p: vec2f) -> vec2i {
  return clamp(vec2i(floor(p * f32(sim.gh))), vec2i(0), vec2i(i32(sim.gw) - 1, i32(sim.gh) - 1));
}

fn gidx(c: vec2i) -> u32 {
  let q = clamp(c, vec2i(0), vec2i(i32(sim.gw) - 1, i32(sim.gh) - 1));
  return u32(q.y) * sim.gw + u32(q.x);
}

fn bright(p: vec2f) -> f32 {
  let uv = clamp(vec2f(p.x / sim.aspect, p.y), vec2f(0.0), vec2f(1.0));
  var l: f32;
  if (sim.has_luma > 0.5) { l = textureSampleLevel(tluma, smp, uv, 0.0).r; }
  else { l = dot(min(textureSampleLevel(tpic, smp, uv, 0.0).rgb, vec3f(2.0)), vec3f(0.2126, 0.7152, 0.0722)); }
  return pow(clamp(l, 0.0, 1.0), sim.gamma);
}

// the resolved grid, bilinear (cell centres at (i + 0.5) / gh)
fn field(p: vec2f) -> vec4f {
  let q = p * f32(sim.gh) - 0.5;
  let i = vec2i(floor(q));
  let f = q - floor(q);
  return mix(mix(grid[gidx(i)], grid[gidx(i + vec2i(1, 0))], f.x), mix(grid[gidx(i + vec2i(0, 1))], grid[gidx(i + vec2i(1, 1))], f.x), f.y);
}

// smooth value noise for the wander
fn vnoise(p: vec2f) -> f32 {
  let i = vec2i(floor(p));
  let f = p - floor(p);
  let u = f * f * (3.0 - 2.0 * f);
  let a = f32(h32(u32(i.x + 4096), u32(i.y + 4096))) / 4294967296.0;
  let b = f32(h32(u32(i.x + 4097), u32(i.y + 4096))) / 4294967296.0;
  let c = f32(h32(u32(i.x + 4096), u32(i.y + 4097))) / 4294967296.0;
  let d = f32(h32(u32(i.x + 4097), u32(i.y + 4097))) / 4294967296.0;
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

@compute @workgroup_size(256) fn cs_init(@builtin(global_invocation_id) g: vec3u) {
  let i = g.x;
  if (i >= sim.n) { return; }
  let p = vec2f(rnd(i, 1u) * sim.aspect, rnd(i, 2u));
  let a = rnd(i, 3u) * TAU;
  birds[i] = vec4f(p, vec2f(cos(a), sin(a)) * sim.cruise);
}

@compute @workgroup_size(256) fn cs_clear(@builtin(global_invocation_id) g: vec3u) {
  if (g.x < sim.gw * sim.gh * 3u) { atomicStore(&sums[g.x], 0); }
}

@compute @workgroup_size(256) fn cs_splat(@builtin(global_invocation_id) g: vec3u) {
  let i = g.x;
  if (i >= sim.n) { return; }
  let b = birds[i];
  let k = gidx(cell_of(b.xy)) * 3u;
  atomicAdd(&sums[k], 1);
  atomicAdd(&sums[k + 1u], i32(clamp(b.z, -8.0, 8.0) * FIX));
  atomicAdd(&sums[k + 2u], i32(clamp(b.w, -8.0, 8.0) * FIX));
}

@compute @workgroup_size(16, 16) fn cs_resolve(@builtin(global_invocation_id) g: vec3u) {
  if (g.x >= sim.gw || g.y >= sim.gh) { return; }
  var cnt = 0.0;
  var vel = vec2f(0.0);
  var wsum = 0.0;
  for (var dy = -1; dy <= 1; dy++) {
    for (var dx = -1; dx <= 1; dx++) {
      let c = vec2i(i32(g.x) + dx, i32(g.y) + dy);
      if (c.x < 0 || c.y < 0 || c.x >= i32(sim.gw) || c.y >= i32(sim.gh)) { continue; }
      let w = f32((2 - abs(dx)) * (2 - abs(dy)));
      let k = gidx(c) * 3u;
      cnt += w * f32(atomicLoad(&sums[k]));
      vel += w * vec2f(f32(atomicLoad(&sums[k + 1u])), f32(atomicLoad(&sums[k + 2u]))) / FIX;
      wsum += w;
    }
  }
  // density 1 = an even spread; mean velocity of the birds around
  grid[g.y * sim.gw + g.x] = vec4f(cnt / wsum / sim.per_cell, vel / max(cnt, 1.0), 0.0);
}

@compute @workgroup_size(256) fn cs_step(@builtin(global_invocation_id) g: vec3u) {
  let i = g.x;
  if (i >= sim.n) { return; }
  let b = birds[i];
  var p = b.xy;
  var v = b.zw;
  let f = field(p);
  var a = vec2f(0.0);
  // alignment: fly like the birds around
  a += sim.ali * (f.yz - v);
  // cohesion toward denser air, separation once it gets crowded
  let e = 0.5 / f32(sim.gh);
  let grad = vec2f(field(p + vec2f(e, 0.0)).x - field(p - vec2f(e, 0.0)).x, field(p + vec2f(0.0, e)).x - field(p - vec2f(0.0, e)).x) / (2.0 * e);
  a += (sim.coh - sim.sep * f.x) * grad / (1.0 + length(grad) * 0.05);
  // food: eight sensors on a ring, the bright side pulls
  var pull = vec2f(0.0);
  for (var k = 0; k < 8; k++) {
    let an = f32(k) * TAU / 8.0;
    let d = vec2f(cos(an), sin(an));
    pull += d * bright(p + d * sim.reach);
  }
  a += sim.food * pull * 0.25;
  // wander: a slowly turning noise field
  let ang = vnoise(p * 3.0 + vec2f(sim.time * 0.13, -sim.time * 0.07)) * TAU * 2.0;
  a += sim.wander * vec2f(cos(ang), sin(ang));
  // soft walls
  // soft walls: a wide, gentle turn back, so the flock doesn't pile up along the edges
  let m = 0.12;
  let wk = 3.0 * sim.cruise + 0.5;
  a.x += (smoothstep(m, 0.0, p.x) - smoothstep(sim.aspect - m, sim.aspect, p.x)) * wk;
  a.y += (smoothstep(m, 0.0, p.y) - smoothstep(1.0 - m, 1.0, p.y)) * wk;
  v += a * sim.dt;
  // the onset scatter: a blast out of a point
  if (sim.scatter > 0.0) {
    let d = p - sim.scatter_c;
    let r2 = dot(d, d);
    v += d / max(sqrt(r2), 1e-3) * sim.scatter * exp(-r2 / (sim.scatter_r * sim.scatter_r));
  }
  // ease to the cruising speed, slower over bright food: they linger on the picture
  let here = bright(p);
  let edge = min(min(p.x, sim.aspect - p.x), min(p.y, 1.0 - p.y));
  let want = sim.cruise * (1.0 - sim.settle * here * smoothstep(0.0, 0.08, edge)) * (0.85 + 0.3 * rnd(i, 7u));
  let sp = max(length(v), 1e-4);
  v = v / sp * mix(sp, want, 0.06);
  p += v * sim.dt;
  // anyone who left the screen comes back on the far side
  if (p.x < -0.02 || p.x > sim.aspect + 0.02 || p.y < -0.02 || p.y > 1.02) {
    p = vec2f(rnd(i, 11u) * sim.aspect, rnd(i, 12u));
  }
  birds[i] = vec4f(p, v);
}
