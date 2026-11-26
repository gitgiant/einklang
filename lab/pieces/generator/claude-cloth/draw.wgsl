// Cloth drawn as a shaded, two-sided triangle mesh (normals from the grid neighbours) with a
// palette pattern (stripes, a live spectrum, chevrons or a gradient), diffuse + light shining
// through + a satin sheen, a hem along the edges, and a rod (pole or top bar) it hangs from.
// A dusk gradient from the darkest stops behind it.

struct Draw {
  view: mat4x4f, proj: mat4x4f,
  eye: vec3f, time: f32,
  light: vec3f, glow: f32,
  grid: vec2f, pal_n: f32, pattern: f32,
  stripes: f32, kick: f32, shift: f32, bg: f32,
  rod_a: vec3f, rod_r: f32,
  rod_b: vec3f, rod_on: f32,
  bands: array<vec4f, 4>,
  pal: array<vec4f, 8>,
};
@group(0) @binding(0) var<uniform> dr: Draw;
@group(0) @binding(1) var<storage, read> pos: array<vec4f>;

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

fn tri(x: f32) -> f32 { return 1.0 - abs(fract(x * 0.5) * 2.0 - 1.0); }

fn band(i: i32) -> f32 {
  let k = clamp(i, 0, 15);
  return dr.bands[k / 4][k % 4];
}

fn at(x: i32, y: i32) -> vec3f {
  let w = i32(dr.grid.x);
  let h = i32(dr.grid.y);
  return pos[u32(clamp(y, 0, h - 1) * w + clamp(x, 0, w - 1))].xyz;
}

struct COut { @builtin(position) pos: vec4f, @location(0) wp: vec3f, @location(1) n: vec3f, @location(2) uv: vec2f };

@vertex fn vs_cloth(@builtin(vertex_index) vi: u32) -> COut {
  let w = u32(dr.grid.x);
  let x = i32(vi % w);
  let y = i32(vi / w);
  let p = pos[vi].xyz;
  let n = cross(at(x + 1, y) - at(x - 1, y), at(x, y + 1) - at(x, y - 1));
  var o: COut;
  o.pos = dr.proj * dr.view * vec4f(p, 1.0);
  o.wp = p;
  o.n = n;
  o.uv = vec2f(f32(x) / (dr.grid.x - 1.0), f32(y) / (dr.grid.y - 1.0));
  return o;
}

fn pattern(uv: vec2f) -> vec3f {
  let k = max(dr.stripes, 1.0);
  let mode = i32(dr.pattern + 0.5);
  if (mode == 1) {
    // a live spectrum: 16 columns from the hoist outward, each lit up to its band's level
    let fx = uv.x * 16.0;
    let j = i32(floor(fx));
    let lvl = band(j);
    let up = 1.0 - uv.y;
    let lit = smoothstep(lvl + 0.02, lvl - 0.02, up);
    let gap = smoothstep(0.0, 0.08, fract(fx)) * smoothstep(1.0, 0.92, fract(fx));
    let hi = pal(0.35 + 0.65 * tri(f32(j) / 15.0 * 0.8 + dr.shift));
    return mix(pal(0.12), hi * (0.8 + 0.6 * up), lit * gap);
  }
  if (mode == 2) {
    // chevrons pointing at the hoist
    let c = floor((uv.x * 0.8 + abs(uv.y - 0.5)) * k);
    return pal(0.25 + 0.75 * tri(c / k + dr.shift));
  }
  if (mode == 3) {
    return pal(0.2 + 0.8 * tri(uv.x * 0.8 + uv.y * 0.2 + dr.shift));
  }
  // horizontal stripes
  let s = floor(uv.y * k);
  return pal(0.25 + 0.75 * tri(s / max(k - 1.0, 1.0) * 0.999 + dr.shift));
}

@fragment fn fs_cloth(v: COut, @builtin(front_facing) ff: bool) -> @location(0) vec4f {
  var n = v.n;
  let nl = length(n);
  n = select(vec3f(0.0, 0.0, 1.0), n / nl, nl > 1e-8);
  let V = normalize(dr.eye - v.wp);
  if (dot(n, V) < 0.0) { n = -n; }
  let L = normalize(dr.light);
  let diff = max(dot(n, L), 0.0);
  let through = max(dot(-n, L), 0.0);
  let H = normalize(L + V);
  // satin: a broad, soft highlight
  let sheen = pow(max(dot(n, H), 0.0), 18.0) * 0.35;
  let rim = pow(1.0 - abs(dot(n, V)), 3.0) * 0.25;
  var base = pattern(v.uv);
  // hem: a darker stitched band along the edges
  let e = min(min(v.uv.x, 1.0 - v.uv.x) * dr.grid.x / dr.grid.y, min(v.uv.y, 1.0 - v.uv.y));
  base *= mix(0.55, 1.0, smoothstep(0.012, 0.022, e));
  var col = base * (0.18 + 0.95 * diff + 0.55 * through) + (pal(1.0) * 0.6 + vec3f(0.4)) * sheen + pal(0.6) * rim;
  col += base * dr.kick * 0.45;
  return vec4f(col * dr.glow, 1.0);
}

struct ROut { @builtin(position) pos: vec4f, @location(0) s: f32, @location(1) along: f32 };

@vertex fn vs_rod(@builtin(vertex_index) vi: u32) -> ROut {
  var t = array<vec2f, 6>(vec2f(0.0, -1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0), vec2f(0.0, -1.0), vec2f(1.0, 1.0), vec2f(0.0, 1.0));
  let c = t[vi];
  let mid = (dr.rod_a + dr.rod_b) * 0.5;
  let d = dr.rod_b - dr.rod_a;
  let side = normalize(cross(d, dr.eye - mid)) * dr.rod_r;
  let p = mix(dr.rod_a, dr.rod_b, c.x) + side * c.y;
  var o: ROut;
  o.pos = dr.proj * dr.view * vec4f(p, 1.0);
  // off: degenerate, nothing drawn
  if (dr.rod_on < 0.5) { o.pos = vec4f(0.0, 0.0, -2.0, 1.0); }
  o.s = c.y;
  o.along = c.x;
  return o;
}

@fragment fn fs_rod(v: ROut) -> @location(0) vec4f {
  // a polished cylinder: fake the normal across its width
  let s = v.s;
  let k = sqrt(max(1.0 - s * s, 0.0));
  let shade = 0.25 + 0.75 * k;
  let spec = pow(max(1.0 - abs(s + 0.35), 0.0), 12.0);
  let col = pal(0.18) * shade + (pal(1.0) * 0.5 + vec3f(0.5)) * spec * 0.8;
  return vec4f(col * dr.glow, 1.0);
}

@fragment fn fs_bg(v: VOut) -> @location(0) vec4f {
  let y = v.uv.y;
  var c = mix(pal(0.14), pal(0.0), smoothstep(0.0, 1.0, y));
  // a soft glow where the light comes from
  let g = v.uv - vec2f(0.3, 0.25);
  c += pal(0.4) * exp(-dot(g, g) * 5.0) * 0.12;
  return vec4f(c * dr.bg, 1.0);
}
