// Metaballs: sum of r^2 / d^2 over the blobs plus onset rings, thresholded at 1 with a glowing edge.
// Colour is the field-weighted mix of the blobs' palette positions, so merging blobs blend.

struct U {
  res: vec2f, time: f32, aspect: f32,
  n: f32, glow: f32, edge: f32, kick: f32,
  pal_n: f32, rms: f32, depth: f32, _p: f32,
  blobs: array<vec4f, 16>,  // x, y (screen heights, centred), radius, palette position
  pulses: array<vec4f, 4>,  // x, y, ring radius, strength
  pal: array<vec4f, 8>,     // OKLab stops
};
@group(0) @binding(0) var<uniform> u: U;

fn lab2lin(c: vec3f) -> vec3f {
  let l_ = c.x + 0.3963377774 * c.y + 0.2158037573 * c.z;
  let m_ = c.x - 0.1055613458 * c.y - 0.0638541728 * c.z;
  let s_ = c.x - 0.0894841775 * c.y - 1.291485548 * c.z;
  let l = l_ * l_ * l_;
  let m = m_ * m_ * m_;
  let s = s_ * s_ * s_;
  return max(vec3f(0.0), vec3f(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s));
}
fn pal(x: f32) -> vec3f {
  let n = max(i32(u.pal_n), 1);
  let f = clamp(x, 0.0, 1.0) * f32(n - 1);
  let i = min(i32(floor(f)), n - 1);
  let j = min(i + 1, n - 1);
  return lab2lin(mix(u.pal[i].xyz, u.pal[j].xyz, f - f32(i)));
}

@fragment fn fs_blobs(v: VOut) -> @location(0) vec4f {
  let p = (v.uv - 0.5) * vec2f(u.aspect, 1.0);
  var f = 0.0;
  var cs = 0.0;
  let n = i32(u.n);
  for (var i = 0; i < n; i++) {
    let b = u.blobs[i];
    let d = p - b.xy;
    let w = b.z * b.z / (dot(d, d) + 1e-4);
    f += w;
    cs += w * b.w;
  }
  let idx = cs / max(f, 1e-4);
  var ring = 0.0;
  for (var k = 0; k < 4; k++) {
    let q = u.pulses[k];
    let x = (length(p - q.xy) - q.z) / 0.035;
    ring += q.w * exp(-x * x);
  }
  let field = f + ring * 0.8;
  let aa = max(fwidth(field), 1e-4);
  let inside = smoothstep(1.0 - aa, 1.0 + aa, field);
  // 0 at the surface, toward 1 deep inside: fake depth for the body shading
  let inner = clamp(1.0 - 1.0 / max(field, 1e-3), 0.0, 1.0);
  let body = pal(idx) * (0.3 + u.depth * sqrt(inner)) * (1.0 + 0.4 * u.kick);
  let hot = pal(min(1.0, idx + 0.35)) * smoothstep(0.55, 0.95, inner) * 0.6;
  let rim = exp(-abs(field - 1.0) / u.edge) * u.glow;
  let halo = (1.0 - inside) * smoothstep(0.15, 1.0, field) * 0.35 * u.glow;
  let bg = mix(pal(0.0) * 0.05, pal(0.15) * 0.1, v.uv.y) * (1.0 + u.rms);
  var col = mix(bg, body + hot, inside);
  col += pal(min(1.0, idx + 0.2)) * (rim * 0.9 + halo);
  col += pal(1.0) * ring * 0.25 * u.glow;
  return vec4f(col, 1.0);
}
