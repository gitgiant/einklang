// Gray-Scott reaction-diffusion on a cell grid (storage buffers, ping-pong).
// cs_advect runs once per frame: drifts the pattern (zoom + swirl about the centre) and stamps seeds.
// cs_step runs `steps` times per tick: one explicit Euler step, Karl Sims' 3x3 Laplacian, Da 1, Db 0.5.

struct Sim {
  size: vec2u, nseed: u32, _p0: u32,
  regime: f32, spread: f32, drive: f32, bass: f32,
  zoom: f32, swirl: f32, t: f32, _p1: f32,
  seeds: array<vec4f, 8>, // x, y (cells), radius (cells), strength 0..1
};
@group(0) @binding(0) var<uniform> sim: Sim;
@group(0) @binding(1) var<storage, read> src: array<vec2f>;
@group(0) @binding(2) var<storage, read_write> dst: array<vec2f>;

fn at(x: i32, y: i32) -> vec2f {
  let w = i32(sim.size.x);
  let h = i32(sim.size.y);
  return src[u32(clamp(y, 0, h - 1) * w + clamp(x, 0, w - 1))];
}

fn bilinear(q: vec2f) -> vec2f {
  let p = q - 0.5;
  let i = vec2i(floor(p));
  let f = p - floor(p);
  let a = mix(at(i.x, i.y), at(i.x + 1, i.y), f.x);
  let b = mix(at(i.x, i.y + 1), at(i.x + 1, i.y + 1), f.x);
  return mix(a, b, f.y);
}

@compute @workgroup_size(16, 16) fn cs_advect(@builtin(global_invocation_id) g: vec3u) {
  if (g.x >= sim.size.x || g.y >= sim.size.y) { return; }
  let c = vec2f(sim.size) * 0.5;
  let p = vec2f(g.xy) + 0.5;
  let d = p - c;
  // sample a little closer to the centre, slightly rotated: the pattern streams outward and turns
  let r = length(d) / f32(sim.size.y);
  let a = sim.swirl * (1.0 - r);
  let cs = cos(a);
  let sn = sin(a);
  let q = vec2f(d.x * cs - d.y * sn, d.x * sn + d.y * cs) * (1.0 - sim.zoom) + c;
  var v = bilinear(q);
  for (var i = 0u; i < min(sim.nseed, 8u); i++) {
    let s = sim.seeds[i];
    let m = (1.0 - smoothstep(s.z * 0.5, s.z, length(p - s.xy))) * s.w;
    v = mix(v, vec2f(0.5, 0.25), m);
  }
  dst[g.y * sim.size.x + g.x] = v;
}

@compute @workgroup_size(16, 16) fn cs_step(@builtin(global_invocation_id) g: vec3u) {
  if (g.x >= sim.size.x || g.y >= sim.size.y) { return; }
  let x = i32(g.x);
  let y = i32(g.y);
  let v = at(x, y);
  let lap = (at(x - 1, y) + at(x + 1, y) + at(x, y - 1) + at(x, y + 1)) * 0.2
    + (at(x - 1, y - 1) + at(x + 1, y - 1) + at(x - 1, y + 1) + at(x + 1, y + 1)) * 0.05 - v;
  // feed/kill walk the line from mitosis spots (0) to coral (1): the outer ring and the bass push toward coral
  let r = length(vec2f(g.xy) - vec2f(sim.size) * 0.5) / f32(sim.size.y);
  let wob = 0.5 + 0.5 * sin(f32(g.x) * 0.013 + sim.t * 0.05) * sin(f32(g.y) * 0.017 - sim.t * 0.04);
  let k01 = clamp(sim.regime + sim.spread * (r - 0.35 + 0.3 * (wob - 0.5)) + sim.bass * sim.drive, 0.0, 1.0);
  let feed = mix(0.0367, 0.0545, k01);
  let kill = mix(0.0649, 0.062, k01);
  let abb = v.x * v.y * v.y;
  let a = v.x + lap.x - abb + feed * (1.0 - v.x);
  let b = v.y + 0.5 * lap.y + abb - (kill + feed) * v.y;
  dst[g.y * sim.size.x + g.x] = clamp(vec2f(a, b), vec2f(0.0), vec2f(1.0));
}
