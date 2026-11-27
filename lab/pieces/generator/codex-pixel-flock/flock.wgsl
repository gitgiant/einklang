struct Controls {
  frame: vec4f, // aspect, time, elapsed seconds, reset
  sound: vec4f, // level, bass, onset age, scatter
  spring: vec4f, // onset center, return strength, grain size
  print: vec4f, // ground strength, ink
}

struct Grain {
  home: vec2f,
  shift: vec2f,
  velocity: vec2f,
  weight: f32,
  seed: f32,
}

@group(0) @binding(0) var<uniform> u: Controls;
@group(0) @binding(1) var<storage, read> grains: array<Grain>;
@group(0) @binding(2) var<storage, read_write> next_grains: array<Grain>;
@group(0) @binding(3) var linear_clamp: sampler;
@group(0) @binding(4) var photo: texture_2d<f32>;
@group(0) @binding(5) var luma: texture_2d<f32>;
@group(0) @binding(6) var edges: texture_2d<f32>;

const COLS = 168u;
const ROWS = 94u;
const GRID = vec2f(168.0, 94.0);

fn grain_random(input: u32) -> f32 {
  var h = input * 747796405u + 2891336453u;
  h = ((h >> ((h >> 28u) + 4u)) ^ h) * 277803737u;
  return f32(((h >> 22u) ^ h) & 0xffffu) / 65535.0;
}

fn sample_luma(uv: vec2f) -> f32 {
  return textureSampleLevel(luma, linear_clamp, uv, 0.0).r;
}

@compute @workgroup_size(128)
fn cs_flock(@builtin(global_invocation_id) tid: vec3u) {
  let i = tid.x;
  if (i >= COLS * ROWS) { return; }
  let cell = vec2u(i % COLS, i / COLS);
  let a = (vec2f(cell) + vec2f(grain_random(i * 5u), grain_random(i * 5u + 1u))) / GRID;
  let b = (vec2f(cell) + vec2f(grain_random(i * 5u + 2u), grain_random(i * 5u + 3u))) / GRID;
  let seed = grain_random(i * 5u + 4u);
  let light_a = sample_luma(a);
  let light_b = sample_luma(b);
  let home = select(a, b, light_b > light_a + 0.018);
  let light = max(light_a, light_b);
  let edge = textureSampleLevel(edges, linear_clamp, home, 0.0).rg;
  let weight = clamp(0.2 + light * 0.66 + length(edge) * 0.85, 0.2, 1.0);
  if (u.frame.w > 0.5) {
    next_grains[i] = Grain(home, vec2f(0.0), vec2f(0.0), weight, seed);
    return;
  }

  let old = grains[i];
  let neighbors = array<u32, 4>(
    select(i - 1u, i, cell.x == 0u),
    select(i + 1u, i, cell.x + 1u == COLS),
    select(i - COLS, i, cell.y == 0u),
    select(i + COLS, i, cell.y + 1u == ROWS),
  );
  var mean_shift = vec2f(0.0);
  var mean_velocity = vec2f(0.0);
  for (var j = 0u; j < 4u; j++) {
    let other = grains[neighbors[j]];
    mean_shift += other.shift * 0.25;
    mean_velocity += other.velocity * 0.25;
  }

  let axis = vec2f(u.frame.x, 1.0);
  let radial = (old.home - u.spring.xy) * axis;
  let distance = length(radial);
  let outward = radial / max(0.03, distance);
  let tangent = vec2f(-outward.y, outward.x);
  let front = max(0.0, 1.0 - abs(distance * 35.0 - u.sound.z) / 9.0);
  let wake = (1.0 - smoothstep(6.0, 38.0, u.sound.z));
  let drift_phase = dot(home, vec2f(11.0, -8.0)) + u.frame.y * 1.4;
  let drift = vec2f(sin(drift_phase), cos(drift_phase * 0.8));
  let flutter = vec2f(cos(seed * 47.0), sin(seed * 47.0));
  let kick = (outward * (2.9 + seed * 2.8) + tangent * (seed - 0.5) * 4.0 + flutter * 1.6)
     * front * wake * u.sound.w;
  let force = -old.shift * (28.0 + weight * 18.0) * u.spring.z
    + (mean_shift - old.shift) * 28.0 + (mean_velocity - old.velocity) * 5.5
    + kick + drift * (0.18 + 0.95 * u.sound.y) + vec2f(-edge.y, edge.x) * (1.7 + 3.0 * u.sound.y);
  let velocity = (old.velocity + force * u.frame.z) / (1.0 + u.frame.z * 5.2);
  let shift = clamp(old.shift + velocity * u.frame.z, vec2f(-0.32), vec2f(0.32));
  let next_home = mix(old.home, home, min(1.0, u.frame.z * 18.0));
  next_grains[i] = Grain(next_home, shift, velocity, weight, seed);
}

fn grain_ink() -> vec3f {
  if (u.print.y > 1.5) { return vec3f(0.48, 0.16, 0.78); }
  if (u.print.y > 0.5) { return vec3f(0.18, 0.73, 0.98); }
  return vec3f(1.0, 0.50, 0.18);
}

@fragment fn fs_ground(input: VOut) -> @location(0) vec4f {
  let uv = input.uv;
  let p = uv - 0.5;
  let level = u.sound.x;
  let relief = textureSampleLevel(edges, linear_clamp, uv, 0.0).rg;
  let ripple = sin(length((uv - u.spring.xy) * vec2f(u.frame.x, 1.0)) * 28.0 - u.sound.z * 0.32);
  let hit = 1.0 - smoothstep(2.0, 32.0, u.sound.z);
  let warp = p * ripple * hit * 0.042 * u.sound.w + relief * 0.022 * level;
  let rgb = max(vec3f(0.0), textureSampleLevel(photo, linear_clamp, uv + warp, 0.0).rgb);
  let light = dot(rgb, vec3f(0.2126, 0.7152, 0.0722));
  let vignette = 1.0 - 0.72 * dot(p, p);
  let contour = min(0.25, length(relief));
  let gain = u.print.x * (0.52 + level * 0.92 + hit * 0.17);
  let tinted = mix(rgb, light * (0.48 + grain_ink()), 0.28);
  let paper = vec3f(0.008, 0.013, 0.025) + grain_ink() * (0.007 + level * 0.044);
  return vec4f((paper + tinted * gain + contour * grain_ink() * (0.16 + level * 0.28)) * vignette, 1.0);
}

struct GrainVertex {
  @builtin(position) pos: vec4f,
  @location(0) local: vec2f,
  @location(1) color: vec3f,
}

@vertex fn vs_grain(@builtin(vertex_index) vertex: u32, @builtin(instance_index) i: u32) -> GrainVertex {
  let corners = array<vec2f, 6>(
    vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(-1.0, 1.0),
    vec2f(-1.0, 1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0),
  );
  let g = grains[i];
  let local = corners[vertex];
  let axis = vec2f(u.frame.x, 1.0);
  let rgb = max(vec3f(0.0), textureSampleLevel(photo, linear_clamp, g.home, 0.0).rgb);
  let l = sample_luma(g.home);
  let coverage = smoothstep(0.13, 0.39, g.weight + g.seed * 0.24);
  let speed = length(g.velocity);
  let heading = g.velocity + vec2f(0.014, -0.009);
  let direction = heading / max(length(heading), 0.0001);
  let across = vec2f(-direction.y, direction.x);
  let bead = u.print.y > 0.5 && u.print.y < 1.5;
  let stretch = select(1.16 + min(5.2, speed * 14.0), 1.0 + min(1.6, speed * 4.0), bead);
  let radius = u.spring.w * (0.0012 + l * 0.0017 + g.seed * 0.0008) * coverage;
  let xy = g.home + (g.shift + radius * (direction * local.x * stretch + across * local.y)) / axis;
  let hue = rgb * (0.66 + l * 0.34) + grain_ink() * (0.08 + 0.15 * min(1.0, speed * 6.0));
  let gain = coverage * (0.40 + 0.42 * u.sound.x + min(0.45, speed * 1.7));
  return GrainVertex(vec4f(xy * vec2f(2.0, -2.0) + vec2f(-1.0, 1.0), 0.0, 1.0), local, hue * gain);
}

@fragment fn fs_grain(input: GrainVertex) -> @location(0) vec4f {
  let falloff = max(0.0, 1.0 - dot(input.local, input.local));
  return vec4f(input.color * falloff * falloff, 0.0);
}
