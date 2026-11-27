// Swarm draw: every bird is a soft streak along its velocity, coloured by the picture under it,
// added into an HDR accumulation target; fs_resolve tone-maps that over a dim picture and the sky.

struct Draw {
  res: vec2f, aspect: f32, size: f32,
  streak: f32, gain: f32, cruise: f32, kick: f32,
  under: f32, sat: f32, pal_n: f32, shift: f32,
  sky: f32, flash: f32, _a: f32, _b: f32,
  pal: array<vec4f, 8>,
};
@group(0) @binding(0) var<uniform> dr: Draw;
@group(0) @binding(1) var<storage, read> birds: array<vec4f>;
@group(0) @binding(2) var smp: sampler;
@group(0) @binding(3) var tpic: texture_2d<f32>;
@group(0) @binding(4) var tacc: texture_2d<f32>;

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

struct BOut { @builtin(position) pos: vec4f, @location(0) q: vec2f, @location(1) col: vec3f };

@vertex fn vs_bird(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> BOut {
  let b = birds[ii];
  let corner = array<vec2f, 6>(vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(-1.0, 1.0), vec2f(-1.0, 1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0))[vi];
  let sp = length(b.zw);
  let dir = select(vec2f(1.0, 0.0), b.zw / sp, sp > 1e-5);
  let px = 1.0 / dr.res.y; // one pixel in screen heights
  let w = dr.size * px * (1.0 + 0.6 * dr.kick);
  let len = w * (1.0 + dr.streak * sp / max(dr.cruise, 1e-3));
  let off = dir * corner.x * len + vec2f(-dir.y, dir.x) * corner.y * w;
  let p = b.xy + off;
  var o: BOut;
  o.pos = vec4f(p.x / dr.aspect * 2.0 - 1.0, 1.0 - p.y * 2.0, 0.0, 1.0);
  o.q = corner;
  let uv = clamp(vec2f(b.x / dr.aspect, b.y), vec2f(0.0), vec2f(1.0));
  var c = textureSampleLevel(tpic, smp, uv, 0.0).rgb;
  let l = dot(c, vec3f(0.2126, 0.7152, 0.0722));
  c = max(mix(vec3f(l), c, dr.sat), vec3f(0.0));
  // keep the hue in the dark parts, a bird is never black
  c = c / max(max(c.r, max(c.g, c.b)), 0.1) * (0.3 + 0.7 * sqrt(clamp(l * 1.6, 0.0, 1.0)));
  o.col = c * (1.0 + sp / max(dr.cruise, 1e-3) * 0.3);
  return o;
}

@fragment fn fs_bird(v: BOut) -> @location(0) vec4f {
  let r2 = dot(v.q, v.q);
  let a = exp(-r2 * 3.0) * step(r2, 1.0);
  return vec4f(v.col * a * dr.gain, 1.0);
}

@fragment fn fs_resolve(v: VOut) -> @location(0) vec4f {
  let acc = textureSampleLevel(tacc, smp, v.uv, 0.0).rgb;
  let pic = textureSampleLevel(tpic, smp, v.uv, 0.0).rgb;
  // soft-clip the pile-ups but keep the hue
  let m = max(acc.r, max(acc.g, acc.b));
  var col = acc / (1.0 + 0.35 * m) * (1.0 + dr.flash * dr.kick);
  let sky = pal(0.08) * dr.sky * (1.0 - 0.6 * v.uv.y);
  col += pic * dr.under + sky;
  return vec4f(col, 1.0);
}
