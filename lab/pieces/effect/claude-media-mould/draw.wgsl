// Colour pass: the veins carry the picture's own colours (trail colour / trail density), glowing
// where they are thick, over the picture dimmed to `show` (brighter right after a phrase start).

struct Draw {
  size: vec2f, pal_n: f32, glow: f32,
  kick: f32, rms: f32, shift: f32, gain: f32,
  show: f32, tint: f32, sat: f32, _p: f32,
  pal: array<vec4f, 8>, // OKLab stops
};
@group(0) @binding(0) var<uniform> dr: Draw;
@group(0) @binding(1) var<storage, read> cells: array<vec4f>;
@group(1) @binding(0) var samp: sampler;
@group(1) @binding(1) var pic: texture_2d<f32>;
@group(1) @binding(2) var lum: texture_2d<f32>;
@group(1) @binding(3) var edg: texture_2d<f32>;

fn cell(x: i32, y: i32) -> vec4f {
  let w = i32(dr.size.x);
  let h = i32(dr.size.y);
  return cells[u32(((y % h) + h) % h * w + ((x % w) + w) % w)];
}

fn sample_t(q: vec2f) -> vec4f {
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
  let f = (1.0 - abs(fract(x * 0.5) * 2.0 - 1.0)) * f32(n - 1);
  let i = min(i32(floor(f)), n - 1);
  let j = min(i + 1, n - 1);
  return lab2lin(mix(dr.pal[i].xyz, dr.pal[j].xyz, f - f32(i)));
}

@fragment fn fs_draw(v: VOut) -> @location(0) vec4f {
  let t = sample_t(v.uv * dr.size);
  let dens = t.x * dr.gain;
  let vein = 1.0 - exp(-dens * 1.2);
  var col = t.yzw / max(t.x, 1e-3);
  // pull the carried colour toward saturation so thin veins don't read grey
  let y = dot(col, vec3f(0.2126, 0.7152, 0.0722));
  col = max(mix(vec3f(y), col, dr.sat), vec3f(0.0));
  let live = textureSampleLevel(pic, samp, v.uv, 0.0).rgb;
  let core = smoothstep(0.55, 1.0, vein);
  let tint = pal(dr.shift + vein * 0.6);
  let body = mix(col, tint * (0.3 + 1.5 * y), dr.tint * (0.35 + 0.65 * core));
  var o = live * dr.show * (1.0 - 0.6 * vein);
  o += body * vein * (0.7 + 0.6 * dr.rms + 0.7 * dr.kick) * 1.6;
  o += pal(dr.shift + 0.9) * core * core * (0.15 + 0.6 * dr.kick);
  return vec4f(o * dr.glow, 1.0);
}
