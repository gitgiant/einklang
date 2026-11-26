// Instanced sprite quads. Per instance: centre (uv), size (uv height), rotation, frame, alpha, tint colour.
struct U { dims: vec4f, /** sprite w, h, frames, glow */ sheet: vec4f };
struct P { pos: vec2f, size: f32, rot: f32, frame: f32, alpha: f32, pad: vec2f, tint: vec4f };
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var<storage, read> parts: array<P>;
@group(0) @binding(2) var sheet: texture_2d_array<f32>;

struct QOut { @builtin(position) pos: vec4f, @location(0) st: vec2f, @location(1) @interpolate(flat) frame: i32, @location(2) alpha: f32, @location(3) tint: vec4f };

@vertex fn vs_quad(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> QOut {
  let p = parts[ii];
  let corners = array<vec2f, 6>(vec2f(0, 0), vec2f(1, 0), vec2f(1, 1), vec2f(0, 0), vec2f(1, 1), vec2f(0, 1));
  let st = corners[vi];
  let aspect = u.dims.x / u.dims.y;
  let half = vec2f(p.size * u.sheet.x / u.sheet.y, p.size) * 0.5;
  let c = cos(p.rot); let s = sin(p.rot);
  let o = (st - 0.5) * 2.0 * half;
  let r = vec2f(o.x * c - o.y * s, o.x * s + o.y * c);
  // uv space: x in screen heights / aspect
  let uv = p.pos + vec2f(r.x / aspect, r.y);
  var out: QOut;
  out.pos = vec4f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0, 0.0, 1.0);
  out.st = st; out.frame = i32(p.frame); out.alpha = p.alpha; out.tint = p.tint;
  return out;
}

@fragment fn fs_quad(v: QOut) -> @location(0) vec4f {
  let px = vec2i(clamp(floor(v.st * u.sheet.xy), vec2f(0.0), u.sheet.xy - 1.0));
  let c = textureLoad(sheet, px, v.frame, 0);
  if (c.a < 0.5) { discard; }
  let lin = pow(c.rgb, vec3f(2.2));
  let col = mix(lin, lin * v.tint.rgb * 2.0, v.tint.a) * u.sheet.w;
  return vec4f(col * v.alpha, v.alpha);
}
