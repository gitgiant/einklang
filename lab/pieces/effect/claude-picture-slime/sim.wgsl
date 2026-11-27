// Picture slime: Jeff Jones' physarum with food. Agents sense trail + food ahead of them, where food is
// the picture's luma (bright = rich), turn toward the best, move and deposit into an atomic buffer.
// Agents: vec4f(x, y (cells), heading (rad), rng state bitcast). Trail: f32 per cell.
// cs_agents: sense / turn / move / deposit. cs_diffuse: blur + decay + deposit, clear the deposit.
// cs_init: agents scattered where the food is (rejection sampling). cs_burst: a ring respawn (onsets).

struct Sim {
  size: vec2u, n: u32, seed: u32,
  ang: f32, reach: f32, turn: f32, speed: f32,
  deposit: f32, decay: f32, diffuse: f32, food: f32,
  burst_c: vec2f, burst_r: f32, burst: f32,
  gamma: f32, jitter: f32, has_luma: f32, avoid: f32,
};
@group(0) @binding(0) var<uniform> sim: Sim;
@group(0) @binding(1) var<storage, read_write> agents: array<vec4f>;
@group(0) @binding(2) var<storage, read> src: array<f32>;
@group(0) @binding(3) var<storage, read_write> dst: array<f32>;
@group(0) @binding(4) var<storage, read_write> dep: array<atomic<u32>>;
@group(0) @binding(5) var smp: sampler;
@group(0) @binding(6) var tluma: texture_2d<f32>;
@group(0) @binding(7) var tpic: texture_2d<f32>;

const DEP_SCALE: f32 = 256.0;
const TAU: f32 = 6.28318530718;

fn rng(s: ptr<function, u32>) -> f32 {
  *s = *s * 747796405u + 2891336453u;
  var w = ((*s >> ((*s >> 28u) + 4u)) ^ *s) * 277803737u;
  w = (w >> 22u) ^ w;
  return f32(w) / 4294967296.0;
}

fn wrapi(x: i32, m: i32) -> i32 { return ((x % m) + m) % m; }

fn trail(p: vec2f) -> f32 {
  let w = i32(sim.size.x);
  let h = i32(sim.size.y);
  let i = vec2i(floor(p));
  return src[u32(wrapi(i.y, h) * w + wrapi(i.x, w))];
}

// food 0..1 at a cell position: the luma (or the picture's), shaped by gamma
fn food(p: vec2f) -> f32 {
  let uv = clamp(p / vec2f(sim.size), vec2f(0.0), vec2f(1.0));
  var l: f32;
  if (sim.has_luma > 0.5) { l = textureSampleLevel(tluma, smp, uv, 0.0).r; }
  else { l = dot(min(textureSampleLevel(tpic, smp, uv, 0.0).rgb, vec3f(2.0)), vec3f(0.2126, 0.7152, 0.0722)); }
  return pow(clamp(l, 0.0, 1.0), sim.gamma);
}

fn sense(p: vec2f, a: f32) -> f32 {
  let q = p + vec2f(cos(a), sin(a)) * sim.reach;
  let t = trail(q);
  // crowded veins repel a little (avoid), so the web spreads over all the bright parts
  return t - sim.avoid * t * t + sim.food * food(q);
}

@compute @workgroup_size(256) fn cs_init(@builtin(global_invocation_id) g: vec3u) {
  let i = g.x;
  if (i >= sim.n) { return; }
  var s = h32(i, sim.seed) | 1u;
  let sz = vec2f(sim.size);
  var p = vec2f(rng(&s), rng(&s)) * sz;
  // a few tries to land on food: the web starts on the picture's bright parts
  for (var k = 0; k < 6; k++) {
    if (rng(&s) < 0.15 + food(p)) { break; }
    p = vec2f(rng(&s), rng(&s)) * sz;
  }
  agents[i] = vec4f(p, rng(&s) * TAU, bitcast<f32>(s));
}

@compute @workgroup_size(256) fn cs_burst(@builtin(global_invocation_id) g: vec3u) {
  let i = g.x;
  if (i >= sim.n) { return; }
  var s = h32(i, sim.seed ^ 0x9e3779b9u);
  if (rng(&s) >= sim.burst) { return; }
  let a = rng(&s) * TAU;
  let r = sim.burst_r * (0.15 + 0.85 * sqrt(rng(&s)));
  let p = sim.burst_c + vec2f(cos(a), sin(a)) * r;
  let v = agents[i];
  agents[i] = vec4f(p, a + (rng(&s) - 0.5) * 0.4, v.w);
}

@compute @workgroup_size(256) fn cs_agents(@builtin(global_invocation_id) g: vec3u) {
  let i = g.x;
  if (i >= sim.n) { return; }
  var v = agents[i];
  var s = bitcast<u32>(v.w);
  let p = v.xy;
  var h = v.z;
  let f = sense(p, h);
  let l = sense(p, h + sim.ang);
  let r = sense(p, h - sim.ang);
  let rnd = rng(&s);
  if (f > l && f > r) {
  } else if (f < l && f < r) {
    h += select(-sim.turn, sim.turn, rnd < 0.5);
  } else if (l > r) {
    h += sim.turn * (0.5 + rnd);
  } else if (r > l) {
    h -= sim.turn * (0.5 + rnd);
  }
  h += (rng(&s) - 0.5) * sim.jitter;
  let sz = vec2f(sim.size);
  // they slow down on rich food: the bright parts of the picture fill in densest
  let here = food(p);
  var q = p + vec2f(cos(h), sin(h)) * sim.speed * (1.0 - 0.45 * here);
  q = q - floor(q / sz) * sz;
  agents[i] = vec4f(q, h, bitcast<f32>(s));
  let c = vec2u(min(vec2f(q), sz - 1.0));
  atomicAdd(&dep[c.y * sim.size.x + c.x], u32(sim.deposit * (0.4 + 0.6 * here) * DEP_SCALE));
}

@compute @workgroup_size(16, 16) fn cs_diffuse(@builtin(global_invocation_id) g: vec3u) {
  if (g.x >= sim.size.x || g.y >= sim.size.y) { return; }
  let w = i32(sim.size.x);
  let hh = i32(sim.size.y);
  let x = i32(g.x);
  let y = i32(g.y);
  var sum = 0.0;
  for (var dy = -1; dy <= 1; dy++) {
    for (var dx = -1; dx <= 1; dx++) {
      sum += src[u32(wrapi(y + dy, hh) * w + wrapi(x + dx, w))];
    }
  }
  let idx = g.y * sim.size.x + g.x;
  let d = f32(atomicExchange(&dep[idx], 0u)) / DEP_SCALE;
  dst[idx] = min(mix(src[idx], sum / 9.0, sim.diffuse) * sim.decay + d, 400.0);
}
