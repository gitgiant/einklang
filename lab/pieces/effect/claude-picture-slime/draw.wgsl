// Colour pass: trail density tone-mapped. The veins take the picture's own colours (picture), the
// palette (palette) or the palette in thin veins and the picture in the dense cores (both); the
// picture shows dimly underneath (under).

struct Draw {
  size: vec2f, pal_n: f32, glow: f32,
  kick: f32, rms: f32, shift: f32, mode: f32,
  gain: f32, under: f32, sat: f32, _c: f32,
  pal: array<vec4f, 8>,
};
@group(0) @binding(0) var<uniform> dr: Draw;
@group(0) @binding(1) var<storage, read> cells: array<f32>;
@group(0) @binding(2) var smp: sampler;
@group(0) @binding(3) var tpic: texture_2d<f32>;

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

@fragment fn fs_draw(v: VOut) -> @location(0) vec4f {
  let t = sample_t(v.uv * dr.size);
  let k = 1.0 - exp(-t * dr.gain);
  var pic = textureSampleLevel(tpic, smp, v.uv, 0.0).rgb;
  let lum = dot(pic, vec3f(0.2126, 0.7152, 0.0722));
  // vein colour from the picture: saturated, and lifted so dark areas still show their hue
  var vein = max(mix(vec3f(lum), pic, dr.sat), vec3f(0.0));
  vein = vein / max(max(vein.r, max(vein.g, vein.b)), 0.08) * (0.35 + 0.65 * sqrt(clamp(lum * 2.0, 0.0, 1.0)));
  let x = 1.0 - abs(fract((0.15 + 0.85 * k + dr.shift) * 0.5) * 2.0 - 1.0);
  let pc = pal(x);
  var vc: vec3f;
  if (dr.mode < 0.5) { vc = vein; }
  else if (dr.mode < 1.5) { vc = pc; }
  else { vc = mix(pc, vein * 1.2, smoothstep(0.35, 0.9, k)); }
  let lift = dr.glow * (0.8 + 0.4 * dr.rms + 0.7 * dr.kick);
  var col = pic * dr.under + vc * k * lift;
  // hot cores flare on onsets
  col += mix(pal(1.0), vein, 0.5) * smoothstep(0.75, 1.0, k) * dr.kick * 0.7 * dr.glow;
  return vec4f(col, 1.0);
}
