// Strange attractors render pass: deep cosmic vignette + additive 3D Gaussian point splats.

struct DrawU {
  view_proj: mat4x4f,
  // res.xy, pxSize, splatAlpha
  a: vec4f,
  // center.xyz, invScale
  b: vec4f,
  // time, rms, kick, kind
  c: vec4f,
  // bass, mid, high, phase
  d: vec4f,
  pal: array<vec4f, 8>,
};

@group(0) @binding(0) var<uniform> u: DrawU;
@group(0) @binding(1) var<storage, read> pts: array<vec4f>;

fn pal_at(t: f32) -> vec3f {
  let f = fract(t) * 7.0;
  let i = min(i32(floor(f)), 6);
  return mix(u.pal[i].rgb, u.pal[i + 1].rgb, f - f32(i));
}

@fragment fn fs_bg(v: VOut) -> @location(0) vec4f {
  let aspect = u.a.x / u.a.y;
  let p = (v.uv - 0.5) * vec2f(aspect, 1.0);
  let r = length(p);
  let core = exp(-r * r * 2.6);
  let bg = pal_at(0.08) * (0.014 + 0.024 * core) * (0.8 + 0.7 * u.c.y + 0.4 * u.c.z);
  let rim = pal_at(0.65) * exp(-abs(r - 0.48) * 7.0) * (0.006 + 0.015 * u.d.x);
  return vec4f(bg + rim, 1.0);
}

struct SplatOut {
  @builtin(position) pos: vec4f,
  @location(0) local: vec2f,
  @location(1) col: vec3f,
};

@vertex fn vs_splat(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> SplatOut {
  let pt = pts[ii * 2u];
  let info = pts[ii * 2u + 1u];

  let world = (pt.xyz - u.b.xyz) * u.b.w;
  let clip = u.view_proj * vec4f(world, 1.0);

  let corners = array<vec2f, 6>(
    vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(-1.0, 1.0),
    vec2f(-1.0, 1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0),
  );
  let c = corners[vi];

  var out: SplatOut;
  // Cull behind camera
  if (clip.w <= 0.15) {
    out.pos = vec4f(2.0, 2.0, 2.0, 1.0);
    out.local = vec2f(0.0);
    out.col = vec3f(0.0);
    return out;
  }

  let ndc = clip.xy / clip.w;
  let depth_scale = clamp(2.5 / clip.w, 0.55, 1.85);
  let radius_px = u.a.z * depth_scale * (0.75 + 0.45 * pt.w);
  let off_ndc = c * (radius_px * 2.0) / u.a.xy;

  // Palette color from velocity/jump metric + 3D spatial depth + subtle time drift
  let pal_t = fract(pt.w * 0.65 + (world.z * 0.25 + 0.5) * 0.35 + u.c.x * 0.03);
  let base_col = pal_at(pal_t);
  let hot_col = mix(base_col, vec3f(1.0, 0.96, 0.92), clamp(pt.w * 0.42 + u.c.z * 0.2, 0.0, 0.65));

  // Smooth fade-in/out over particle lifecycle so respawns never pop
  let age = info.w;
  let life_fade = smoothstep(0.0, 0.06, age) * smoothstep(1.0, 0.92, age);
  let depth_atten = clamp(2.2 / (clip.w * clip.w), 0.25, 1.35);

  out.pos = vec4f(ndc + off_ndc, 0.0, 1.0);
  out.local = c;
  out.col = hot_col * u.a.w * depth_atten * (0.4 + 0.6 * life_fade);
  return out;
}

@fragment fn fs_splat(in: SplatOut) -> @location(0) vec4f {
  let r2 = dot(in.local, in.local);
  if (r2 > 1.0) { discard; }
  let g = exp(-r2 * 4.8);
  return vec4f(in.col * g, 0.0);
}
