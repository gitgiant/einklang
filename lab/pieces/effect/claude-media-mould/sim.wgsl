// Media mould: physarum (Jeff Jones' slime-mould model) feeding on the picture.
// Agents: vec4f(x, y (cells), heading (rad), rng state bitcast). Trail: vec4f per cell
// (density, then density x the picture's colour where it was laid). Per step: cs_agents senses the
// trail plus food (the picture's luma) minus walls (its edges) ahead, turns, moves (wrapping) and
// deposits density and colour into an atomic fixed-point buffer; cs_diffuse blurs + decays the trail,
// adds the deposit and clears it. cs_spawn respawns a share of the agents on bright spots (init,
// onsets, phrase starts), inside a disc when one is given.

struct Sim {
  size: vec2u, n: u32, seed: u32,
  ang: f32, reach: f32, turn: f32, speed: f32,
  deposit: f32, decay: f32, diffuse: f32, food: f32,
  wall: f32, inv_mean: f32, share: f32, jitter: f32,
  burst_c: vec2f, burst_r: f32, _p: f32,
};
@group(0) @binding(0) var<uniform> sim: Sim;
@group(0) @binding(1) var<storage, read_write> agents: array<vec4f>;
@group(0) @binding(2) var<storage, read> src: array<vec4f>;
@group(0) @binding(3) var<storage, read_write> dst: array<vec4f>;
@group(0) @binding(4) var<storage, read_write> dep: array<atomic<u32>>;
@group(1) @binding(0) var samp: sampler;
@group(1) @binding(1) var pic: texture_2d<f32>;
@group(1) @binding(2) var lum: texture_2d<f32>;
@group(1) @binding(3) var edg: texture_2d<f32>;

const DEP_SCALE: f32 = 256.0;
const TAU: f32 = 6.28318530718;

fn rng(s: ptr<function, u32>) -> f32 {
  *s = *s * 747796405u + 2891336453u;
  var w = ((*s >> ((*s >> 28u) + 4u)) ^ *s) * 277803737u;
  w = (w >> 22u) ^ w;
  return f32(w) / 4294967296.0;
}

fn wrapi(x: i32, m: i32) -> i32 { return ((x % m) + m) % m; }
fn uv_of(p: vec2f) -> vec2f { return p / vec2f(sim.size); }

fn trail(p: vec2f) -> f32 {
  let w = i32(sim.size.x);
  let h = i32(sim.size.y);
  let i = vec2i(floor(p));
  return src[u32(wrapi(i.y, h) * w + wrapi(i.x, w))].x;
}

fn sense(p: vec2f, a: f32) -> f32 {
  let q = p + vec2f(cos(a), sin(a)) * sim.reach;
  let uv = fract(uv_of(q));
  let food = textureSampleLevel(lum, samp, uv, 0.0).x;
  let e = length(textureSampleLevel(edg, samp, uv, 0.0).xy);
  return trail(q) * sim.inv_mean + sim.food * food * food - sim.wall * min(e, 1.5);
}

// a position biased to bright areas: the best of a few random draws (inside the burst disc if r > 0)
fn bright_spot(s: ptr<function, u32>) -> vec2f {
  let sz = vec2f(sim.size);
  var best = vec2f(0.0);
  var bl = -1.0;
  for (var k = 0; k < 4; k++) {
    var p: vec2f;
    if (sim.burst_r > 0.0) {
      let a = rng(s) * TAU;
      p = sim.burst_c + vec2f(cos(a), sin(a)) * sim.burst_r * sqrt(rng(s));
    } else {
      p = vec2f(rng(s), rng(s)) * sz;
    }
    p = p - floor(p / sz) * sz;
    let l = textureSampleLevel(lum, samp, uv_of(p), 0.0).x + rng(s) * 0.25;
    if (l > bl) { bl = l; best = p; }
  }
  return best;
}

@compute @workgroup_size(256) fn cs_spawn(@builtin(global_invocation_id) g: vec3u) {
  let i = g.x;
  if (i >= sim.n) { return; }
  var s = h32(i, sim.seed) | 1u;
  if (rng(&s) >= sim.share) { return; }
  let p = bright_spot(&s);
  agents[i] = vec4f(p, rng(&s) * TAU, bitcast<f32>(s));
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
  let c = vec2u(min(q, sz - 1.0));
  let col = min(textureSampleLevel(pic, samp, uv_of(q), 0.0).rgb, vec3f(4.0));
  let d = sim.deposit * DEP_SCALE;
  let idx = (c.y * sim.size.x + c.x) * 4u;
  atomicAdd(&dep[idx], u32(d));
  atomicAdd(&dep[idx + 1u], u32(d * col.r));
  atomicAdd(&dep[idx + 2u], u32(d * col.g));
  atomicAdd(&dep[idx + 3u], u32(d * col.b));
}

@compute @workgroup_size(16, 16) fn cs_diffuse(@builtin(global_invocation_id) g: vec3u) {
  if (g.x >= sim.size.x || g.y >= sim.size.y) { return; }
  let w = i32(sim.size.x);
  let hh = i32(sim.size.y);
  let x = i32(g.x);
  let y = i32(g.y);
  var sum = vec4f(0.0);
  for (var dy = -1; dy <= 1; dy++) {
    for (var dx = -1; dx <= 1; dx++) {
      sum += src[u32(wrapi(y + dy, hh) * w + wrapi(x + dx, w))];
    }
  }
  let idx = g.y * sim.size.x + g.x;
  let c = src[idx];
  let k = idx * 4u;
  let d = vec4f(f32(atomicExchange(&dep[k], 0u)), f32(atomicExchange(&dep[k + 1u], 0u)),
    f32(atomicExchange(&dep[k + 2u], 0u)), f32(atomicExchange(&dep[k + 3u], 0u))) / DEP_SCALE;
  let v = mix(c, sum / 9.0, sim.diffuse) * sim.decay + d;
  dst[idx] = min(v, vec4f(800.0));
}
