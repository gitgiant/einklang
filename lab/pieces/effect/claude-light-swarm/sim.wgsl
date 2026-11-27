// A swarm of light motes over a picture. Particle: vec4f(pos (x in 0..aspect, y in 0..1, y down),
// vel (per second)), vec4f(colour rgb, life 1 -> 0). Per step each mote climbs the picture's
// luma gradient (it gathers on the bright places), rides a slow curl-noise current, is thrown
// out by an onset burst, picks up the colour under it, and when its life runs out (or it leaves
// the frame) respawns on the brighter of a few random spots.

struct Sim {
  n: u32, seed: u32, has_luma: u32, tries: u32,
  aspect: f32, dt: f32, damp: f32, climb: f32,
  flow: f32, flow_t: f32, flow_k: f32, life: f32,
  burst_c: vec2f, burst_r: f32, burst: f32,
  tint: f32, _a: f32, _b: f32, _c: f32,
};
struct P { pv: vec4f, col: vec4f };
@group(0) @binding(0) var<uniform> sim: Sim;
@group(0) @binding(1) var<storage, read_write> ps: array<P>;
@group(0) @binding(2) var smp: sampler;
@group(0) @binding(3) var media: texture_2d<f32>;
@group(0) @binding(4) var lumat: texture_2d<f32>;

const LW: vec3f = vec3f(0.2126, 0.7152, 0.0722);

fn rng(s: ptr<function, u32>) -> f32 {
  *s = *s * 747796405u + 2891336453u;
  var w = ((*s >> ((*s >> 28u) + 4u)) ^ *s) * 277803737u;
  w = (w >> 22u) ^ w;
  return f32(w) / 4294967296.0;
}

fn uv_of(p: vec2f) -> vec2f { return vec2f(p.x / sim.aspect, p.y); }

fn pic(p: vec2f) -> vec3f { return max(textureSampleLevel(media, smp, uv_of(p), 0.0).rgb, vec3f(0.0)); }

fn luma(p: vec2f) -> f32 {
  if (sim.has_luma == 1u) { return textureSampleLevel(lumat, smp, uv_of(p), 0.0).r; }
  return dot(pic(p), LW);
}

// a stream function of three drifting waves; its curl is a divergence-free current
fn current(p: vec2f) -> vec2f {
  let k = sim.flow_k;
  let t = sim.flow_t;
  let a = vec2f(1.0, 0.6) * k;
  let b = vec2f(-0.7, 1.1) * k * 1.7;
  let c = vec2f(0.4, -1.3) * k * 2.9;
  let g = a * cos(dot(a, p) + t) + b * 0.5 * cos(dot(b, p) - t * 1.3) + c * 0.25 * cos(dot(c, p) + t * 0.7);
  return vec2f(g.y, -g.x) / k;
}

fn spawn(i: u32, s: ptr<function, u32>) -> P {
  var best = vec2f(0.0);
  var bl = -1.0;
  for (var k = 0u; k < max(sim.tries, 1u); k++) {
    let p = vec2f(rng(s) * sim.aspect, rng(s));
    let l = luma(p);
    if (l > bl) { bl = l; best = p; }
  }
  // life starts at a random point so the respawns stay spread out in time
  return P(vec4f(best, 0.0, 0.0), vec4f(pic(best), 0.3 + 0.7 * rng(s)));
}

@compute @workgroup_size(256) fn cs_init(@builtin(global_invocation_id) g: vec3u) {
  let i = g.x;
  if (i >= sim.n) { return; }
  var s = h32(i, sim.seed) | 1u;
  ps[i] = spawn(i, &s);
}

@compute @workgroup_size(256) fn cs_step(@builtin(global_invocation_id) g: vec3u) {
  let i = g.x;
  if (i >= sim.n) { return; }
  var q = ps[i];
  var s = h32(i, sim.seed);
  var p = q.pv.xy;
  var v = q.pv.zw;
  let e = 0.012;
  let lg = vec2f(luma(p + vec2f(e, 0.0)) - luma(p - vec2f(e, 0.0)), luma(p + vec2f(0.0, e)) - luma(p - vec2f(0.0, e))) / (2.0 * e);
  // each mote has its own temper: some climb harder, some drift more
  let temper = 0.6 + 0.8 * f32(h32(i, 77u) & 1023u) / 1023.0;
  var acc = sim.climb * temper * lg / (1.0 + 0.1 * length(lg));
  acc += (current(p) * sim.flow - v) * 1.5;
  let r = p - sim.burst_c;
  let rl = length(r);
  if (sim.burst > 0.0 && rl > 1e-4) {
    acc += r / rl * sim.burst * exp(-rl / max(sim.burst_r, 0.01)) / sim.dt;
  }
  v = (v + acc * sim.dt) * sim.damp;
  let sp = length(v);
  if (sp > 3.0) { v *= 3.0 / sp; }
  p += v * sim.dt;
  let life = q.col.w - sim.dt / (sim.life * temper);
  let out = p.x < -0.02 || p.y < -0.02 || p.x > sim.aspect + 0.02 || p.y > 1.02;
  if (life <= 0.0 || out) {
    var t = (s ^ bitcast<u32>(q.col.w * 7919.0)) | 1u;
    var n = spawn(i, &t);
    n.col.w = 1.0;
    ps[i] = n;
    return;
  }
  let c = mix(q.col.rgb, pic(p), sim.tint);
  ps[i] = P(vec4f(p, v), vec4f(c, life));
}
