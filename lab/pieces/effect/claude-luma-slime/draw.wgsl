// Colour pass: the veins take the picture's own colours (hue kept, brightness from the trail
// density), over a dim copy of the picture; the densest veins flare toward the palette's top.

struct Draw {
  size: vec2f, pal_n: f32, glow: f32,
  gain: f32, bg: f32, flash: f32, rms: f32,
  shift: f32, sat: f32, _a: f32, _b: f32,
  pal: array<vec4f, 8>, // OKLab stops
};
@group(0) @binding(0) var<uniform> dr: Draw;
@group(0) @binding(1) var<storage, read> cells: array<f32>;
@group(0) @binding(2) var smp: sampler;
@group(0) @binding(3) var media: texture_2d<f32>;

const LW: vec3f = vec3f(0.2126, 0.7152, 0.0722);

fn wrapi(x: i32, m: i32) -> i32 { return ((x % m) + m) % m; }

fn cell(x: i32, y: i32) -> f32 {
  let w = i32(dr.size.x);
  let h = i32(dr.size.y);
  return cells[u32(wrapi(y, h) * w + wrapi(x, w))];
}

fn sample_t(q: vec2f) -> f32 {
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

fn tri(x: f32) -> f32 { return 1.0 - abs(fract(x * 0.5) * 2.0 - 1.0); }

@fragment fn fs_draw(v: VOut) -> @location(0) vec4f {
  let t = max(sample_t(v.uv * dr.size), 0.0);
  let a = 1.0 - exp(-t * dr.gain);
  let c = max(textureSampleLevel(media, smp, v.uv, 0.0).rgb, vec3f(0.0));
  let lum = dot(c, LW);
  // the picture's hue at full brightness; where it is grey or black the palette lends a colour
  let chroma = c / max(lum, 0.06) * 0.55;
  let grey = 1.0 - smoothstep(0.02, 0.12, length(c - vec3f(lum)) / max(lum, 0.02));
  let hue = mix(chroma, pal(0.35 + 0.5 * tri(dr.shift + v.uv.x * 0.4)), max(1.0 - dr.sat, grey * 0.8));
  var col = c * dr.bg + hue * a * (1.1 + 0.3 * dr.rms + dr.flash);
  col += pal(1.0) * pow(a, 4.0) * dr.glow * (0.35 + 0.8 * dr.flash);
  return vec4f(col, 1.0);
}
