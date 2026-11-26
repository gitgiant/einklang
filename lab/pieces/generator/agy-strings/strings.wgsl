struct U {
  res: vec2f, aspect: f32, t: f32,
  rms: f32, kick: f32, strings: f32, nodes: f32,
  glow: f32, harmonics: f32, half_x: f32, y_span: f32,
  phase: f32, _p0: f32, _p1: f32, _p2: f32,
  pal: array<vec4f, 8>,
};

struct Seg {
  p0: vec2f,
  p1: vec2f,
  col: vec3f,
  inten: f32,
};

@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var<storage, read> disp: array<f32>;

fn pal_at(x: f32) -> vec3f {
  let f = clamp(x, 0.0, 1.0) * 7.0;
  let i = min(i32(floor(f)), 7);
  let j = min(i + 1, 7);
  return mix(u.pal[i].rgb, u.pal[j].rgb, f - f32(i));
}

// Background: standing-wave acoustic interference field sampled from live string displacements + bridge frets
@fragment fn fs_bg(v: VOut) -> @location(0) vec4f {
  let p = vec2f((v.uv.x * 2.0 - 1.0) * u.aspect, 1.0 - v.uv.y * 2.0);
  let ns = max(i32(u.strings), 1);
  let nn = max(i32(u.nodes), 2);

  // Normalized position inside the string harp frame
  let ux = clamp((p.x / max(u.half_x, 0.1)) * 0.5 + 0.5, 0.0, 1.0);
  let uy = (p.y / max(u.y_span * 0.5, 0.1)) * 0.5 + 0.5;
  let col_f = ux * f32(nn - 1);
  let c0 = min(i32(floor(col_f)), nn - 1);
  let c1 = min(c0 + 1, nn - 1);
  let cf = col_f - f32(c0);

  let row_f = clamp(uy, 0.0, 1.0) * f32(ns - 1);
  let r0 = min(i32(floor(row_f)), ns - 1);
  let r1 = min(r0 + 1, ns - 1);
  let rf = row_f - f32(r0);

  let d0 = mix(disp[r0 * nn + c0], disp[r0 * nn + c1], cf);
  let d1 = mix(disp[r1 * nn + c0], disp[r1 * nn + c1], cf);
  let wave_val = mix(d0, d1, rf);
  let wave_diff = d1 - d0;

  let inside = smoothstep(0.0, 0.04, 1.0 - abs(p.x / max(u.half_x, 0.1)))
             * smoothstep(0.0, 0.12, 1.0 - abs(p.y / max(u.y_span * 0.56, 0.1)));

  // Acoustic standing-wave interference ripples
  let ripple = sin(wave_val * 14.0 + u.t * 2.4) * 0.5 + 0.5;
  let energy = (abs(wave_val) * 1.4 + abs(wave_diff) * 0.9) * inside;
  let pal_c = pal_at(fract(clamp(uy, 0.0, 1.0) * 0.8 + abs(wave_val) * 0.35 + u.t * 0.03));

  var col = pal_at(0.15) * (0.012 + 0.035 * u.rms);
  col += pal_c * energy * (0.42 + 0.48 * ripple) * u.harmonics;

  // Left and right glowing bridge pins where the strings anchor
  let d_bridge = abs(abs(p.x) - u.half_x);
  let bridge = exp(-d_bridge * 75.0) * smoothstep(u.y_span * 0.56, u.y_span * 0.48, abs(p.y));
  col += mix(pal_at(0.2), vec3f(0.95), 0.3) * bridge * (0.18 + 0.35 * u.rms + 0.25 * u.kick);

  return vec4f(col, 1.0);
}

@group(0) @binding(2) var<storage, read> segs: array<Seg>;

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
  let w = 0.011;
  let pad = max(w * 3.4, 4.0 / u.res.y);
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
  let pa = v.p - v.p0;
  let ba = v.p1 - v.p0;
  let bb = dot(ba, ba);
  let h = select(0.0, clamp(dot(pa, ba) / max(bb, 1e-8), 0.0, 1.0), bb > 1e-8);
  let d = length(pa - ba * h);

  let w = max(0.0085, 1.6 / u.res.y);
  let core = exp(-d * d / (w * w * 0.24));
  let halo = exp(-d / (w * 1.6));
  let aura = exp(-d / (w * 3.8)) * 0.2;
  let hot = mix(v.col, vec3f(1.0, 0.99, 0.96), 0.68);
  return vec4f((hot * core * 1.15 + v.col * (halo * 0.72 + aura)) * v.inten, 1.0);
}
