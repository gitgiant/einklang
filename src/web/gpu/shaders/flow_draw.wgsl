// Particle splats for the flow field, additive into the HDR scene target.

struct Draw {
  res: vec2f,
  off: vec2f,
  scale: f32,
  hue: f32,     // base hue in turns
  energy: f32,  // 0..1
  size: f32,    // splat radius in px
  time: f32,    // ticks (mod 36000) + sub-tick, for the dust
  gain: f32,    // FLOW_N_DEFAULT / N: the same total light whatever the particle count
  dust: f32,    // dust brightness (higher when it stands in for the sim on a weak host)
  _p2: f32,
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
  o.col = hsv2rgb(h, 0.75, 1.0) * b * D.gain;
  return o;
}

// Dust: decorative, closed-form particles a strong GPU adds on top of the room's N (or a weak
// host shows alone until N drops). Each drifts on its own seeded heading with a slow wobble.
@vertex fn vs_dust(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> FOut {
  let h0 = h32(ii, 0xd057u);
  let h1 = h32(ii, 0xd058u);
  let base = vec2f(f32(h0 & 0xffffu) / 65536.0 * 1280.0, f32(h0 >> 16u) / 65536.0 * 720.0);
  let ang = f32(h1 & 0xffffu) / 65536.0 * 6.2831853;
  let speed = 0.15 + f32((h1 >> 16u) & 255u) / 255.0 * 0.6;
  let t = D.time;
  let wob = vec2f(sin(t * 0.021 + f32(h1 >> 24u)), cos(t * 0.017 + f32(h0 >> 24u))) * 14.0;
  var pos = base + vec2f(cos(ang), sin(ang)) * speed * t + wob;
  pos = pos - floor(pos / vec2f(1280.0, 720.0)) * vec2f(1280.0, 720.0);
  var quad = array<vec2f, 6>(vec2f(-1, -1), vec2f(1, -1), vec2f(-1, 1), vec2f(-1, 1), vec2f(1, -1), vec2f(1, 1));
  let q = quad[vi];
  let px = pos * D.scale + D.off + q * D.size * 0.8;
  var o: FOut;
  o.pos = vec4f(px.x / D.res.x * 2.0 - 1.0, 1.0 - px.y / D.res.y * 2.0, 0.0, 1.0);
  o.q = q;
  o.col = hsv2rgb(D.hue + 0.5 + f32(h0 & 255u) / 255.0 * 0.15, 0.5, 1.0) * (0.03 + 0.05 * D.energy) * D.dust;
  return o;
}

@fragment fn fs_flow(in: FOut) -> @location(0) vec4f {
  let a = max(0.0, 1.0 - dot(in.q, in.q));
  return vec4f(in.col * a * a, 0.0);
}
