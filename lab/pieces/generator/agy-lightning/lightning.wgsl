struct U {
  res: vec2f, aspect: f32, t: f32,
  rms: f32, flash: f32, haze: f32, bass: f32,
  col0: vec4f,
  col1: vec4f,
};

struct Seg {
  p0: vec2f,
  p1: vec2f,
  col: vec3f,
  inten: f32,
  width: f32,
  kind: f32,
  _p0: f32,
  _p1: f32,
};

@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var<storage, read> segs: array<Seg>;

// Stage atmospheric fog illuminated by Tesla coil flashes & dual laser emitters
@fragment fn fs_bg(v: VOut) -> @location(0) vec4f {
  let p = vec2f((v.uv.x * 2.0 - 1.0) * u.aspect, 1.0 - v.uv.y * 2.0);
  // Subtle animated stage haze waves
  let w1 = sin(p.x * 2.3 + u.t * 0.45) * cos(p.y * 1.9 - u.t * 0.32);
  let w2 = sin((p.x - p.y) * 3.1 - u.t * 0.6);
  let fog = 0.5 + 0.5 * (w1 * 0.6 + w2 * 0.4);

  let top_glow = exp(-max(0.0, 0.95 - p.y) * 2.2) * (0.14 + 0.35 * u.rms + 0.45 * u.flash);
  let emitter_l = exp(-length(p - vec2f(-u.aspect * 0.62, 0.96)) * 5.0);
  let emitter_r = exp(-length(p - vec2f( u.aspect * 0.62, 0.96)) * 5.0);

  var col = mix(u.col0.rgb, u.col1.rgb, v.uv.x) * (fog * u.haze * (0.04 + 0.14 * u.rms + 0.18 * u.flash));
  col += mix(u.col0.rgb, u.col1.rgb, 0.5) * top_glow * u.haze * 0.4;
  col += (u.col0.rgb * emitter_l + u.col1.rgb * emitter_r) * (0.18 + 0.65 * u.rms + 0.5 * u.bass);

  // Subtle stage floor reflection plane near bottom
  let floor_g = exp(-abs(p.y + 0.88) * 14.0) * (0.08 + 0.25 * u.rms + 0.3 * u.flash);
  col += mix(u.col0.rgb, u.col1.rgb, 0.5 + 0.3 * sin(p.x * 1.5)) * floor_g;

  return vec4f(col, 1.0);
}

struct SegOut {
  @builtin(position) pos: vec4f,
  @location(0) p: vec2f,
  @location(1) p0: vec2f,
  @location(2) p1: vec2f,
  @location(3) col: vec3f,
  @location(4) inten: f32,
  @location(5) width: f32,
  @location(6) kind: f32,
};

@vertex fn vs_seg(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> SegOut {
  let s = segs[ii];
  // Lasers get a wide volumetric cone; lightning gets a sizzling electric corona
  let pad = select(max(s.width * 5.5, 6.0 / u.res.y), max(s.width * 10.0, 0.16), s.kind > 0.5);
  let delta = s.p1 - s.p0;
  let len = length(delta);
  let dir = select(vec2f(1.0, 0.0), delta / max(len, 1e-5), len > 1e-5);
  let nrm = vec2f(-dir.y, dir.x);

  var c = vec2f(0.0);
  switch (vi) {
    case 0u: { c = vec2f(-1.0, -1.0); }
    case 1u: { c = vec2f( 1.0, -1.0); }
    case 2u: { c = vec2f( 1.0,  1.0); }
    case 3u: { c = vec2f(-1.0, -1.0); }
    case 4u: { c = vec2f( 1.0,  1.0); }
    default: { c = vec2f(-1.0,  1.0); }
  }

  let end_p = select(s.p0 - dir * (pad * 0.35), s.p1 + dir * (pad * 0.35), c.x > 0.0);
  let wp = end_p + nrm * (c.y * pad);

  var o: SegOut;
  o.pos = vec4f(wp.x / u.aspect, wp.y, 0.0, 1.0);
  o.p = wp;
  o.p0 = s.p0;
  o.p1 = s.p1;
  o.col = s.col;
  o.inten = s.inten;
  o.width = s.width;
  o.kind = s.kind;
  return o;
}

@fragment fn fs_seg(v: SegOut) -> @location(0) vec4f {
  if (v.inten <= 0.001) { discard; }
  let pa = v.p - v.p0;
  let ba = v.p1 - v.p0;
  let bb = dot(ba, ba);
  let h = select(0.0, clamp(dot(pa, ba) / max(bb, 1e-8), 0.0, 1.0), bb > 1e-8);
  let d = length(pa - ba * h);

  if (v.kind > 0.5) {
    // Volumetric concert laser: razor core + smoothly windowed atmospheric beam cone (zero quad edge)
    let pad = max(v.width * 10.0, 0.16);
    let edge_fade = smoothstep(pad, pad * 0.2, d);
    let w_core = max(v.width * (0.32 + 0.55 * h), 1.6 / u.res.y);
    let w_cone = max(v.width * (1.2 + 2.6 * h), 0.012);
    let core = exp(-d * d / (w_core * w_core));
    let cone = exp(-d / w_cone) * (0.28 + 0.32 * u.haze) * edge_fade;
    let atten = (1.0 - 0.55 * h) * smoothstep(0.0, 0.03, h);
    let hot = mix(v.col, vec3f(1.0, 0.99, 1.0), 0.62);
    return vec4f((hot * core * 0.9 + v.col * cone * 0.5) * v.inten * atten, 1.0);
  }

  // High-voltage fractal lightning bolt: incandescent white core + vivid plasma corona
  let w = max(v.width, 1.8 / u.res.y);
  let core = exp(-d * d / (w * w * 0.25));
  let corona = exp(-d / (w * 1.8));
  let aura = exp(-d / (w * 4.2)) * 0.28;
  let hot = mix(v.col, vec3f(0.96, 0.98, 1.0), 0.85);
  return vec4f((hot * core * 1.45 + v.col * (corona * 0.85 + aura)) * v.inten, 1.0);
}
