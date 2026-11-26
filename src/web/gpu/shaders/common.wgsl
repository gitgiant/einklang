// Shared helpers, prepended to every shader module.

// Mirror of core/math.ts h32: u32 multiply wraps exactly like Math.imul.
fn h32(a: u32, b: u32) -> u32 {
  var x = ((a ^ 0x9e3779b9u) * 0x85ebca6bu) ^ ((b + 0x632be5abu) * 0xc2b2ae35u);
  x ^= x >> 16u; x *= 0x7feb352du; x ^= x >> 15u; x *= 0x846ca68bu; x ^= x >> 16u;
  return x;
}

fn srgb2lin(c: vec3f) -> vec3f { return pow(c, vec3f(2.2)); }

fn rgb_of(rgb: i32) -> vec3f {
  let u = bitcast<u32>(rgb);
  return srgb2lin(vec3f(f32((u >> 16u) & 255u), f32((u >> 8u) & 255u), f32(u & 255u)) / 255.0);
}

// h in turns (0..1), s, v in 0..1
fn hsv2rgb(h: f32, s: f32, v: f32) -> vec3f {
  let k = vec3f(0.0, 2.0 / 3.0, 1.0 / 3.0);
  let p = abs(fract(vec3f(h) + k) * 6.0 - 3.0);
  return v * mix(vec3f(1.0), clamp(p - 1.0, vec3f(0.0), vec3f(1.0)), s);
}

struct VOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f };

// Fullscreen triangle, uv (0,0) top-left.
@vertex fn vs_full(@builtin(vertex_index) i: u32) -> VOut {
  let p = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  var o: VOut;
  o.pos = vec4f(p * 2.0 - 1.0, 0.0, 1.0);
  o.uv = vec2f(p.x, 1.0 - p.y);
  return o;
}
