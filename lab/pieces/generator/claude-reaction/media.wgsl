// The media path of claude-reaction (used when `in`, `luma` and `edges` are wired): the same Gray-Scott
// grid, but seeded from the picture's contours, its feed/kill regime mapped from the picture's luma
// (bright = coral, dark = spots), wiped back to the bare picture at each phrase start (`reform`), and
// drawn as the picture itself lit through the embossed pattern.

struct Sim {
  size: vec2u, nseed: u32, _p0: u32,
  regime: f32, spread: f32, drive: f32, bass: f32,
  zoom: f32, swirl: f32, t: f32, _p1: f32,
  seeds: array<vec4f, 8>,
  edge_seed: f32, thr: f32, wipe: f32, luma_map: f32,
};
@group(0) @binding(0) var<uniform> sim: Sim;
@group(0) @binding(1) var<storage, read> src: array<vec2f>;
@group(0) @binding(2) var<storage, read_write> dst: array<vec2f>;
@group(1) @binding(0) var samp: sampler;
@group(1) @binding(1) var pic: texture_2d<f32>;
@group(1) @binding(2) var lum: texture_2d<f32>;
@group(1) @binding(3) var edg: texture_2d<f32>;

fn at(x: i32, y: i32) -> vec2f {
  let w = i32(sim.size.x);
  let h = i32(sim.size.y);
  return src[u32(clamp(y, 0, h - 1) * w + clamp(x, 0, w - 1))];
}

fn bilinear(q: vec2f) -> vec2f {
  let p = q - 0.5;
  let i = vec2i(floor(p));
  let f = p - floor(p);
  return mix(mix(at(i.x, i.y), at(i.x + 1, i.y), f.x), mix(at(i.x, i.y + 1), at(i.x + 1, i.y + 1), f.x), f.y);
}

@compute @workgroup_size(16, 16) fn cs_advect(@builtin(global_invocation_id) g: vec3u) {
  if (g.x >= sim.size.x || g.y >= sim.size.y) { return; }
  let c = vec2f(sim.size) * 0.5;
  let p = vec2f(g.xy) + 0.5;
  let d = p - c;
  let r = length(d) / f32(sim.size.y);
  let a = sim.swirl * (1.0 - r);
  let cs = cos(a);
  let sn = sin(a);
  let q = vec2f(d.x * cs - d.y * sn, d.x * sn + d.y * cs) * (1.0 - sim.zoom) + c;
  var v = bilinear(q);
  // phrase start: back to bare substrate, so the pattern regrows from the contours
  v = mix(v, vec2f(1.0, 0.0), sim.wipe);
  let uv = p / vec2f(sim.size);
  let e = length(textureSampleLevel(edg, samp, uv, 0.0).xy);
  let m = smoothstep(sim.thr, sim.thr + 0.25, e) * sim.edge_seed;
  v = mix(v, vec2f(0.5, 0.25), m);
  for (var i = 0u; i < min(sim.nseed, 8u); i++) {
    let s = sim.seeds[i];
    let k = (1.0 - smoothstep(s.z * 0.5, s.z, length(p - s.xy))) * s.w;
    v = mix(v, vec2f(0.5, 0.25), k);
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
  let l = textureSampleLevel(lum, samp, (vec2f(g.xy) + 0.5) / vec2f(sim.size), 0.0).x;
  let k01 = clamp(sim.regime + sim.luma_map * (l - 0.5) + sim.bass * sim.drive, 0.0, 1.0);
  let feed = mix(0.0367, 0.0545, k01);
  let kill = mix(0.0649, 0.062, k01);
  let abb = v.x * v.y * v.y;
  let a = v.x + lap.x - abb + feed * (1.0 - v.x);
  let b = v.y + 0.5 * lap.y + abb - (kill + feed) * v.y;
  dst[g.y * sim.size.x + g.x] = clamp(vec2f(a, b), vec2f(0.0), vec2f(1.0));
}

struct Draw {
  size: vec2f, pal_n: f32, glow: f32,
  kick: f32, rms: f32, shift: f32, relief: f32,
  pal: array<vec4f, 8>,
  show: f32, picture: f32, _a: f32, _b: f32,
};
@group(0) @binding(0) var<uniform> dr: Draw;
@group(0) @binding(1) var<storage, read> cells: array<vec2f>;

fn cell(x: i32, y: i32) -> f32 {
  let w = i32(dr.size.x);
  let h = i32(dr.size.y);
  return cells[u32(clamp(y, 0, h - 1) * w + clamp(x, 0, w - 1))].y;
}

fn sample_b(q: vec2f) -> f32 {
  let p = q - 0.5;
  let i = vec2i(floor(p));
  let f = p - floor(p);
  return mix(mix(cell(i.x, i.y), cell(i.x + 1, i.y), f.x), mix(cell(i.x, i.y + 1), cell(i.x + 1, i.y + 1), f.x), f.y);
}

fn lab2lin(c: vec3f) -> vec3f {
  let l_ = c.x + 0.3963377774 * c.y + 0.2158037573 * c.z;
  let m_ = c.x - 0.1055613458 * c.y - 0.0638541728 * c.z;
  let s_ = c.x - 0.0894841775 * c.y - 1.291485548 * c.z;
  let l = l_ * l_ * l_;
  let m = m_ * m_ * m_;
  let s = s_ * s_ * s_;
  return max(vec3f(0.0), vec3f(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s));
}

fn pal(x: f32) -> vec3f {
  let n = max(i32(dr.pal_n), 1);
  let f = clamp(x, 0.0, 1.0) * f32(n - 1);
  let i = min(i32(floor(f)), n - 1);
  let j = min(i + 1, n - 1);
  return lab2lin(mix(dr.pal[i].xyz, dr.pal[j].xyz, f - f32(i)));
}

@fragment fn fs_draw(v: VOut) -> @location(0) vec4f {
  let q = v.uv * dr.size;
  let b = sample_b(q);
  let gx = sample_b(q + vec2f(1.0, 0.0)) - sample_b(q - vec2f(1.0, 0.0));
  let gy = sample_b(q + vec2f(0.0, 1.0)) - sample_b(q - vec2f(0.0, 1.0));
  let n = normalize(vec3f(-gx * dr.relief, -gy * dr.relief, 0.08));
  let lit = max(dot(n, normalize(vec3f(-0.5, -0.6, 0.6))), 0.0);
  let spec = pow(max(dot(n, normalize(vec3f(-0.25, -0.3, 1.0))), 0.0), 24.0);
  let s = smoothstep(0.06, 0.32, b);
  let live = textureSampleLevel(pic, samp, v.uv, 0.0).rgb;
  let body = mix(pal(1.0 - abs(fract((s * 0.8 + dr.shift) * 0.5) * 2.0 - 1.0)), live * 1.5, dr.picture);
  let gain = 0.3 + 0.95 * lit + 0.4 * dr.rms + 0.45 * dr.kick;
  var col = live * dr.show * (1.0 - 0.5 * s) + body * s * gain;
  col += mix(pal(1.0), live + 0.3, 0.5) * spec * s * (0.4 + dr.kick) * 0.8;
  col += pal(0.75) * smoothstep(0.1, 0.0, abs(b - 0.12)) * 0.3;
  return vec4f(col * dr.glow, 1.0);
}
