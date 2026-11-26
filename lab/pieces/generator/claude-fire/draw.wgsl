// Heat through the palette. The fuel rows stay below the bottom of the picture.

struct Draw {
  size: vec2f, pal_n: f32, glow: f32,
  pal: array<vec4f, 8>, // OKLab stops
};
@group(0) @binding(0) var<uniform> dr: Draw;
@group(0) @binding(1) var<storage, read> heat: array<f32>;

fn cell(x: i32, y: i32) -> f32 {
  let w = i32(dr.size.x);
  let h = i32(dr.size.y);
  return heat[u32(clamp(y, 0, h - 1) * w + clamp(x, 0, w - 1))];
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
  let p = v.uv * (dr.size - vec2f(0.0, 4.0)) - 0.5;
  let i = vec2i(floor(p));
  let f = p - floor(p);
  let h = mix(mix(cell(i.x, i.y), cell(i.x + 1, i.y), f.x), mix(cell(i.x, i.y + 1), cell(i.x + 1, i.y + 1), f.x), f.y);
  let x = clamp(h, 0.0, 1.0);
  var col = pal(x) * smoothstep(0.015, 0.22, x);
  col += pal(1.0) * smoothstep(0.85, 1.5, h) * 0.5; // white-hot core above 1
  return vec4f(col * dr.glow, 1.0);
}
