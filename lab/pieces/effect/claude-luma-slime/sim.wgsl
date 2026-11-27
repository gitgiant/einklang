// Physarum (Jeff Jones' slime-mould model) feeding on a picture: the agents smell the trail ahead
// of them plus the picture's brightness (food), slow down where it is bright and so gather there.
// Agents: vec4f(x, y (cells), heading (rad), rng state bitcast). Trail: f32 per cell.
// Per step: cs_agents senses, turns, moves (wrapping), deposits into an atomic fixed-point buffer
// and now and then respawns on the light; cs_diffuse blurs + decays the trail and adds the deposit.
// cs_init scatters agents, biased to bright places; cs_burst respawns a share near a seeded spot.

struct Sim {
  size: vec2u, n: u32, seed: u32,
  ang: f32, reach: f32, turn: f32, speed: f32,
  deposit: f32, decay: f32, diffuse: f32, food: f32,
  burst: f32, respawn: f32, has_luma: u32, linger: f32,
  burst_c: vec2f, burst_r: f32, jitter: f32,
};
@group(0) @binding(0) var<uniform> sim: Sim;
@group(0) @binding(1) var<storage, read_write> agents: array<vec4f>;
@group(0) @binding(2) var<storage, read> src: array<f32>;
@group(0) @binding(3) var<storage, read_write> dst: array<f32>;
@group(0) @binding(4) var<storage, read_write> dep: array<atomic<u32>>;
@group(0) @binding(5) var smp: sampler;
@group(0) @binding(6) var media: texture_2d<f32>;
@group(0) @binding(7) var lumat: texture_2d<f32>;

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

fn food(p: vec2f) -> f32 {
  let uv = fract(p / vec2f(sim.size));
  if (sim.has_luma == 1u) { return clamp(textureSampleLevel(lumat, smp, uv, 0.0).r, 0.0, 1.5); }
  return clamp(dot(textureSampleLevel(media, smp, uv, 0.0).rgb, vec3f(0.2126, 0.7152, 0.0722)), 0.0, 1.5);
}

fn sense(p: vec2f, a: f32) -> f32 {
  let q = p + vec2f(cos(a), sin(a)) * sim.reach;
  return trail(q) + sim.food * food(q);
}

// the brightest of a few random spots in a disc (centre c, radius r; r <= 0: anywhere)
fn bright_spot(s: ptr<function, u32>, c: vec2f, r: f32, tries: i32) -> vec2f {
  let sz = vec2f(sim.size);
  var best = vec2f(0.0);
  var bf = -1.0;
  for (var k = 0; k < tries; k++) {
    var p: vec2f;
    if (r > 0.0) {
      let a = rng(s) * TAU;
      p = c + vec2f(cos(a), sin(a)) * r * sqrt(rng(s));
    } else {
      p = vec2f(rng(s), rng(s)) * sz;
    }
    p = p - floor(p / sz) * sz;
    let f = food(p);
    if (f > bf) { bf = f; best = p; }
  }
  return best;
}

@compute @workgroup_size(256) fn cs_init(@builtin(global_invocation_id) g: vec3u) {
  let i = g.x;
  if (i >= sim.n) { return; }
  var s = h32(i, sim.seed) | 1u;
  let p = bright_spot(&s, vec2f(0.0), 0.0, 2);
  agents[i] = vec4f(p, rng(&s) * TAU, bitcast<f32>(s));
}

@compute @workgroup_size(256) fn cs_burst(@builtin(global_invocation_id) g: vec3u) {
  let i = g.x;
  if (i >= sim.n) { return; }
  var s = h32(i, sim.seed ^ 0x9e3779b9u);
  if (rng(&s) >= sim.burst) { return; }
  let p = bright_spot(&s, sim.burst_c, sim.burst_r, 3);
  let d = p - sim.burst_c;
  let v = agents[i];
  // heading outward from the burst centre: it blooms open across the light
  agents[i] = vec4f(p, atan2(d.y, d.x) + (rng(&s) - 0.5) * 0.6, v.w);
}

@compute @workgroup_size(256) fn cs_agents(@builtin(global_invocation_id) g: vec3u) {
  let i = g.x;
  if (i >= sim.n) { return; }
  var v = agents[i];
  var s = bitcast<u32>(v.w);
  var p = v.xy;
  var h = v.z;
  let f = sense(p, h);
  let l = sense(p, h + sim.ang);
  let r = sense(p, h - sim.ang);
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
  // they linger on the light: slower where the picture is bright
  let here = food(p);
  var q = p + vec2f(cos(h), sin(h)) * sim.speed * (1.0 - sim.linger * clamp(here, 0.0, 1.0));
  q = q - floor(q / sz) * sz;
  if (rng(&s) < sim.respawn) {
    q = bright_spot(&s, vec2f(0.0), 0.0, 3);
    h = rng(&s) * TAU;
  }
  agents[i] = vec4f(q, h, bitcast<f32>(s));
  let c = vec2u(min(q, sz - 1.0));
  atomicAdd(&dep[c.y * sim.size.x + c.x], u32(sim.deposit * DEP_SCALE * (0.5 + here)));
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
