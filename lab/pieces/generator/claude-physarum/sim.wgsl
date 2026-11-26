// Physarum (Jeff Jones' slime-mould model), two species.
// Agents: vec4f(x, y (cells), heading (rad), rng state bitcast). Trail: vec2f per cell (species 0, 1).
// Per step: cs_agents senses the trail ahead, turns, moves (wrapping) and deposits into an atomic
// fixed-point buffer; cs_diffuse blurs + decays the trail, adds the deposit and clears it.
// cs_init scatters agents in a disc; cs_burst respawns a fraction of them on a ring (onsets).

struct Sim {
  size: vec2u, n: u32, seed: u32,
  ang: f32, reach: f32, turn: f32, speed: f32,
  deposit: f32, decay: f32, diffuse: f32, repel: f32,
  burst_c: vec2f, burst_r: f32, burst: f32,
  species: u32, jitter: f32, _a: f32, _b: f32,
};
@group(0) @binding(0) var<uniform> sim: Sim;
@group(0) @binding(1) var<storage, read_write> agents: array<vec4f>;
@group(0) @binding(2) var<storage, read> src: array<vec2f>;
@group(0) @binding(3) var<storage, read_write> dst: array<vec2f>;
@group(0) @binding(4) var<storage, read_write> dep: array<atomic<u32>>;

const DEP_SCALE: f32 = 256.0;
const TAU: f32 = 6.28318530718;

fn rng(s: ptr<function, u32>) -> f32 {
  *s = *s * 747796405u + 2891336453u;
  var w = ((*s >> ((*s >> 28u) + 4u)) ^ *s) * 277803737u;
  w = (w >> 22u) ^ w;
  return f32(w) / 4294967296.0;
}

fn wrapi(x: i32, m: i32) -> i32 { return ((x % m) + m) % m; }

fn trail(p: vec2f) -> vec2f {
  let w = i32(sim.size.x);
  let h = i32(sim.size.y);
  let i = vec2i(floor(p));
  return src[u32(wrapi(i.y, h) * w + wrapi(i.x, w))];
}

fn species_of(i: u32) -> u32 { return select(0u, i & 1u, sim.species > 1u); }

fn sense(p: vec2f, a: f32, sp: u32) -> f32 {
  let t = trail(p + vec2f(cos(a), sin(a)) * sim.reach);
  let own = select(t.x, t.y, sp == 1u);
  let other = select(t.y, t.x, sp == 1u);
  return own - sim.repel * other;
}

@compute @workgroup_size(256) fn cs_init(@builtin(global_invocation_id) g: vec3u) {
  let i = g.x;
  if (i >= sim.n) { return; }
  var s = h32(i, sim.seed) | 1u;
  let sz = vec2f(sim.size);
  let r = sqrt(rng(&s)) * sz.y * 0.42;
  let a = rng(&s) * TAU;
  let p = sz * 0.5 + vec2f(cos(a), sin(a)) * r;
  // heading roughly inward: the first seconds draw a contracting web
  let h = a + 3.14159 + (rng(&s) - 0.5) * 1.2;
  agents[i] = vec4f(p, h, bitcast<f32>(s));
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
  // heading outward: the burst blooms open like a flower
  agents[i] = vec4f(p, a + (rng(&s) - 0.5) * 0.4, v.w);
}

@compute @workgroup_size(256) fn cs_agents(@builtin(global_invocation_id) g: vec3u) {
  let i = g.x;
  if (i >= sim.n) { return; }
  var v = agents[i];
  var s = bitcast<u32>(v.w);
  let sp = species_of(i);
  let p = v.xy;
  var h = v.z;
  let f = sense(p, h, sp);
  let l = sense(p, h + sim.ang, sp);
  let r = sense(p, h - sim.ang, sp);
  let rnd = rng(&s);
  if (f > l && f > r) {
    // keep going
  } else if (f < l && f < r) {
    h += select(-sim.turn, sim.turn, rnd < 0.5);
  } else if (l > r) {
    h += sim.turn * (0.5 + rnd);
  } else if (r > l) {
    h -= sim.turn * (0.5 + rnd);
  }
  h += (rng(&s) - 0.5) * sim.jitter;
  let sz = vec2f(sim.size);
  var q = p + vec2f(cos(h), sin(h)) * sim.speed;
  q = q - floor(q / sz) * sz;
  agents[i] = vec4f(q, h, bitcast<f32>(s));
  let c = vec2u(min(vec2f(q), sz - 1.0));
  let idx = (c.y * sim.size.x + c.x) * 2u + sp;
  atomicAdd(&dep[idx], u32(sim.deposit * DEP_SCALE));
}

@compute @workgroup_size(16, 16) fn cs_diffuse(@builtin(global_invocation_id) g: vec3u) {
  if (g.x >= sim.size.x || g.y >= sim.size.y) { return; }
  let w = i32(sim.size.x);
  let hh = i32(sim.size.y);
  let x = i32(g.x);
  let y = i32(g.y);
  var sum = vec2f(0.0);
  for (var dy = -1; dy <= 1; dy++) {
    for (var dx = -1; dx <= 1; dx++) {
      sum += src[u32(wrapi(y + dy, hh) * w + wrapi(x + dx, w))];
    }
  }
  let idx = g.y * sim.size.x + g.x;
  let c = src[idx];
  let d = vec2f(f32(atomicExchange(&dep[idx * 2u], 0u)), f32(atomicExchange(&dep[idx * 2u + 1u], 0u))) / DEP_SCALE;
  let v = mix(c, sum / 9.0, sim.diffuse) * sim.decay + d;
  dst[idx] = min(v, vec2f(400.0));
}
