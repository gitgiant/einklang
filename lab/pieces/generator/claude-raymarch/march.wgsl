// SDF fly-through: a repeating lattice of rounded boxes (each cell listens to one spectrum band and
// rounds toward a sphere and swells with it), a winding tunnel carved along the camera path.
// fs_march renders at reduced resolution; fs_up scales it to the output.

struct U {
  res: vec2f, time: f32, aspect: f32,
  eye: vec3f, fl: f32,
  right: vec3f, _p0: f32,
  up: vec3f, _p1: f32,
  fwd: vec3f, _p2: f32,
  bass: f32, kick: f32, morph: f32, glow: f32,
  fog: f32, rms: f32, pal_n: f32, tunnel: f32,
  bands: array<vec4f, 4>,
  pal: array<vec4f, 8>, // OKLab stops
};
@group(0) @binding(0) var<uniform> u: U;

const CELL = 2.2;
const STEPS = 80;
const TMAX = 34.0;

fn band(i: i32) -> f32 { let j = clamp(i, 0, 15); return u.bands[j / 4][j % 4]; }

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
  let n = max(i32(u.pal_n), 1);
  let f = clamp(x, 0.0, 1.0) * f32(n - 1);
  let i = min(i32(floor(f)), n - 1);
  let j = min(i + 1, n - 1);
  return lab2lin(mix(u.pal[i].xyz, u.pal[j].xyz, f - f32(i)));
}

// Must match path() in driver.ts.
fn path(z: f32) -> vec2f {
  return vec2f(sin(z * 0.11) * 1.6 + sin(z * 0.037) * 1.2, cos(z * 0.09) * 0.9);
}

fn rbox(p: vec3f, b: vec3f, r: f32) -> f32 {
  let q = abs(p) - (b - r);
  return length(max(q, vec3f(0.0))) + min(max(q.x, max(q.y, q.z)), 0.0) - r;
}

fn rot(p: vec2f, a: f32) -> vec2f { let c = cos(a); let s = sin(a); return vec2f(c * p.x - s * p.y, s * p.x + c * p.y); }

fn cell_hash(id: vec3f) -> f32 {
  let i = bitcast<vec3u>(vec3i(id));
  return f32(h32(i.x, h32(i.y, i.z)) & 0xffffu) / 65535.0;
}

// x = distance, y = cell hash
fn map(p: vec3f) -> vec2f {
  let id = floor(p / CELL);
  var q = p - (id + 0.5) * CELL;
  let h = cell_hash(id);
  let e = band(i32(h * 16.0));
  let s = 0.3 + 0.24 * e * u.morph;
  let round01 = clamp(e * u.morph * 1.2 + 0.25 + 0.25 * sin(h * 40.0 + u.time * 0.7), 0.0, 1.0);
  let a = h * 6.283 + u.time * (0.15 + h * 0.35);
  q = vec3f(rot(q.xz, a), q.y).xzy;
  q = vec3f(rot(q.xy, a * 0.7), q.z);
  var d = rbox(q, vec3f(s), mix(0.05, s, round01));
  // keep a winding tube free for the camera
  d = max(d, u.tunnel - length(p.xy - path(p.z)));
  return vec2f(d, h);
}

fn normal(p: vec3f) -> vec3f {
  let k = vec2f(1.0, -1.0) * 0.002;
  return normalize(k.xyy * map(p + k.xyy).x + k.yyx * map(p + k.yyx).x + k.yxy * map(p + k.yxy).x + k.xxx * map(p + k.xxx).x);
}

@fragment fn fs_march(v: VOut) -> @location(0) vec4f {
  let c = (v.uv - 0.5) * vec2f(u.aspect, -1.0);
  let rd = normalize(u.fwd * u.fl + u.right * c.x + u.up * c.y);
  let ro = u.eye;
  var t = 0.05;
  var hit = false;
  var h = 0.0;
  var haze = 0.0;
  var i = 0;
  for (; i < STEPS; i++) {
    let m = map(ro + rd * t);
    haze += exp(-m.x * 6.0);
    if (m.x < 0.0015 * t) { hit = true; h = m.y; break; }
    t += m.x * 0.85;
    if (t > TMAX) { break; }
  }
  let bg = pal(0.0) * 0.05 + pal(0.3) * 0.03 * (1.0 + u.bass);
  var col = bg;
  let fog = exp(-t * u.fog);
  if (hit) {
    let p = ro + rd * t;
    let n = normal(p);
    let e = band(i32(h * 16.0));
    let base = pal(h);
    let l = normalize(-rd + vec3f(0.0, 0.6, 0.0));
    let diff = max(dot(n, l), 0.0);
    let rim = pow(1.0 - max(dot(n, -rd), 0.0), 3.0);
    let ao = 1.0 - f32(i) / f32(STEPS);
    var s = base * (0.12 + 0.85 * diff) * ao;
    s += pal(1.0) * rim * 0.5;
    s += base * e * e * u.glow * (1.0 + 1.5 * u.kick);
    col = mix(bg, s, fog);
  }
  col += pal(0.55) * haze * 0.006 * u.glow * (0.6 + u.rms + u.kick);
  return vec4f(col, 1.0);
}

@group(0) @binding(1) var lowres: texture_2d<f32>;
@group(0) @binding(2) var samp: sampler;

@fragment fn fs_up(v: VOut) -> @location(0) vec4f {
  let c = textureSampleLevel(lowres, samp, v.uv, 0.0).rgb;
  let d = v.uv - 0.5;
  let vig = 1.0 - 0.6 * dot(d, d);
  return vec4f(c * vig, 1.0);
}
