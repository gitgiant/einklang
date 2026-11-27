// Two passes. Splat: every particle adds a soft (1 - d^2)^2 blob of density (r) and speed (g) into a
// half-resolution target, placed through the tank's tilt and shake. Composite: the summed density
// is thresholded into a smooth liquid surface, shaded from its gradient (a bump normal) with a rim,
// a specular glint, foam where it moves fast and the back-wall tiles refracted through it; loose
// drops glow as spray; then the glass walls and the bass paddle on top.

struct Draw {
  center: vec2f, scale: f32, ang: f32,     // tank centre (uv, shake included), height units per tank unit, tilt
  aspect: f32, tw: f32, th: f32, rad: f32, // splat radius in tank units
  norm: f32, thresh: f32, paddle: f32, kick: f32,
  glow: f32, foam: f32, bg: f32, shift: f32,
  rms: f32, pal_n: f32, px: f32, wall: f32,  // px: one pixel in tank units
  pal: array<vec4f, 8>,
};
@group(0) @binding(0) var<uniform> dr: Draw;
@group(0) @binding(1) var<storage, read> P: array<vec4f>;
@group(0) @binding(2) var dens: texture_2d<f32>;
@group(0) @binding(3) var smp: sampler;

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

fn rot(v: vec2f, a: f32) -> vec2f {
  let c = cos(a);
  let s = sin(a);
  return vec2f(v.x * c - v.y * s, v.x * s + v.y * c);
}

fn tank2uv(t: vec2f) -> vec2f {
  let r = rot(t - vec2f(dr.tw, dr.th) * 0.5, dr.ang) * dr.scale;
  return vec2f(dr.center.x + r.x / dr.aspect, dr.center.y - r.y);
}

fn uv2tank(uv: vec2f) -> vec2f {
  let r = vec2f((uv.x - dr.center.x) * dr.aspect, dr.center.y - uv.y) / dr.scale;
  return rot(r, -dr.ang) + vec2f(dr.tw, dr.th) * 0.5;
}

struct SOut { @builtin(position) pos: vec4f, @location(0) q: vec2f, @location(1) speed: f32 };

@vertex fn vs_splat(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> SOut {
  var corners = array<vec2f, 6>(vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(-1.0, 1.0), vec2f(-1.0, 1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0));
  let q = corners[vi];
  let p = P[ii];
  let uv = tank2uv(p.xy + q * dr.rad);
  var o: SOut;
  o.pos = vec4f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0, 0.0, 1.0);
  o.q = q;
  o.speed = length(p.zw);
  return o;
}

@fragment fn fs_splat(v: SOut) -> @location(0) vec4f {
  let d2 = dot(v.q, v.q);
  if (d2 >= 1.0) { discard; }
  let w = (1.0 - d2) * (1.0 - d2);
  return vec4f(w, w * v.speed, 0.0, 0.0);
}

fn sd_seg(p: vec2f, a: vec2f, b: vec2f) -> f32 {
  let pa = p - a;
  let ba = b - a;
  let h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
  return length(pa - ba * h);
}

// back wall: dark tiles, a little caustic shimmer near the floor
fn backwall(t: vec2f) -> vec3f {
  let g = abs(fract(t / 0.1) - 0.5);
  let line = smoothstep(0.44, 0.5, max(g.x, g.y));
  return pal(0.06) * 1.2 + pal(0.35) * line * 0.22;
}

@fragment fn fs_comp(v: VOut) -> @location(0) vec4f {
  let uv = v.uv;
  let ts = 1.0 / vec2f(textureDimensions(dens));
  let d = textureSampleLevel(dens, smp, uv, 0.0);
  let f = d.r * dr.norm;
  let fxp = textureSampleLevel(dens, smp, uv + vec2f(ts.x, 0.0), 0.0).r;
  let fxm = textureSampleLevel(dens, smp, uv - vec2f(ts.x, 0.0), 0.0).r;
  let fyp = textureSampleLevel(dens, smp, uv + vec2f(0.0, ts.y), 0.0).r;
  let fym = textureSampleLevel(dens, smp, uv - vec2f(0.0, ts.y), 0.0).r;
  let grad = vec2f(fxp - fxm, fyp - fym) * dr.norm;
  let aa = max(fwidth(f), 1e-3);
  let speed = d.g / max(d.r, 1e-4);
  let t = uv2tank(uv);

  // backdrop: darkest stops, a soft pool of light behind the tank
  let c = (uv - vec2f(0.5, 0.55)) * vec2f(dr.aspect, 1.0);
  var bg = mix(pal(0.0), pal(0.1), exp(-dot(c, c) * 2.2)) * dr.bg * (0.85 + 0.5 * dr.kick);
  let inside = step(0.0, t.x) * step(t.x, dr.tw) * step(0.0, t.y) * step(t.y, dr.th);

  // liquid
  let body = smoothstep(dr.thresh - aa, dr.thresh + aa, f);
  let n = normalize(vec3f(-grad.x * 2.5, grad.y * 2.5, 1.0));
  let L = normalize(vec3f(-0.45, 0.65, 0.6));
  let diff = max(dot(n, L), 0.0);
  let spec = pow(max(dot(reflect(-L, n), vec3f(0.0, 0.0, 1.0)), 0.0), 24.0);
  let depth = clamp(t.y / (dr.th * 0.65), 0.0, 1.2);
  let rim = 1.0 - smoothstep(dr.thresh, dr.thresh + 0.45, f);
  let foam = smoothstep(0.7, 2.2, speed) * dr.foam;
  let seen = backwall(t + n.xy * 0.05);
  var water = pal(0.22 + 0.4 * depth + dr.shift) * (0.45 + 0.75 * diff);
  water = mix(water, seen * 1.6 + water * 0.5, 0.25);
  water += pal(0.82) * rim * 0.75 + pal(1.0) * spec * 1.2;
  water = mix(water, pal(0.97) * 1.4, clamp(foam, 0.0, 0.85));
  water *= dr.glow * (0.8 + 0.5 * dr.rms + 0.35 * dr.kick);

  var col = mix(bg, backwall(t), inside * 0.85);
  col = mix(col, water, body);
  // spray: loose drops below the threshold still glow
  let spray = smoothstep(0.04, dr.thresh, f) * (1.0 - body);
  col += pal(0.9) * spray * (0.6 + 0.8 * foam) * dr.glow;

  // glass: an open-topped U, and the paddle the bass drives
  let px = dr.px;
  let gw = 0.012;
  let dg = min(min(sd_seg(t, vec2f(0.0, 0.0), vec2f(0.0, dr.th)), sd_seg(t, vec2f(dr.tw, 0.0), vec2f(dr.tw, dr.th))), sd_seg(t, vec2f(0.0, 0.0), vec2f(dr.tw, 0.0)));
  let glass = 1.0 - smoothstep(gw - px, gw + px, dg);
  let edge = 1.0 - smoothstep(0.0, 2.5 * px, abs(dg - gw * 0.4));
  col = mix(col, pal(0.7) * (0.55 + 0.9 * dr.kick), glass * 0.55) + pal(1.0) * edge * (0.25 + 0.8 * dr.kick);
  let dp = sd_seg(t, vec2f(dr.paddle, 0.03), vec2f(dr.paddle, dr.th * 0.7));
  let pw = 0.008;
  let pad = 1.0 - smoothstep(pw - px, pw + px, dp);
  col = mix(col, pal(0.9) * (0.6 + 4.0 * (dr.paddle - dr.wall)), pad * 0.9);
  return vec4f(max(col, vec3f(0.0)), 1.0);
}
