// Lasers and lightning: volumetric beat-sweeping lasers, illuminated storm haze, and instanced branching bolts.

struct U {
  // res.xy, time, laserCount
  a: vec4f,
  // glow, haze, sweep, flashSum
  b: vec4f,
  // flashX, flashY, rms, bass
  c: vec4f,
  // phase, bar, high, _pad
  d: vec4f,
  bands: array<vec4f, 4>,
  pal: array<vec4f, 8>,
  // x = origX, y = angleRad (downward = pi/2), z = intensity, w = palT
  lasers: array<vec4f, 16>,
};

@group(0) @binding(0) var<uniform> u: U;
// 2 vec4fs per segment: [0] = (x0, y0, x1, y1), [1] = (widthPx, intensity, palT, coreBoost)
@group(0) @binding(1) var<storage, read> segs: array<vec4f>;

fn pal_at(t: f32) -> vec3f {
  let f = fract(t) * 7.0;
  let i = min(i32(floor(f)), 6);
  return mix(u.pal[i].rgb, u.pal[i + 1].rgb, f - f32(i));
}

// Lightweight smooth 2D hash value noise for storm clouds and laser mist
fn vnoise(p: vec2f) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let s = f * f * (3.0 - 2.0 * f);
  let ix = u32(i32(i.x) + 4096);
  let iy = u32(i32(i.y) + 4096);
  let a = f32(h32(ix, iy) & 1023u) / 1023.0;
  let b = f32(h32(ix + 1u, iy) & 1023u) / 1023.0;
  let c = f32(h32(ix, iy + 1u) & 1023u) / 1023.0;
  let d = f32(h32(ix + 1u, iy + 1u) & 1023u) / 1023.0;
  return mix(mix(a, b, s.x), mix(c, d, s.x), s.y);
}

fn fbm3(p: vec2f) -> f32 {
  var v = 0.0;
  var a = 0.52;
  var q = p;
  for (var k = 0; k < 3; k++) {
    v += a * vnoise(q);
    q = q * 2.04 + vec2f(11.3, 7.1);
    a *= 0.5;
  }
  return v;
}

@fragment fn fs_sky_lasers(v: VOut) -> @location(0) vec4f {
  let uv = v.uv;
  let aspect = u.a.x / u.a.y;
  let p = vec2f((uv.x - 0.5) * aspect, uv.y);
  let t = u.a.z;
  let glow = u.b.x;
  let haze = u.b.y;
  let flash = u.b.w;

  // Rolling storm cloud canopy at the top + deep arena fog below
  let cloud_n = fbm3(vec2f(p.x * 2.1 + t * 0.08, p.y * 2.8 - t * 0.04));
  let mist_n = fbm3(vec2f(p.x * 3.4 - t * 0.14, p.y * 3.0 - t * 0.22));

  let canopy = smoothstep(0.68, 0.0, uv.y);
  let base_sky = mix(pal_at(0.12) * 0.04, pal_at(0.62) * 0.02, uv.y);
  let cloud_shade = pal_at(0.28) * cloud_n * canopy * (0.06 + 0.08 * u.c.z) * (0.4 + haze);

  // Lightning flash illuminates the storm clouds around the active strike zone
  let flash_p = vec2f((u.c.x - 0.5) * aspect, u.c.y);
  let flash_d = length(p - flash_p);
  let flash_glow = exp(-flash_d * 2.3) * flash * (0.28 + 0.55 * cloud_n) * (0.45 + 0.55 * canopy);
  let flash_col = mix(pal_at(0.75), vec3f(0.85, 0.92, 1.0), 0.55) * flash_glow * 0.65;

  var col = base_sky + cloud_shade + flash_col;

  // Volumetric beat-sweeping laser beams
  let count = min(i32(u.a.w), 16);
  let mist_mod = mix(1.0, 0.55 + 0.9 * mist_n, clamp(haze, 0.0, 1.0));
  for (var i = 0; i < count; i++) {
    let L = u.lasers[i];
    let inten = L.z;
    if (inten <= 0.001) { continue; }
    let orig = vec2f((L.x - 0.5) * aspect, -0.02);
    let dir = vec2f(cos(L.y), sin(L.y));
    let rel = p - orig;
    let along = dot(rel, dir);
    if (along < 0.0) { continue; }
    let perp = abs(rel.x * (-dir.y) + rel.y * dir.x);

    // Beam spreads gently as a volumetric cone with distance
    let spread = 0.0022 + along * 0.011;
    let core = exp(-pow(perp / (0.0016 + along * 0.0028), 2.0));
    let cone = exp(-perp / (spread * (1.1 + haze * 1.4)));
    let atten = exp(-along * 0.85) * smoothstep(0.0, 0.035, along);

    let lcol = pal_at(L.w);
    let hot = mix(lcol, vec3f(1.0, 0.99, 0.98), 0.68);
    let beam = (hot * core * 0.85 + lcol * cone * 0.24 * mist_mod) * inten * atten * (0.45 + 0.45 * glow);
    col += beam;

    // Bright emitter lamp flare at top truss
    let emitter_d = length(rel);
    col += hot * exp(-emitter_d * 28.0) * inten * 0.45;
  }

  // Subtle horizon floor reflection haze driven by bass & flashes
  let floor_haze = smoothstep(0.62, 1.0, uv.y) * (0.04 + 0.09 * u.c.w + 0.08 * flash) * haze;
  col += pal_at(0.45) * floor_haze * (0.6 + 0.4 * mist_n);

  return vec4f(col, 1.0);
}

struct SegOut {
  @builtin(position) pos: vec4f,
  // Local coordinates in pixels: x along segment [0..segLenPx], y perpendicular signed distance
  @location(0) local_px: vec2f,
  @location(1) seg_len: f32,
  @location(2) props: vec4f, // widthPx, intensity, palT, coreBoost
};

@vertex fn vs_seg(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> SegOut {
  let e = segs[ii * 2u];
  let m = segs[ii * 2u + 1u];

  let res = u.a.xy;
  let p0 = e.xy * res;
  let p1 = e.zw * res;
  let d = p1 - p0;
  let seg_len = max(length(d), 0.5);
  let dir = d / seg_len;
  let nrm = vec2f(-dir.y, dir.x);

  // Quad padded to capture wide electric corona halo
  let pad = max(14.0, m.x * 11.0 * (0.6 + 0.4 * u.b.x));

  let corners = array<vec2f, 6>(
    vec2f(0.0, -1.0), vec2f(1.0, -1.0), vec2f(0.0, 1.0),
    vec2f(0.0, 1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0),
  );
  let c = corners[vi];
  let along = mix(-pad, seg_len + pad, c.x);
  let across = c.y * pad;
  let px = p0 + dir * along + nrm * across;

  var out: SegOut;
  out.pos = vec4f(px.x / res.x * 2.0 - 1.0, 1.0 - px.y / res.y * 2.0, 0.0, 1.0);
  out.local_px = vec2f(along, across);
  out.seg_len = seg_len;
  out.props = m;
  return out;
}

@fragment fn fs_seg(in: SegOut) -> @location(0) vec4f {
  // Exact Euclidean distance to the line segment in pixels
  let cx = clamp(in.local_px.x, 0.0, in.seg_len);
  let dist = length(in.local_px - vec2f(cx, 0.0));

  let w = max(in.props.x, 0.65);
  let inten = in.props.y * u.b.x;
  let col = pal_at(in.props.z);
  let core_boost = in.props.w;

  let core = exp(-pow(dist / (w * 0.55), 2.0));
  let inner = exp(-dist / (w * 1.9));
  let halo = exp(-dist / (w * 6.5));

  // White-hot plasma core + saturated palette corona + wide soft arc bloom
  let hot = mix(col, vec3f(1.0, 0.99, 1.0), 0.85);
  let rgb = (hot * core * 1.65 * core_boost + col * inner * 0.62 + col * halo * 0.16) * inten;
  return vec4f(rgb, 0.0);
}
