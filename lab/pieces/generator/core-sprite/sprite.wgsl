// Pixel-perfect sprite sheet, drawn per fragment: which cell, which sprite pixel, which frame.
struct U {
  /** target w, h; sprite w, h (pixels) */
  dims: vec4f,
  /** centre x, y (uv); scale (screen px per sprite px, whole); mode */
  place: vec4f,
  /** frame (base), frames, count, bounce offset (screen px) */
  anim: vec4f,
  /** swap, outline, glow, time */
  look: vec4f,
  pal: array<vec4f, 8>,
};
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var sheet: texture_2d_array<f32>;

fn pal_at(t: f32) -> vec3f { let x = clamp(t, 0.0, 0.999) * 7.0; let i = i32(x); return mix(u.pal[i].rgb, u.pal[i + 1].rgb, x - f32(i)); }

fn texel(p: vec2i, layer: i32) -> vec4f {
  let sz = vec2i(u.dims.zw);
  if (p.x < 0 || p.y < 0 || p.x >= sz.x || p.y >= sz.y) { return vec4f(0.0); }
  return textureLoad(sheet, p, layer, 0);
}

@fragment fn fs_sprite(v: VOut) -> @location(0) vec4f {
  let res = u.dims.xy; let sw = u.dims.zw; let scale = u.place.z; let mode = i32(u.place.w);
  let frames = i32(u.anim.y);
  let px = v.uv * res; // screen pixel
  let cell = sw * scale;
  var k = 0; // which sprite (row/tile), for its phase
  var local: vec2f;
  if (mode == 2) {
    let c = floor(px / cell); k = i32(c.x + c.y * 7.0);
    local = px - c * cell;
    local.y += u.anim.w * select(0.0, 1.0, (i32(c.x + c.y) & 1) == 0) * 0.3;
  } else {
    let n = select(1.0, u.anim.z, mode == 1);
    let gap = cell.x * 0.25;
    let total = n * cell.x + (n - 1.0) * gap;
    let origin = vec2f(u.place.x * res.x - total * 0.5, u.place.y * res.y - cell.y * 0.5 - u.anim.w);
    let rel = px - origin;
    let slot = floor(rel.x / (cell.x + gap));
    if (slot < 0.0 || slot >= n) { return vec4f(0.0); }
    k = i32(slot);
    local = vec2f(rel.x - slot * (cell.x + gap), rel.y);
    // a row bounces in a wave
    if (mode == 1) { local.y += sin(u.look.w * 6.0 + slot * 0.9) * u.anim.w * 0.5; }
  }
  let sp = vec2i(floor(local / scale));
  let layer = (i32(u.anim.x) + k) % frames;
  let c = texel(sp, layer);
  if (c.a < 0.5) {
    // outline: any opaque 4-neighbour
    if (u.look.y > 0.0) {
      let o = max(max(texel(sp + vec2i(1, 0), layer).a, texel(sp - vec2i(1, 0), layer).a), max(texel(sp + vec2i(0, 1), layer).a, texel(sp - vec2i(0, 1), layer).a));
      if (o > 0.5) { return vec4f(vec3f(0.02), u.look.y); }
    }
    return vec4f(0.0);
  }
  let lin = pow(c.rgb, vec3f(2.2));
  let luma = dot(lin, vec3f(0.2126, 0.7152, 0.0722));
  let col = mix(lin, pal_at(pow(luma, 0.5)) * (0.4 + luma), u.look.x);
  return vec4f(col * u.look.z, 1.0);
}
