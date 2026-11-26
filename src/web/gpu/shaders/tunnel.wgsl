// Tunnel/warp. All motion comes from the integer uniform block (core/scenes/tunnel.ts);
// this shader only shades.

struct Tun {
  res: vec2f,
  _pad: vec2f,
  u: array<vec4i, 6>, // [z, twist, hue, E, bass, lastOnsetAge, rush, 0, S0..S15]
};
@group(0) @binding(0) var<uniform> T: Tun;

fn ui(i: u32) -> i32 { return T.u[i / 4u][i % 4u]; }
fn band(b: u32) -> f32 { return f32(ui(8u + b)) / 255.0; }

@fragment fn fs_tunnel(in: VOut) -> @location(0) vec4f {
  let asp = T.res.x / T.res.y;
  let p = (in.uv - 0.5) * vec2f(asp, 1.0);
  let r = max(length(p), 1e-4);
  let ang = atan2(p.y, p.x) / 6.2831853 + 0.5;

  let z = f32(ui(0u)) / 4096.0;          // depth travelled, in rings
  let twist = f32(ui(1u)) / 4096.0;
  let hue = f32(ui(2u)) / 1536.0;
  let E = f32(ui(3u)) / 255.0;
  let bass = f32(ui(4u)) / 255.0;
  let flash = exp(-f32(ui(5u)) / 6.0);
  let rush = f32(ui(6u)) / 255.0;

  let depth = 0.32 / r;                      // perspective: small r = far
  let dz = depth * 5.0 + z;                  // ring coordinate along the tube
  let ringI = floor(dz);
  let fr = fract(dz);
  let sa = (ang + twist + depth * 0.04) * 32.0;
  let segI = u32(floor(sa)) % 32u;
  let fs = fract(sa);
  let b = select(31u - segI, segI, segI < 16u);
  let s = band(b);

  // AA'd grid lines (ring edges + segment edges)
  let wz = fwidth(dz) * 1.2;
  let ws = fwidth(sa) * 1.2;
  let ringLine = 1.0 - smoothstep(0.0, 0.012 + wz, min(fr, 1.0 - fr));
  let segLine = 1.0 - smoothstep(0.0, 0.01 + ws, min(fs, 1.0 - fs));

  // lit panels: band level gates a per-cell random threshold
  let cell = h32(bitcast<u32>(i32(ringI)), segI + 977u);
  let thr = f32(cell & 255u) / 255.0;
  let lit = smoothstep(thr - 0.08, thr + 0.04, s * s * 1.3 + rush * 0.25);
  let panel = lit * (0.1 + 0.6 * s * s) * smoothstep(0.0, 0.12, min(fr, 1.0 - fr)) * smoothstep(0.0, 0.12, min(fs, 1.0 - fs));

  let c1 = hsv2rgb(hue + f32(b) * 0.03 + ringI * 0.015, 0.85, 1.0);
  let c2 = hsv2rgb(hue + 0.5, 0.8, 1.0);
  var col = c1 * panel * 1.4 + c2 * ringLine * (0.08 + bass * bass * 0.9) + c1 * segLine * 0.05;

  // fog toward the vanishing point, plus the light at the end of the tunnel
  let fog = smoothstep(0.0, 0.45, r);
  col *= fog * fog;
  col += hsv2rgb(hue + 0.08, 0.6, 1.0) * (0.0006 + 0.004 * E * E) / (r * r + 0.0015);
  // onset flash: radial streaks
  let streak = pow(max(0.0, sin(ang * 6.2831853 * 48.0 + z * 3.0)), 24.0);
  col += c2 * streak * rush * smoothstep(0.1, 0.6, r) * 0.8;
  col += c2 * flash * 0.04;
  return vec4f(col, 1.0);
}
