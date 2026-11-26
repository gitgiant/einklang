// Voxel ship: a starfield pass (fs_stars over vs_full), then one instanced cube per voxel (vs_cube / fs_cube).

struct U {
  view_proj: mat4x4f,
  /** time (s), rms, shatter, glow */
  a: vec4f,
  /** tint, stars, aspect, onset kick 0..1 */
  b: vec4f,
  /** camera position (xyz), 1 / hull length */
  cam: vec4f,
  bands: array<vec4f, 4>,
  /** palette, linear rgb, 8 stops (w unused) */
  pal: array<vec4f, 8>,
};
@group(0) @binding(0) var<uniform> u: U;
/** per voxel: position (y-up, centred, hull units) + band 0..15, colour (linear rgb) + seed 0..1 */
@group(0) @binding(1) var<storage, read> vox: array<vec4f>;

fn band(i: i32) -> f32 { let k = clamp(i, 0, 15); return u.bands[k / 4][k % 4]; }
fn pal_at(t: f32) -> vec3f {
  let x = fract(t) * 8.0; let i = i32(x);
  return mix(u.pal[i].rgb, u.pal[(i + 1) % 8].rgb, x - f32(i));
}

@fragment fn fs_stars(v: VOut) -> @location(0) vec4f {
  let p = (v.uv - 0.5) * vec2f(u.b.z, 1.0);
  var c = vec3f(0.004, 0.006, 0.014) + pal_at(0.6).rgb * 0.02 * (1.0 - length(p));
  // three layers drifting past at different speeds
  for (var l = 0u; l < 3u; l++) {
    let s = 40.0 + f32(l) * 35.0;
    let q = p * s + vec2f(u.a.x * (0.6 + f32(l) * 0.5), f32(l) * 17.0);
    let cell = floor(q); let f = fract(q) - 0.5;
    let h = h32(u32(i32(cell.x) + 4096), u32(i32(cell.y) + 4096) + l * 9001u);
    let hx = f32(h & 1023u) / 1023.0; let hy = f32((h >> 10u) & 1023u) / 1023.0;
    if (f32(h >> 22u) / 1023.0 > 0.92) {
      let d = length(f - (vec2f(hx, hy) - 0.5) * 0.7);
      c += vec3f(0.8, 0.85, 1.0) * u.b.y * smoothstep(0.08, 0.0, d) * (0.3 + 0.7 * u.a.y);
    }
  }
  return vec4f(c, 1.0);
}

// 36 corners of a unit cube (-0.5..0.5) with their face normals
const FACE_N = array<vec3f, 6>(vec3f(1, 0, 0), vec3f(-1, 0, 0), vec3f(0, 1, 0), vec3f(0, -1, 0), vec3f(0, 0, 1), vec3f(0, 0, -1));
fn corner(face: u32, k: u32) -> vec3f {
  let n = FACE_N[face];
  // two tangents per face, wound so the outside is counter-clockwise
  let t1 = vec3f(n.y, n.z, n.x); let t2 = cross(n, t1);
  let quad = array<vec2f, 6>(vec2f(-1, -1), vec2f(1, -1), vec2f(1, 1), vec2f(-1, -1), vec2f(1, 1), vec2f(-1, 1));
  let q = quad[k];
  return 0.5 * (n + q.x * t1 + q.y * t2);
}

struct CubeOut { @builtin(position) pos: vec4f, @location(0) n: vec3f, @location(1) col: vec3f, @location(2) emit: vec3f, @location(3) wp: vec3f };

@vertex fn vs_cube(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> CubeOut {
  let p = vox[ii * 2u]; let c = vox[ii * 2u + 1u];
  let bi = i32(p.w); let lvl = band(bi); let seed = c.w;
  // shatter: voxels fly out along their direction from the hull axis, further on bass and onsets
  let away = normalize(vec3f(p.x, p.y, 0.0) + vec3f(0.0, 0.0, seed - 0.5) * 0.2 + vec3f(1e-4));
  let kick = u.a.z * (0.5 * max(band(0) - 0.45, 0.0) + 0.6 * u.b.w) * (0.3 + seed);
  let wp = p.xyz + away * kick * 0.4 + vec3f(0.0, sin(u.a.x * 1.3 + p.z * 3.0) * 0.004, 0.0);
  let size = u.cam.w * (1.0 - 0.3 * min(kick, 1.0));
  let face = (vi / 6u); let k = vi % 6u;
  var out: CubeOut;
  let w = wp + corner(face, k) * size;
  out.pos = u.view_proj * vec4f(w, 1.0);
  out.n = FACE_N[face];
  let tint = pal_at(f32(bi) / 16.0);
  out.col = mix(c.rgb, c.rgb * tint * 2.0, u.b.x);
  // a few voxels per slice are lights; every voxel picks up a little of its band
  let light = select(0.08, 1.0, seed > 0.9);
  out.emit = tint * u.a.w * lvl * lvl * light;
  out.wp = w;
  return out;
}

@fragment fn fs_cube(v: CubeOut) -> @location(0) vec4f {
  let L = normalize(vec3f(0.4, 0.8, 0.3));
  let n = normalize(v.n);
  let diff = max(dot(n, L), 0.0);
  let view = normalize(u.cam.xyz - v.wp);
  let rim = pow(1.0 - max(dot(n, view), 0.0), 3.0);
  let col = v.col * (0.18 + 0.9 * diff) + rim * 0.15 * pal_at(0.3) + v.emit;
  return vec4f(col, 1.0);
}
