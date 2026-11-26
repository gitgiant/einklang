// Instanced glyph quads. Per glyph: screen rect (px, y down), atlas uv rect, colour (rgb) + alpha.
struct U { /** target w, h; msdf (1/0); msdf range */ dims: vec4f, /** screen px per atlas px */ look: vec4f };
struct G { rect: vec4f, uv: vec4f, col: vec4f };
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var<storage, read> glyphs: array<G>;
@group(0) @binding(2) var atlas: texture_2d<f32>;
@group(0) @binding(3) var samp: sampler;

struct QOut { @builtin(position) pos: vec4f, @location(0) uv: vec2f, @location(1) col: vec4f };

@vertex fn vs_glyph(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> QOut {
  let g = glyphs[ii];
  let corners = array<vec2f, 6>(vec2f(0, 0), vec2f(1, 0), vec2f(1, 1), vec2f(0, 0), vec2f(1, 1), vec2f(0, 1));
  let c = corners[vi];
  let px = g.rect.xy + c * g.rect.zw;
  var out: QOut;
  out.pos = vec4f(px.x / u.dims.x * 2.0 - 1.0, 1.0 - px.y / u.dims.y * 2.0, 0.0, 1.0);
  out.uv = mix(g.uv.xy, g.uv.zw, c);
  out.col = g.col;
  return out;
}

@fragment fn fs_glyph(v: QOut) -> @location(0) vec4f {
  let s = textureSampleLevel(atlas, samp, v.uv, 0.0);
  var a: f32;
  if (u.dims.z > 0.5) { a = font_msdf(s, u.dims.w, u.look.x); } else { a = step(0.5, s.r); }
  let alpha = a * v.col.a;
  return vec4f(v.col.rgb * alpha, alpha);
}
