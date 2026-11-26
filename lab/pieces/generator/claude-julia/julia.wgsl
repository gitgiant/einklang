// Julia set (z -> z^2 + c) or a 2D mandelbox (box fold, ball fold, scale, + c), escape-time with
// smooth colouring through the palette, a distance-estimate glow on the boundary and an orbit trap
// shading the interior.

struct U {
  res: vec2f, aspect: f32, time: f32,
  c: vec2f, zoom: f32, rot: f32,
  center: vec2f, mode: f32, iters: f32,
  glow: f32, kick: f32, shift: f32, pal_n: f32,
  box: f32, edge: f32, rms: f32, density: f32,
  aa: f32, inner: f32, _a: f32, _b: f32,
  pal: array<vec4f, 8>,
};
@group(0) @binding(0) var<uniform> u: U;

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

// ping-pong along the palette so the bands never hit a seam
fn ppal(x: f32) -> vec3f { return pal(1.0 - abs(fract(x * 0.5) * 2.0 - 1.0)); }

struct Hit { mu: f32, de: f32, trap: f32, esc: bool };

fn julia(p: vec2f) -> Hit {
  var z = p;
  var dz = vec2f(1.0, 0.0);
  var trap = 1e9;
  var h: Hit;
  h.esc = false;
  let n = i32(u.iters);
  for (var i = 0; i < n; i++) {
    dz = 2.0 * vec2f(z.x * dz.x - z.y * dz.y, z.x * dz.y + z.y * dz.x);
    z = vec2f(z.x * z.x - z.y * z.y, z.x * z.y * 2.0) + u.c;
    let r2 = dot(z, z);
    trap = min(trap, abs(length(z - u.c * 0.5) - 0.25));
    if (r2 > 1024.0) {
      h.esc = true;
      h.mu = f32(i) + 1.0 - log2(log2(r2) * 0.5);
      let r = sqrt(r2);
      h.de = 0.5 * r * log(r) / max(length(dz), 1e-20);
      break;
    }
  }
  h.trap = trap;
  return h;
}

fn mandelbox(p: vec2f) -> Hit {
  let c = p + u.c * 0.6;
  var z = p;
  var dr = 1.0;
  var trap = 1e9;
  var h: Hit;
  h.esc = false;
  let s = u.box;
  let n = i32(u.iters);
  for (var i = 0; i < n; i++) {
    z = clamp(z, vec2f(-1.0), vec2f(1.0)) * 2.0 - z;
    let r2 = dot(z, z);
    if (r2 < 0.25) { z *= 4.0; dr *= 4.0; }
    else if (r2 < 1.0) { z /= r2; dr /= r2; }
    z = z * s + c;
    dr = dr * abs(s) + 1.0;
    trap = min(trap, abs(z.x * z.y));
    let q = dot(z, z);
    if (q > 4096.0) {
      h.esc = true;
      h.mu = f32(i) + 1.0 - clamp(log(log(q) / log(4096.0)) / log(abs(s)), 0.0, 1.0);
      h.de = sqrt(q) / abs(dr);
      break;
    }
  }
  h.trap = trap;
  return h;
}

fn shade_at(px: vec2f) -> vec3f {
  // px: pixel position; plane coordinates centred, rotated, zoomed
  let q = (px / u.res - 0.5) * vec2f(u.aspect, 1.0);
  let cs = cos(u.rot);
  let sn = sin(u.rot);
  let view = select(1.4, 5.0, u.mode > 0.5);
  let p = vec2f(q.x * cs - q.y * sn, q.x * sn + q.y * cs) * view / u.zoom + u.center;
  var h: Hit;
  if (u.mode > 0.5) { h = mandelbox(p); } else { h = julia(p); }
  // boundary glow: distance estimate in pixels
  let pxsize = view / (u.zoom * u.res.y);
  let dpx = h.de / pxsize;
  if (h.esc) {
    let x = h.mu * u.density + u.shift;
    let fall = 1.0 - exp(-h.mu * 0.08);
    var col = ppal(x) * (0.15 + 0.85 * fall);
    let e = exp(-dpx / max(u.edge, 0.05));
    col += pal(1.0) * e * (0.6 + 1.4 * u.kick + 0.5 * u.rms);
    return col * u.glow;
  }
  // interior: dark, the orbit trap draws faint rings
  let t = exp(-h.trap * 8.0);
  return (pal(0.0) * 0.4 + pal(0.35) * t * 0.6) * u.inner * u.glow * (0.7 + 0.6 * u.kick);
}

@fragment fn fs_julia(v: VOut) -> @location(0) vec4f {
  let px = v.uv * u.res;
  if (u.aa < 1.5) { return vec4f(shade_at(px), 1.0); }
  var col = vec3f(0.0);
  col += shade_at(px + vec2f(-0.25, -0.25));
  col += shade_at(px + vec2f(0.25, -0.25));
  col += shade_at(px + vec2f(-0.25, 0.25));
  col += shade_at(px + vec2f(0.25, 0.25));
  return vec4f(col * 0.25, 1.0);
}
