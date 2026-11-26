// Particle splats for the flow field, additive into the HDR scene target.

struct Draw {
  res: vec2f,
  off: vec2f,
  scale: f32,
  hue: f32,     // base hue in turns
  energy: f32,  // 0..1
  size: f32,    // splat radius in px
};
@group(0) @binding(0) var<uniform> D: Draw;
@group(0) @binding(1) var<storage, read> P: array<vec4i>;

struct FOut {
  @builtin(position) pos: vec4f,
  @location(0) q: vec2f,
  @location(1) col: vec3f,
};

@vertex fn vs_flow(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> FOut {
  let p = P[ii];
  let pos = vec2f(f32(p.x), f32(p.y)) / 65536.0;
  let vel = vec2f(f32(p.z), f32(p.w)) / 65536.0;
  let speed = length(vel);
  var quad = array<vec2f, 6>(vec2f(-1, -1), vec2f(1, -1), vec2f(-1, 1), vec2f(-1, 1), vec2f(1, -1), vec2f(1, 1));
  let q = quad[vi];
  let px = pos * D.scale + D.off + q * D.size;
  var o: FOut;
  o.pos = vec4f(px.x / D.res.x * 2.0 - 1.0, 1.0 - px.y / D.res.y * 2.0, 0.0, 1.0);
  o.q = q;
  let h = D.hue + atan2(vel.y, vel.x) / 6.2831853 * 0.35;
  let b = 0.05 + min(speed * 0.05, 0.4) * (0.4 + D.energy);
  o.col = hsv2rgb(h, 0.75, 1.0) * b;
  return o;
}

@fragment fn fs_flow(in: FOut) -> @location(0) vec4f {
  let a = max(0.0, 1.0 - dot(in.q, in.q));
  return vec4f(in.col * a * a, 0.0);
}
