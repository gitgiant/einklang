// Cellular automata on a toroidal cell grid (storage buffers, ping-pong). Cell = vec4f:
//   x value (Life 0 | 1, Lenia 0..1), y age (steps alive), z afterglow (1 while alive, decays when dead), w seed flash.
// cs_seed runs once per frame: Lenia drifts (zoom + swirl about the centre), then the seeds are stamped.
// cs_life / cs_lenia run once per step.

struct Sim {
  size: vec2u, nseed: u32, taps: u32,
  birth: u32, survive: u32, hash: u32, _p0: u32,
  mu: f32, sigma: f32, dt: f32, decay: f32,
  zoom: f32, swirl: f32, density: f32, lenia: f32,
  seeds: array<vec4f, 8>, // x, y (cells), radius (cells), strength 0..1
};
@group(0) @binding(0) var<uniform> sim: Sim;
@group(0) @binding(1) var<storage, read> src: array<vec4f>;
@group(0) @binding(2) var<storage, read_write> dst: array<vec4f>;
@group(0) @binding(3) var<storage, read> kern: array<vec4f>; // dx, dy, weight (sums to 1)

fn wrap(x: i32, y: i32) -> u32 {
  let w = i32(sim.size.x);
  let h = i32(sim.size.y);
  return u32(((y % h + h) % h) * w + ((x % w + w) % w));
}

fn hash(a: u32, b: u32) -> f32 {
  var x = (a * 0x9e3779b1u) ^ ((b + 0x7f4a7c15u) * 0x85ebca6bu);
  x ^= x >> 15u;
  x *= 0x2c1b3c6du;
  x ^= x >> 12u;
  x *= 0x297a2d39u;
  x ^= x >> 15u;
  return f32(x >> 8u) / 16777216.0;
}

fn bilinear(q: vec2f) -> vec4f {
  let p = q - 0.5;
  let i = vec2i(floor(p));
  let f = p - floor(p);
  let a = mix(src[wrap(i.x, i.y)], src[wrap(i.x + 1, i.y)], f.x);
  let b = mix(src[wrap(i.x, i.y + 1)], src[wrap(i.x + 1, i.y + 1)], f.x);
  return mix(a, b, f.y);
}

@compute @workgroup_size(16, 16) fn cs_seed(@builtin(global_invocation_id) g: vec3u) {
  if (g.x >= sim.size.x || g.y >= sim.size.y) { return; }
  let p = vec2f(g.xy) + 0.5;
  var v = src[g.y * sim.size.x + g.x];
  if (sim.lenia > 0.5 && (sim.zoom != 0.0 || sim.swirl != 0.0)) {
    // sample a little closer to the centre and slightly rotated: the pattern streams outward and turns
    let c = vec2f(sim.size) * 0.5;
    let d = p - c;
    let r = length(d) / f32(sim.size.y);
    let a = sim.swirl * (1.0 - r);
    let q = vec2f(d.x * cos(a) - d.y * sin(a), d.x * sin(a) + d.y * cos(a)) * (1.0 - sim.zoom) + c;
    let age = v.y;
    v = bilinear(q);
    v.y = max(age, v.y);
  }
  for (var i = 0u; i < min(sim.nseed, 8u); i++) {
    let s = sim.seeds[i];
    var d = abs(p - s.xy);
    d = min(d, vec2f(sim.size) - d); // seeds wrap too
    let m = 1.0 - smoothstep(s.z * 0.6, s.z, length(d));
    if (m <= 0.0) { continue; }
    let h = hash(g.y * sim.size.x + g.x, sim.hash + i * 7919u);
    if (sim.lenia > 0.5) {
      let n = h * m * s.w;
      if (n > v.x) { v = vec4f(n, 0.0, max(v.z, n), 1.0); }
    } else if (h < sim.density * m * s.w) {
      v = vec4f(1.0, 0.0, 1.0, 1.0);
    }
  }
  dst[g.y * sim.size.x + g.x] = v;
}

@compute @workgroup_size(16, 16) fn cs_life(@builtin(global_invocation_id) g: vec3u) {
  if (g.x >= sim.size.x || g.y >= sim.size.y) { return; }
  let x = i32(g.x);
  let y = i32(g.y);
  var n = 0u;
  for (var dy = -1; dy <= 1; dy++) {
    for (var dx = -1; dx <= 1; dx++) {
      if (dx != 0 || dy != 0) { n += select(0u, 1u, src[wrap(x + dx, y + dy)].x > 0.5); }
    }
  }
  var v = src[g.y * sim.size.x + g.x];
  let alive = v.x > 0.5;
  let live = select((sim.birth >> n) & 1u, (sim.survive >> n) & 1u, alive) == 1u;
  if (live) {
    v = vec4f(1.0, select(0.0, v.y + 1.0, alive), 1.0, v.w * 0.8);
  } else {
    v = vec4f(0.0, 0.0, v.z * sim.decay, v.w * 0.8);
  }
  dst[g.y * sim.size.x + g.x] = v;
}

@compute @workgroup_size(16, 16) fn cs_lenia(@builtin(global_invocation_id) g: vec3u) {
  if (g.x >= sim.size.x || g.y >= sim.size.y) { return; }
  let x = i32(g.x);
  let y = i32(g.y);
  var u = 0.0;
  for (var i = 0u; i < sim.taps; i++) {
    let k = kern[i];
    u += k.z * src[wrap(x + i32(k.x), y + i32(k.y))].x;
  }
  var v = src[g.y * sim.size.x + g.x];
  let e = (u - sim.mu) / sim.sigma;
  let grow = 2.0 * exp(-0.5 * e * e) - 1.0;
  let a = clamp(v.x + sim.dt * grow, 0.0, 1.0);
  // age counts up while the cell is on and drains when it is off
  let age = select(max(v.y - 4.0, 0.0), v.y + 1.0, a > 0.15);
  dst[g.y * sim.size.x + g.x] = vec4f(a, age, max(a, v.z * sim.decay), v.w * 0.96);
}
