// Colour pass: B concentration through the palette, embossed by its gradient (cheap relief light).

struct Draw {
  size: vec2f, pal_n: f32, glow: f32,
  kick: f32, rms: f32, shift: f32, relief: f32,
  pal: array<vec4f, 8>, // OKLab stops
};
@group(0) @binding(0) var<uniform> dr: Draw;
@group(0) @binding(1) var<storage, read> cells: array<vec2f>;

fn cell(x: i32, y: i32) -> f32 {
  let w = i32(dr.size.x);
  let h = i32(dr.size.y);
  return cells[u32(clamp(y, 0, h - 1) * w + clamp(x, 0, w - 1))].y;
}

fn sample_b(q: vec2f) -> f32 {
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
  let q = v.uv * dr.size;
  let b = sample_b(q);
  let gx = sample_b(q + vec2f(1.0, 0.0)) - sample_b(q - vec2f(1.0, 0.0));
  let gy = sample_b(q + vec2f(0.0, 1.0)) - sample_b(q - vec2f(0.0, 1.0));
  let n = normalize(vec3f(-gx * dr.relief, -gy * dr.relief, 0.08));
  let lit = max(dot(n, normalize(vec3f(-0.5, -0.6, 0.6))), 0.0);
  let spec = pow(max(dot(n, normalize(vec3f(-0.25, -0.3, 1.0))), 0.0), 24.0);
  let s = smoothstep(0.06, 0.32, b);
  // ping-pong along the palette (no seam) as `shift` drifts
  let body = pal(1.0 - abs(fract((s * 0.8 + dr.shift) * 0.5) * 2.0 - 1.0));
  let base = pal(0.0) * 0.06 * (1.0 - s);
  let gain = 0.25 + 0.95 * lit + 0.4 * dr.rms + 0.35 * dr.kick;
  var col = base + body * s * gain * dr.glow;
  col += pal(1.0) * spec * s * (0.5 + dr.kick) * dr.glow;
  // a thin bright line on the front of the reaction
  col += pal(0.75) * smoothstep(0.1, 0.0, abs(b - 0.12)) * 0.35 * dr.glow;
  return vec4f(col, 1.0);
}
