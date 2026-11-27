const MAGNET_GRID = vec2u(28, 18);
const WELL_GRID = vec2u(6, 4);
const GRAIN_GRID = vec2u(112, 64);
const QUAD = array<vec2f, 6>(vec2f(-1,-1), vec2f(1,-1), vec2f(-1,1), vec2f(-1,1), vec2f(1,-1), vec2f(1,1));

struct Controls {
  frame: vec4f, // aspect, seconds, dt, reset
  sound: vec4f, // bass, rms, impact, drive
  mode: vec4f, // gravity flag, phrase recovery
  tint: vec4f,
}

struct Peak { body: vec4f, motion: vec4f }

@group(0) @binding(0) var<uniform> u: Controls;
@group(0) @binding(1) var linear_clamp: sampler;
@group(0) @binding(2) var luma: texture_2d<f32>;
@group(0) @binding(3) var edges: texture_2d<f32>;
@group(0) @binding(4) var photo: texture_2d<f32>;
@group(0) @binding(5) var<storage, read> peak: array<Peak>;
@group(0) @binding(6) var<storage, read_write> next_peak: array<Peak>;
@group(0) @binding(7) var<storage, read> grain: array<vec4f>;
@group(0) @binding(8) var<storage, read_write> next_grain: array<vec4f>;

fn random(i: u32, seed: u32) -> f32 { return f32(h32(i, seed) & 65535u) / 65535.0; }
fn response() -> f32 { return (0.85 * u.sound.x + 0.62 * u.sound.y + 0.29 * u.sound.z) * u.sound.w; }
fn brightness(p: vec2f) -> f32 { return clamp(textureSampleLevel(luma, linear_clamp, p, 0).r, 0.0, 1.0); }
fn clip_uv(p: vec2f) -> vec4f { return vec4f(p * vec2f(2,-2) + vec2f(-1,1), 0, 1); }

@compute @workgroup_size(64)
fn cs_peaks(@builtin(global_invocation_id) tid: vec3u) {
  let i = tid.x;
  let gravity = u.mode.x > 0.5;
  let grid = select(MAGNET_GRID, WELL_GRID, gravity);
  if (i >= grid.x * grid.y) { return; }
  let ij = vec2u(i % grid.x, i / grid.x);
  let cell = vec2f(ij);
  let scale = vec2f(grid);
  let middle = (cell + 0.5) / scale;
  var location = middle;
  var light = brightness(middle);

  // Each well owns a stratum. Pick its brightest sample, with a weak bias away from borders.
  // The smaller magnetic cells sample a local max too, leaving the needle roots on the weave.
  let samples = select(3u, 5u, gravity);
  for (var y = 0u; y < samples; y++) {
    for (var x = 0u; x < samples; x++) {
      let offset = (vec2f(f32(x), f32(y)) + 0.5) / f32(samples);
      let uv = (cell + offset) / scale;
      let sample_light = brightness(uv) - 0.036 * length(offset - 0.5);
      if (sample_light > light) {
        light = sample_light;
        location = uv;
      }
    }
  }
  let old = peak[i];
  if (gravity) {
    let tracking = select(1.0 - exp(-u.frame.z * 7.0), 1.0, u.frame.w > 0.5);
    next_peak[i] = Peak(mix(old.body, vec4f(location, light, 0), tracking), vec4f(0));
    return;
  }

  let bright = smoothstep(0.11, 0.84, light);
  let alternating = select(1.0, 0.71, (ij.x + ij.y) % 2u == 0u);
  let goal = (0.05 + bright * (0.20 + 1.52 * response())) * alternating * (1.0 - 0.91 * u.mode.y);
  let base = mix(middle, location, 0.38);
  if (u.frame.w > 0.5) {
    next_peak[i] = Peak(vec4f(base, light, goal), vec4f(0));
    return;
  }
  // A nearest-neighbor repulsion limits growth in crowded bright areas.
  let left = peak[i - min(1u, ij.x)].body.w;
  let right = peak[i + min(1u, grid.x - 1u - ij.x)].body.w;
  let up = peak[i - grid.x * min(1u, ij.y)].body.w;
  let down = peak[i + grid.x * min(1u, grid.y - 1u - ij.y)].body.w;
  let neighbors = (left + right + up + down) * 0.25;
  let force = (goal - old.body.w) * 113.0 - neighbors * 21.0;
  let velocity = (old.motion.x + force * u.frame.z) * exp(-u.frame.z * 9.0);
  let height = clamp(old.body.w + velocity * u.frame.z, 0.013, 2.4);
  next_peak[i] = Peak(vec4f(base, light, height), vec4f(velocity, 0, 0, 0));
}

fn home(i: u32) -> vec2f {
  let cell = vec2f(f32(i % GRAIN_GRID.x), f32(i / GRAIN_GRID.x));
  return (cell + vec2f(random(i, 47u), random(i, 89u))) / vec2f(GRAIN_GRID);
}

@compute @workgroup_size(64)
fn cs_dust(@builtin(global_invocation_id) tid: vec3u) {
  let i = tid.x;
  if (i >= GRAIN_GRID.x * GRAIN_GRID.y) { return; }
  let origin = home(i);
  if (u.frame.w > 0.5) {
    next_grain[i] = vec4f(origin, 0, 0);
    return;
  }

  let particle = grain[i];
  let p = particle.xy;
  let metric = vec2f(u.frame.x, 1);
  var pull = vec2f(0);
  for (var j = 0u; j < WELL_GRID.x * WELL_GRID.y; j++) {
    let well = peak[j].body;
    let d = (well.xy - p) * metric;
    let distance2 = dot(d, d);
    let soft = distance2 + 0.0020;
    let mass = pow(well.z, 2.0) * 0.0011;
    let local = 1.0 - smoothstep(0.026, 0.135, distance2);
    pull += local * mass * d * inverseSqrt(soft) / soft;
  }
  let edge = textureSampleLevel(edges, linear_clamp, p, 0).rg;
  let kick = (p - 0.5) * metric * (1.8 + random(i, 66u) * 6.0) * u.sound.z;
  let orbit = vec2f(-pull.y, pull.x) * (0.55 + random(i, 9u) * 1.1);
  let spring = (origin - p) * (0.7 + 22.0 * u.mode.y);
  let force = (pull + orbit) / metric * (0.16 + 5.5 * response()) + kick / metric + spring + edge * 0.20;
  let velocity = (particle.zw + force * u.frame.z) * exp(-u.frame.z * (1.35 + 4.0 * u.mode.y));
  let next = p + clamp(velocity, vec2f(-1.2), vec2f(1.2)) * u.frame.z;
  next_grain[i] = select(vec4f(next, velocity), vec4f(origin, 0, 0), any(next < vec2f(-0.09)) || any(next > vec2f(1.09)));
}

@fragment fn fs_surface(input: VOut) -> @location(0) vec4f {
  let uv = input.uv;
  let midpoint = uv - 0.5;
  let gravity = u.mode.x > 0.5;
  let edge = textureSample(edges, linear_clamp, uv).rg;
  let loud = response() * (1.0 - u.mode.y);
  let phase = u.frame.y * 1.8;
  let sweep = vec2f(sin(uv.y * 11.0 + phase), cos(uv.x * 12.0 - phase * 0.7));
  let bend = (midpoint * (-0.105 - 0.24 * u.sound.z) + sweep * select(0.046, 0.085, gravity) + edge * 0.39) * loud;

  let picture = textureSample(photo, linear_clamp, uv + bend).rgb;
  let vignette = 1.0 - smoothstep(0.23, 0.70, length(midpoint));
  let tint = u.tint.rgb * (0.012 + 0.022 * vignette + loud * 0.078);
  let exposure = select(0.36, 0.32, gravity) + loud * select(0.75, 0.78, gravity);
  let pool = picture * exposure * (0.78 + 0.25 * vignette) + tint;
  let undisturbed = textureSample(photo, linear_clamp, uv).rgb * 0.9;
  return vec4f(mix(pool, undisturbed, u.mode.y), 1);
}

struct Mark {
  @builtin(position) pos: vec4f,
  @location(0) shape: vec2f,
  @location(1) color: vec3f,
  @location(2) intensity: f32,
}

@vertex fn vs_needle(@builtin(vertex_index) vertex: u32, @builtin(instance_index) i: u32) -> Mark {
  // Paint rows from back to front so nearer needles occlude farther ones.
  let p = peak[i].body;
  let coord = QUAD[vertex];
  let rise = p.w * 0.116 + 0.009;
  let width = (0.012 + 0.007 * p.z + 0.014 * p.w) / u.frame.x;
  let lean = sin(p.x * 11.0 + u.frame.y * 2.0) * rise * 0.34;
  let y = (coord.y + 1.0) * 0.5;
  let pos = p.xy + vec2f(coord.x * width + y * lean, 0.009 - y * rise);
  let color = textureSampleLevel(photo, linear_clamp, p.xy, 0).rgb;
  return Mark(clip_uv(pos), vec2f(coord.x, y), color, p.z);
}

@fragment fn fs_needle(input: Mark) -> @location(0) vec4f {
  let x = input.shape.x;
  let y = input.shape.y;
  let radius = mix(0.95, 0.052, pow(y, 0.64));
  let aa = max(0.024, fwidth(x));
  let silhouette = (1.0 - smoothstep(-aa, aa, abs(x) - radius)) * smoothstep(0.0, 0.11, y);
  let fade = (1.0 - 0.94 * u.mode.y) * smoothstep(0.055, 0.40, input.intensity);
  let alpha = silhouette * fade * 0.94;
  let curve = x / max(0.055, radius);
  let gleam = exp(-18.0 * (curve + 0.31) * (curve + 0.31));
  let rim = smoothstep(0.58, 1.0, abs(curve));
  let tip = y * y * y;
  let flash = 0.65 + response() * 1.35;
  let metal = input.color * (0.09 + 0.55 * gleam + 0.6 * tip) + u.tint.rgb * (0.045 + (0.46 * gleam + 0.23 * rim + 0.65 * tip) * flash);
  return vec4f(metal * alpha, alpha);
}

@vertex fn vs_grain(@builtin(vertex_index) vertex: u32, @builtin(instance_index) i: u32) -> Mark {
  let p = grain[i];
  let rgb = textureSampleLevel(photo, linear_clamp, home(i), 0).rgb;
  let noise = random(i, 81u);
  let coord = QUAD[vertex];
  let speed = min(1.0, length(p.zw) * 1.7);
  let size = (0.0019 + noise * 0.005 + u.sound.z * 0.003) * (0.82 + 0.30 * speed);
  let axis = normalize(p.zw * vec2f(u.frame.x, 1) + vec2f(0.00001, 0.0));
  let along = axis * coord.x * (1.0 + 2.3 * speed);
  let side = vec2f(-axis.y, axis.x) * coord.y;
  let pos = p.xy + (along + side) * size / vec2f(u.frame.x, 1);
  return Mark(clip_uv(pos), coord, rgb, (0.32 + speed * 0.53 + noise * 0.25));
}

@fragment fn fs_grain(input: Mark) -> @location(0) vec4f {
  let glow = max(0.0, 1.0 - dot(input.shape, input.shape));
  let color = input.color * 0.66 + u.tint.rgb * 0.14;
  let light = glow * glow * input.intensity * (0.18 + 1.05 * response()) * (1.0 - u.mode.y);
  return vec4f(color * light, 0);
}
