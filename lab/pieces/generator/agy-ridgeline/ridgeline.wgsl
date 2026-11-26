struct U {
  res: vec2f, aspect: f32, t: f32,
  rms: f32, kick: f32, height: f32, spread: f32,
  glow: f32, tilt: f32, ridges: f32, cols: f32,
  phase: f32, bar: f32, _p0: f32, _p1: f32,
  pal: array<vec4f, 8>,
};

@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var<storage, read> heights: array<f32>;
@group(0) @binding(2) var<storage, read> rmeta: array<vec4f>;

fn pal_at(x: f32) -> vec3f {
  let f = clamp(x, 0.0, 1.0) * 7.0;
  let i = min(i32(floor(f)), 7);
  let j = min(i + 1, 7);
  return mix(u.pal[i].rgb, u.pal[j].rgb, f - f32(i));
}

// Sky backdrop: midnight void, subtle twinkling starfield, and reactive horizon mist
@fragment fn fs_sky(v: VOut) -> @location(0) vec4f {
  let y = 1.0 - v.uv.y * 2.0; // -1 bottom .. +1 top
  let x = (v.uv.x * 2.0 - 1.0) * u.aspect;
  let horizon = 0.36;
  let dy = abs(y - horizon);

  let p_hi = pal_at(0.18);
  let p_lo = pal_at(0.75);

  // Deep atmospheric sky + glowing horizon band
  var col = mix(p_lo * 0.03, p_hi * 0.015, clamp((y + 1.0) * 0.5, 0.0, 1.0));
  let mist = exp(-dy * (4.2 - 1.2 * u.rms)) * exp(-x * x * 0.35);
  col += mix(p_hi, p_lo, 0.4) * mist * (0.16 + 0.38 * u.rms + 0.25 * u.kick);

  // Subtle synth horizon sun-halo behind the far mountains
  let sun_d = length(vec2f(x * 0.75, (y - (horizon + 0.16)) * 1.15));
  let sun_disc = smoothstep(0.28, 0.24, sun_d) * (0.28 + 0.35 * u.rms + 0.2 * u.kick);
  let sun_slats = smoothstep(-0.2, 0.35, sin((y - horizon) * 85.0 - u.t * 1.4));
  let sun_halo = exp(-sun_d * 3.5) * (0.14 + 0.22 * u.rms);
  col += pal_at(0.35) * (sun_disc * (0.45 + 0.55 * sun_slats) * step(horizon - 0.02, y) + sun_halo);

  // Crisp stars in upper sky
  if (y > horizon + 0.02) {
    let cell = vec2u(floor(v.uv * vec2f(140.0, 80.0)));
    let h = h32(cell.x, cell.y);
    if ((h & 255u) > 246u) {
      let f = fract(v.uv * vec2f(140.0, 80.0)) - 0.5;
      let star = exp(-dot(f, f) * 42.0);
      let twinkle = 0.55 + 0.45 * sin(u.t * 2.5 + f32(h & 1023u));
      col += mix(vec3f(0.9, 0.94, 1.0), p_hi, 0.35) * star * twinkle * smoothstep(horizon, horizon + 0.3, y) * 0.55;
    }
  }
  return vec4f(col, 1.0);
}

struct RidgeOut {
  @builtin(position) pos: vec4f,
  @location(0) dy_ndc: f32,
  @location(1) slope_px: f32,
  @location(2) elev: f32,
  @location(3) depth: f32,
  @location(4) onset: f32,
  @location(5) u_x: f32,
  @location(6) fade: f32,
  @location(7) pal_u: f32,
};

@vertex fn vs_ridge(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> RidgeOut {
  let cols = u32(u.cols);
  let segs = cols - 1u;
  let r = ii / segs;
  let c = ii % segs;

  let m = rmeta[r];
  let depth = m.x;
  let onset = m.y;
  let pal_u = m.z;
  let fade = m.w;

  let persp = 1.0 / (1.0 + depth * (1.1 + u.tilt * 1.45));
  let y_base = mix(-0.86, 0.38, pow(clamp(depth, 0.0, 1.0), 0.72));

  let u0 = f32(c) / f32(segs);
  let u1 = f32(c + 1u) / f32(segs);
  let x0 = (u0 * 2.0 - 1.0) * u.spread * persp * 1.22;
  let x1 = (u1 * 2.0 - 1.0) * u.spread * persp * 1.22;

  let h0 = heights[r * cols + c];
  let h1 = heights[r * cols + c + 1u];
  let y_top0 = y_base + h0 * u.height * persp;
  let y_top1 = y_base + h1 * u.height * persp;

  // Pad slightly above the crest so the HDR glow halo doesn't clip;
  // extend just far enough below baseline to occlude ridges behind without excess overdraw
  let glow_pad = max(0.028 * persp, 8.0 / u.res.y);
  let y_bot = max(y_base - 0.24 * persp, -1.04);

  // Quad corners: (side: 0=left, 1=right), (top: 1=above crest, 0=bottom)
  var side = 0.0;
  var is_top = 0.0;
  switch (vi) {
    case 0u: { side = 0.0; is_top = 0.0; }
    case 1u: { side = 1.0; is_top = 0.0; }
    case 2u: { side = 1.0; is_top = 1.0; }
    case 3u: { side = 0.0; is_top = 0.0; }
    case 4u: { side = 1.0; is_top = 1.0; }
    default: { side = 0.0; is_top = 1.0; }
  }

  let x = mix(x0, x1, side);
  let y_top = mix(y_top0, y_top1, side);
  let y = select(y_bot, y_top + glow_pad, is_top > 0.5);
  let dy_ndc = y_top - y; // negative above crest, positive below crest

  let dx_px = max((x1 - x0) * u.res.x * 0.5, 0.25);
  let dy_px = (y_top1 - y_top0) * u.res.y * 0.5;
  let slope_px = dy_px / dx_px;

  var o: RidgeOut;
  o.pos = vec4f(x, y, 0.0, 1.0);
  o.dy_ndc = dy_ndc;
  o.slope_px = slope_px;
  o.elev = mix(h0, h1, side);
  o.depth = depth;
  o.onset = onset;
  o.u_x = mix(u0, u1, side);
  o.fade = fade;
  o.pal_u = pal_u;
  return o;
}

@fragment fn fs_ridge(v: RidgeOut) -> @location(0) vec4f {
  if (v.fade <= 0.001) { discard; }

  // Perpendicular screen-pixel distance below the crest line
  let dy_px = v.dy_ndc * u.res.y * 0.5;
  let perp = dy_px / sqrt(1.0 + v.slope_px * v.slope_px);

  // Depth-attenuated stroke width (crisp in front, finer near horizon)
  let stroke = mix(2.3, 1.05, v.depth);
  let d = abs(perp);

  // Palette color shifts smoothly with depth + elevation + ridge travel
  let pal_pos = fract(v.depth * 0.65 + v.elev * 0.45 + v.pal_u * 0.35);
  let base_col = pal_at(pal_pos);
  let hot_col = mix(base_col, vec3f(1.0, 0.96, 0.9), 0.55);

  // Crisp glowing mountain crest + soft top/bottom aura
  let core = exp(-(d * d) / max(stroke * stroke * 0.55, 0.2));
  let halo = exp(-d / (stroke * 3.0)) * 0.42;
  let boost = (0.7 + 1.35 * v.elev + 0.95 * v.onset) * u.glow * mix(1.15, 0.45, v.depth);
  let crest_rgb = (hot_col * core + base_col * halo) * boost * v.fade;

  // Opaque dark silhouette fill strictly below the crest (genuine hidden-line occlusion)
  let fill_mask = smoothstep(-0.65, 0.65, perp) * v.fade;
  // Subtle depth-tinted slope shading right under the crest so terrain reads as 3D ridges
  let under_glow = exp(-max(perp, 0.0) / mix(26.0, 8.0, v.depth));
  let fill_col = base_col * (0.025 + 0.14 * under_glow * (0.4 + v.elev + 0.5 * v.onset)) * mix(1.0, 0.35, v.depth);

  // Premultiplied output: silhouette occludes behind, crest glow adds cleanly above
  let rgb = fill_col * fill_mask + crest_rgb;
  return vec4f(rgb, fill_mask);
}
