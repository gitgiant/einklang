struct U {
  res: vec2f, aspect: f32, t: f32,
  rms: f32, kick: f32, width: f32, glow: f32,
  grid: f32, phase: f32, is_on: f32, _pad: f32,
  gcol: vec4f,
};

struct Seg {
  p0: vec2f,
  p1: vec2f,
  col: vec3f,
  inten: f32,
};

@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var<storage, read> segs: array<Seg>;

// Background: dark oscilloscope glass with reactive polar/cartesian graticule
@fragment fn fs_bg(v: VOut) -> @location(0) vec4f {
  let p = vec2f((v.uv.x * 2.0 - 1.0) * u.aspect, 1.0 - v.uv.y * 2.0);
  let r = length(p);

  // Deep phosphor glass base + gentle center radial glow driven by audio
  var col = u.gcol.rgb * (0.012 + (0.03 + 0.06 * u.rms + 0.05 * u.kick) * exp(-r * r * 1.4));

  if (u.grid > 0.001) {
    let px = 2.0 / u.res.y;
    // Cartesian divisions every 0.25 units
    let g = abs(fract(p * 4.0 + 0.5) - 0.5) / 4.0;
    let dline = min(g.x, g.y);
    let major = smoothstep(px * 1.5, px * 0.3, dline) * 0.22;

    // Fine center axes with tick marks
    let ax = min(abs(p.x), abs(p.y));
    let axis = smoothstep(px * 1.8, px * 0.4, ax) * 0.55;
    let tick_x = smoothstep(px * 1.4, px * 0.3, abs(fract(p.x * 20.0 + 0.5) - 0.5) / 20.0) * step(abs(p.y), 0.022);
    let tick_y = smoothstep(px * 1.4, px * 0.3, abs(fract(p.y * 20.0 + 0.5) - 0.5) / 20.0) * step(abs(p.x), 0.022);

    // Polar rings pulsing softly with beat phase
    let ring_r1 = abs(r - (0.45 + 0.02 * u.kick));
    let ring_r2 = abs(r - 0.82);
    let rings = (smoothstep(px * 1.6, px * 0.4, ring_r1) * 0.45 + smoothstep(px * 1.6, px * 0.4, ring_r2) * 0.28);

    // Subtle radial vignette on graticule
    let mask = smoothstep(1.65, 0.25, r);
    let grat = (major + axis + (tick_x + tick_y) * 0.5 + rings) * mask;
    col += u.gcol.rgb * grat * u.grid * (0.28 + 0.25 * u.rms + 0.35 * u.kick);
  }
  return vec4f(col, 1.0);
}

struct SegOut {
  @builtin(position) pos: vec4f,
  @location(0) p: vec2f,
  @location(1) p0: vec2f,
  @location(2) p1: vec2f,
  @location(3) col: vec3f,
  @location(4) inten: f32,
};

@vertex fn vs_seg(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> SegOut {
  let s = segs[ii];
  let pad = max(u.width * 3.4, 4.0 / u.res.y);
  let delta = s.p1 - s.p0;
  let len = length(delta);
  let dir = select(vec2f(1.0, 0.0), delta / max(len, 1e-5), len > 1e-5);
  let nrm = vec2f(-dir.y, dir.x);

  // Two triangles forming an oriented quad around the capsule
  var c = vec2f(0.0);
  switch (vi) {
    case 0u: { c = vec2f(-1.0, -1.0); }
    case 1u: { c = vec2f( 1.0, -1.0); }
    case 2u: { c = vec2f( 1.0,  1.0); }
    case 3u: { c = vec2f(-1.0, -1.0); }
    case 4u: { c = vec2f( 1.0,  1.0); }
    default: { c = vec2f(-1.0,  1.0); }
  }

  let end_p = select(s.p0 - dir * pad, s.p1 + dir * pad, c.x > 0.0);
  let wp = end_p + nrm * (c.y * pad);

  var o: SegOut;
  o.pos = vec4f(wp.x / u.aspect, wp.y, 0.0, 1.0);
  o.p = wp;
  o.p0 = s.p0;
  o.p1 = s.p1;
  o.col = s.col;
  o.inten = s.inten;
  return o;
}

@fragment fn fs_seg(v: SegOut) -> @location(0) vec4f {
  if (v.inten <= 0.0001) { discard; }
  let pa = v.p - v.p0;
  let ba = v.p1 - v.p0;
  let bb = dot(ba, ba);
  let h = select(0.0, clamp(dot(pa, ba) / max(bb, 1e-8), 0.0, 1.0), bb > 1e-8);
  let d = length(pa - ba * h);

  let w = max(u.width, 1.5 / u.res.y);
  let core = exp(-d * d / (w * w * 0.22));
  let halo = exp(-d / (w * 1.45));
  let aura = exp(-d / (w * 3.6)) * 0.22;

  // Electron beam core shifts incandescent white-tinted; halo holds saturated OKLab phosphor color
  let hot = mix(v.col, vec3f(1.0, 0.98, 0.95), 0.72);
  let rgb = (hot * core * 1.15 + v.col * (halo * 0.78 + aura)) * v.inten;
  return vec4f(rgb, 1.0);
}
