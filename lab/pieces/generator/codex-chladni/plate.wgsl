struct PlateUniforms {
  view: vec4f,   // UV scale, seconds, grain size
  modes: vec4f,  // current n,m and previous n,m
  drive: vec4f,  // mode-change age, beat impulse, level, plate radius in pixels
  bass: vec4f,
};
@group(0) @binding(0) var<uniform> U: PlateUniforms;

fn noise(a: u32, b: u32) -> f32 {
  return f32(h32(a, b) & 65535u) / 65536.;
}

fn silhouette(p: vec2f) -> f32 {
  let q = abs(p);
  return max(max(q.x, q.y), (q.x + q.y + 0.10) * 0.5);
}

// Square plate eigenfunction cos(n*x)cos(m*y) - cos(m*x)cos(n*y).
fn field(p: vec2f, mode: vec2f) -> vec3f {
  let k = mode * 1.5707963;
  let x = k * (p.x + 1.);
  let y = k * (p.y + 1.);
  let a = cos(x);
  let b = cos(y);
  let dx = -sin(x) * k;
  let dy = -sin(y) * k;
  return vec3f(a.x*b.y - a.y*b.x, dx.x*b.y - dx.y*b.x, a.x*dy.y - a.y*dy.x);
}

fn fs_plate_impl(uv: vec2f, pixel: vec2f) -> vec3f {
  let p = (uv - 0.5) / U.view.xy;
  let edge = silhouette(p);
  let aa = 1. / U.drive.w;
  let level = U.drive.z;
  let hit = U.drive.y;
  let vignette = max(0., 1. - length(p * vec2f(0.52, 0.66)));
  let floor = vec3f(0.008, 0.012, 0.017) + vignette * vec3f(0.043, 0.059, 0.067);
  let bounce = vignette * vignette * (level * 0.85 + hit * 0.1);
  var color = floor + bounce * vec3f(0.17, 0.068, 0.020);
  color *= 1. - 0.62 * (1. - smoothstep(0.99, 1.12, silhouette(p - vec2f(0.02, 0.035))));

  let metalNoise = noise(u32(pixel.x), u32(pixel.y));
  let brush = noise(7u, u32(pixel.y));
  let bevel = smoothstep(0.938, 1.00, edge);
  let light = clamp(0.56 - 0.32*p.y - 0.23*p.x, 0.18, 1.);
  let levelLight = level * (0.38 + 0.20 * light) + hit * 0.10;
  let steel = vec3f(0.027, 0.039, 0.046) + light * vec3f(0.032, 0.038, 0.037)
    + levelLight * vec3f(0.56, 0.22, 0.075);
  let rim = (0.25 + light + hit * 0.4) * vec3f(0.31, 0.22, 0.12);
  let lip = smoothstep(0.975, 0.982, edge) * (1. - smoothstep(0.985, 0.991, edge));
  var surface = mix(steel, rim, bevel) + lip * light * vec3f(0.34, 0.22, 0.10);
  surface *= 0.88 + 0.10*metalNoise + 0.14*brush;

  let screws = abs(p) - vec2f(0.885);
  let recess = 1. - smoothstep(0.020, 0.020 + aa, length(screws));
  let head = 1. - smoothstep(0.014, 0.014 + aa, length(screws + vec2f(0.002)));
  let slot = 1. - smoothstep(0.002, 0.002 + aa, abs(screws.x + screws.y + 0.004));
  surface = mix(surface, vec3f(0.018, 0.014, 0.012), recess);
  surface += head * (0.08 + light * 0.10) * (1. - 0.85*slot) * vec3f(1.0, 0.72, 0.43);

  return mix(color, surface, 1. - smoothstep(1. - aa, 1. + aa, edge));
}

@fragment fn fs_plate(in: VOut) -> @location(0) vec4f {
  return vec4f(fs_plate_impl(in.uv, in.pos.xy), 1.);
}

// Follow the local gradient of displacement squared, stopping at the nodes.
// Use a bounded step near flat points and keep the grains on the plate face.
fn settle(origin: vec2f, mode: vec2f) -> vec2f {
  var p = origin;
  for (var i = 0; i < 7; i++) {
    let f = field(p, mode);
    let step = f.x * f.yz / max(dot(f.yz, f.yz), 2.);
    p = clamp(p - clamp(step, vec2f(-0.07), vec2f(0.07)), vec2f(-0.91), vec2f(0.91));
  }
  return p;
}

struct Grain {
  @builtin(position) pos: vec4f,
  @location(0) xy: vec2f,
  @location(1) @interpolate(flat) tint: vec3f,
};

@vertex fn vs_grain(@builtin(vertex_index) vertex: u32, @builtin(instance_index) id: u32) -> Grain {
  let origin = (vec2f(noise(id, 1u), noise(id, 2u)) * 2. - 1.) * 0.9;
  let angle = noise(id, 3u) * 6.2831853;
  let axis = vec2f(cos(angle), sin(angle));
  let jitter = noise(id, 4u);
  let next = settle(origin, U.modes.xy);
  let age = U.drive.x;
  var center = next;
  if (age < 0.64) {
    let old = settle(origin, U.modes.zw);
    let mixing = smoothstep(0.03, 0.64, age);
    let scatter = 1.8 * age * exp(-7. * age) * (0.25 + jitter);
    center = mix(old, next, mixing) + scatter * axis;
  }

  let bass = dot(U.bass.xyz, vec3f(0.46, 0.34, 0.20));
  let tremor = sin(U.view.z * (9. + 6. * jitter) + angle) * (0.003 + 0.010 * bass);
  let impulse = U.drive.y * (0.018 + 0.11 * jitter);
  center = clamp(center + axis * (tremor + impulse), vec2f(-0.925), vec2f(0.925));
  let quad = vec2f(f32(vertex & 1u), f32(vertex >> 1u)) * 2. - 1.;
  let radius = U.view.w * (0.0019 + 0.0030 * jitter);
  let pt = center + quad * radius * vec2f(1.14, 1.);
  let gleam = 0.29 + 0.60 * noise(id, 6u) + 0.18 * U.drive.y;
  let gold = mix(vec3f(0.48, 0.17, 0.045), vec3f(1.18, 0.87, 0.40), jitter);
  return Grain(vec4f(pt * U.view.xy * vec2f(2., -2.), 0., 1.), quad, gold * gleam);
}

@fragment fn fs_grain(in: Grain) -> @location(0) vec4f {
  let disk = 1. - smoothstep(0.10, 1.0, dot(in.xy, in.xy));
  let glint = 1.12 - 0.25 * (in.xy.x + in.xy.y);
  return vec4f(in.tint * disk * glint, 0.);
}
