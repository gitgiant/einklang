const COLS = 48u;
const ROWS = 30u;
const TRI = array<vec2u, 6>(vec2u(0,0), vec2u(1,0), vec2u(0,1), vec2u(0,1), vec2u(1,0), vec2u(1,1));

struct Controls {
  frame: vec4f, // aspect, seconds, dt, reset
  sound: vec4f, // bass, rms, impact, drive
  motion: vec4f, // impact x, phrase recovery
  tint: vec4f,
}
struct Knot { offset: vec4f, velocity: vec4f }

@group(0) @binding(0) var<uniform> u: Controls;
@group(0) @binding(1) var linear_clamp: sampler;
@group(0) @binding(2) var<storage, read> knots: array<Knot>;
@group(0) @binding(3) var<storage, read_write> next_knots: array<Knot>;
@group(0) @binding(4) var luma: texture_2d<f32>;
@group(0) @binding(5) var edges: texture_2d<f32>;
@group(0) @binding(6) var photo: texture_2d<f32>;

fn knot_id(p: vec2u) -> u32 { return p.y * COLS + p.x; }
fn knot_uv(p: vec2u) -> vec2f { return vec2f(p) / vec2f(f32(COLS - 1u), f32(ROWS - 1u)); }

@compute @workgroup_size(64)
fn cs_spring(@builtin(global_invocation_id) tid: vec3u) {
  let i = tid.x;
  if (i >= COLS * ROWS) { return; }
  let p = vec2u(i % COLS, i / COLS);
  if (p.y == 0u || u.frame.w > 0.5) {
    next_knots[i] = Knot(vec4f(0), vec4f(0));
    return;
  }

  let uv = knot_uv(p);
  let k = knots[i];
  let l = knots[i - min(1u, p.x)].offset.xyz;
  let r = knots[i + min(1u, COLS - 1u - p.x)].offset.xyz;
  let a = knots[i - COLS].offset.xyz;
  let b = knots[i + COLS * min(1u, ROWS - 1u - p.y)].offset.xyz;
  let light = clamp(textureSampleLevel(luma, linear_clamp, uv, 0.0).r, 0.0, 1.0);
  let edge = min(1.0, length(textureSampleLevel(edges, linear_clamp, uv, 0.0).rg));
  let folds = sin(uv.x * 24.0 + uv.y * 7.0 - u.frame.y * 1.9);
  let crosswind = cos(uv.y * 10.0 + uv.x * 9.0 + u.frame.y * 2.7);
  let wind = folds * (0.8 + 17.0 * u.sound.x) + crosswind * (0.6 + 7.0 * u.sound.y);
  let hit = u.sound.z * (1.0 - min(1.0, abs(uv.x - u.motion.x) * 1.5));
  var force = vec3f(4.4 * (crosswind + 0.35) * (u.sound.x + hit), 0.55 - 5.0 * hit, wind + 11.0 * hit);
  force *= pow(uv.y, 0.75) * (0.52 + 0.78 * light) * u.sound.w * (1.0 - 0.72 * u.motion.y);
  // Structural springs couple the four neighboring knots. Softer tethers hold the rest shape.
  force += (l + r + a + b - 4.0 * k.offset.xyz) * (95.0 + 35.0 * edge);
  force -= k.offset.xyz * vec3f(32.0, 52.0, 40.0);
  let velocity = (k.velocity.xyz + u.frame.z * force) * exp(-u.frame.z * 5.6);
  let offset = clamp(k.offset.xyz + velocity * u.frame.z, vec3f(-0.24, -0.22, -0.38), vec3f(0.24, 0.16, 0.38));
  next_knots[i] = Knot(vec4f(offset, 0), vec4f(velocity, 0));
}

fn cloth(p: vec2u) -> vec3f {
  let uv = knot_uv(p);
  let hanging = vec3f((uv.x - 0.5) * 1.78, (uv.y - 0.5) * 1.58 + 0.04, 0.0);
  let flat = vec3f(uv * 2.0 - 1.0, 0.0);
  let pleats = 0.047 * sin(uv.x * 28.0) * uv.y;
  return mix(hanging, flat, u.motion.y) + (knots[knot_id(p)].offset.xyz + vec3f(0, 0, pleats)) * (1.0 - u.motion.y);
}

struct Fabric {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
  @location(1) normal: vec3f,
}

@vertex fn vs_sail(@builtin(vertex_index) vertex: u32) -> Fabric {
  let cell = vertex / 6u;
  let p = vec2u(cell % (COLS - 1u), cell / (COLS - 1u)) + TRI[vertex % 6u];
  let q = cloth(p);
  let dx = cloth(min(p + vec2u(1,0), vec2u(COLS-1u, ROWS-1u))) - cloth(max(p, vec2u(1,0)) - vec2u(1,0));
  let dy = cloth(min(p + vec2u(0,1), vec2u(COLS-1u, ROWS-1u))) - cloth(max(p, vec2u(0,1)) - vec2u(0,1));
  let n = cross(dx, dy) + vec3f(0, 0, 0.00002);
  let zoom = 1.0 + q.z * 0.50;
  return Fabric(vec4f(q.x * zoom + q.z * 0.24, -q.y * zoom + q.z * 0.18, 0.5 - q.z, 1.0), knot_uv(p), n);
}

@fragment fn fs_stage(input: VOut) -> @location(0) vec4f {
  let uv = input.uv;
  let picture = textureSample(photo, linear_clamp, uv).rgb;
  let vignette = max(0.0, 1.0 - 1.4 * length(uv - 0.5));
  let rail = (1.0 - smoothstep(0.002, 0.006, abs(uv.y - 0.123))) * smoothstep(0.023, 0.043, min(uv.x, 1.0 - uv.x));
  let bolts = 1.0 - smoothstep(0.002, 0.006, length(vec2f((min(uv.x, 1.0 - uv.x) - 0.037) * u.frame.x, uv.y - 0.123)));
  let stage = picture * (0.045 + 0.05 * vignette) + u.tint.rgb * (0.018 * vignette + rail * 0.46 + bolts);
  return vec4f(mix(stage, picture * 0.81, u.motion.y * 0.83), 1);
}

@fragment fn fs_sail(input: Fabric) -> @location(0) vec4f {
  let uv = input.uv;
  let n = normalize(input.normal);
  let light = normalize(vec3f(-0.62, -0.38, 0.73));
  let diffuse = abs(dot(n, light));
  let sheen = pow(abs(dot(n, normalize(vec3f(-0.28, -0.15, 1)))), 12.0);
  let binding = 1.0 - smoothstep(0.002, 0.011, min(min(uv.x, 1.0 - uv.x), min(uv.y, 1.0 - uv.y)));
  let textile = cos(uv.x * 950.0) * cos(uv.y * 650.0);
  let stitch = binding * (0.52 + 0.48 * cos(uv.x * 310.0 + uv.y * 180.0));
  let picture = textureSample(photo, linear_clamp, uv).rgb;
  let key = 0.34 + 0.57 * diffuse + u.sound.y * 1.3 + u.sound.z * 0.50;
  let silk = picture * key * (0.97 + 0.042 * textile) + u.tint.rgb * (0.028 + sheen * (0.09 + 0.32 * u.sound.x) + 0.53 * stitch);
  return vec4f(mix(silk, picture * 0.95, u.motion.y * 0.85), 1);
}
