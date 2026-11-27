// Colour pass: the crisp picture where the paint is home, the advected paint where the flow has
// smeared it, lit from its own brightness gradient; hot smeared spots glow in the palette.

struct Draw {
  size: vec2f, pal_n: f32, glow: f32,
  base: f32, gain: f32, light: f32, kick: f32,
  rms: f32, shift: f32, _a: f32, _b: f32,
  pal: array<vec4f, 8>, // OKLab stops
};
@group(0) @binding(0) var<uniform> dr: Draw;
@group(0) @binding(1) var<storage, read> dye: array<vec4f>;
@group(0) @binding(2) var smp: sampler;
@group(0) @binding(3) var media: texture_2d<f32>;

const LW: vec3f = vec3f(0.2126, 0.7152, 0.0722);

fn cell(x: i32, y: i32) -> vec4f {
  let w = i32(dr.size.x);
  let h = i32(dr.size.y);
  return dye[u32(clamp(y, 0, h - 1) * w + clamp(x, 0, w - 1))];
}

fn samp(q: vec2f) -> vec4f {
  let p = q - 0.5;
  let i = vec2i(floor(p));
  let f = p - floor(p);
  // smoothstep weights: softer than bilinear, no grid diamonds at low cell counts
  let s = f * f * (3.0 - 2.0 * f);
  return mix(mix(cell(i.x, i.y), cell(i.x + 1, i.y), s.x), mix(cell(i.x, i.y + 1), cell(i.x + 1, i.y + 1), s.x), s.y);
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
  let f = fract(x) * f32(n - 1);
  let i = min(i32(floor(f)), n - 1);
  let j = min(i + 1, n - 1);
  return lab2lin(mix(dr.pal[i].xyz, dr.pal[j].xyz, f - f32(i)));
}

@fragment fn fs_draw(v: VOut) -> @location(0) vec4f {
  let q = v.uv * dr.size;
  let d = samp(q);
  let crisp = max(textureSampleLevel(media, smp, v.uv, 0.0).rgb, vec3f(0.0));
  let a = clamp(dr.base + d.w * dr.gain, 0.0, 1.0);
  // relief from the paint's brightness: smeared paint reads as thick, wet strokes
  let e = 1.0;
  let gx = dot(samp(q + vec2f(e, 0.0)).rgb - samp(q - vec2f(e, 0.0)).rgb, LW);
  let gy = dot(samp(q + vec2f(0.0, e)).rgb - samp(q - vec2f(0.0, e)).rgb, LW);
  let n = normalize(vec3f(-gx * 3.0, -gy * 3.0, 1.0));
  let lit = mix(1.0, 0.6 + 0.6 * max(dot(n, normalize(vec3f(-0.5, -0.7, 0.6))), 0.0), dr.light * a);
  var col = mix(crisp, d.rgb, a) * lit;
  // freshly stirred paint glows in the palette, flaring on the beat
  let hot = smoothstep(0.45, 1.0, d.w);
  col += pal(dr.shift + 0.3 * d.w + 0.2 * v.uv.y) * hot * dr.glow * (0.12 + 0.35 * dr.kick + 0.15 * dr.rms);
  return vec4f(col, 1.0);
}
