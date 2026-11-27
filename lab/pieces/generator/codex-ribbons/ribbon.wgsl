struct Ribbon {
  size: vec2f,
  seconds: f32,
  orbit: f32,
  width: f32,
  rms: f32,
  low: f32,
  high: f32,
  strike: f32,
  points: f32,
  layers: f32,
}
@group(0) @binding(0) var<uniform> R: Ribbon;
@group(0) @binding(1) var<storage, read> stereo: array<vec2f>;

const TAU = 6.2831853;

@fragment fn chamber(@builtin(position) pixel: vec4f) -> @location(0) vec4f {
  let q = (pixel.xy - 0.5 * R.size) / min(R.size.x, R.size.y);
  let radius = length(q);
  let energy = clamp(R.rms * 2.6 + R.strike * 0.1, 0.0, 1.0);
  let spill = exp(-dot(q * vec2f(1.15, 1.7), q * vec2f(1.15, 1.7)) * 1.9);
  let balance = smoothstep(-0.65, 0.65, q.x - 0.4 * q.y + (R.high - R.low) * 0.6);
  let dark = vec3f(0.018, 0.007, 0.041);
  let lit = mix(vec3f(0.24, 0.026, 0.18), vec3f(0.068, 0.10, 0.36), balance);
  let grain = fract(52.9829189 * fract(dot(floor(pixel.xy), vec2f(0.06711056, 0.00583715))));
  let arc = 1.0 - smoothstep(0.001, 0.0024, abs(radius - 0.451));
  let angle = atan2(q.y, q.x + 0.000001);
  let marks = arc * smoothstep(0.80, 0.99, abs(sin(angle * 3.0 + R.seconds * 0.14)));
  return vec4f(vec3f(0.008, 0.006, 0.021) + mix(dark, lit, energy) * spill * (0.92 + 0.16 * grain)
    + marks * vec3f(0.032, 0.035, 0.078), 1.0);
}

fn center(i: u32, age: f32) -> vec3f {
  let u = f32(i) / (R.points - 1.0);
  let t = u * TAU;
  let spin = R.seconds * 0.29 - age * 0.22;
  let pair = stereo[u32(age * R.points) + i] * exp(-0.11 * age);
  let scale = 0.84 + 0.65 * R.rms;
  return vec3f(
    scale * 1.03 * sin(2.0 * t + spin) + 1.52 * pair.x,
    scale * 0.83 * sin(3.0 * t - spin * 0.52 + 0.7) + 1.42 * pair.y,
    scale * 0.76 * cos(t + spin * 0.78) + 0.97 * (pair.x - pair.y) - age * 0.13
  );
}

struct Fold {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
  @location(1) face: f32,
  @location(2) @interpolate(flat) age: f32,
}

@vertex fn weave(@builtin(vertex_index) vertex: u32, @builtin(instance_index) layer: u32) -> Fold {
  let i = vertex / 2u;
  let side = f32(vertex % 2u);
  let age = R.layers - 1.0 - f32(layer);
  let u = f32(i) / (R.points - 1.0);
  let p = center(i, age);
  let tangent = normalize(center(min(i + 1u, u32(R.points) - 1u), age) - center(max(i, 1u) - 1u, age) + vec3f(0.00001));
  let twist = u * TAU * 2.0 + R.seconds * 0.54 - 0.18 * age;
  let warp = vec3f(cos(twist), sin(twist), 0.7);
  let across = normalize(cross(tangent, warp) + vec3f(0.00001));
  let normal = cross(tangent, across);
  let taper = 0.17 + 0.83 * smoothstep(0.0, 0.08, u) * (1.0 - smoothstep(0.90, 1.0, u));
  let breadth = R.width * (0.11 + 0.45 * R.rms + 0.085 * R.high) * taper;
  let world = p + across * ((side * 2.0 - 1.0) * breadth);

  let yaw = R.seconds * R.orbit;
  let pitch = 0.21 + 0.19 * sin(yaw * 0.72);
  let right = vec3f(cos(yaw), 0.0, -sin(yaw));
  let up = vec3f(-sin(yaw) * sin(pitch), cos(pitch), -cos(yaw) * sin(pitch));
  let forward = cross(right, up);
  let depth = 4.15 - dot(world, forward);
  let fit = min(R.size.x, R.size.y) / R.size;
  let clip = vec2f(dot(world, right), dot(world, up)) * fit * 2.1;
  let face = abs(dot(normal, normalize(vec3f(-0.36, 0.56, 0.75))));
  return Fold(vec4f(clip, (depth - 0.5) * 0.92, depth), vec2f(u, side), face, age);
}

@fragment fn silk(f: Fold) -> @location(0) vec4f {
  let selvedge = smoothstep(0.87, 0.98, abs(f.uv.y * 2.0 - 1.0));
  let threads = pow(0.5 + 0.5 * cos(f.uv.y * TAU * 8.0), 7.0);
  let stitch = pow(0.5 + 0.5 * sin(f.uv.x * TAU * 64.0), 7.0);
  let hue = 0.5 + 0.5 * sin(f.uv.x * TAU * 1.5 - R.seconds * 0.6 + f.uv.y * 2.0 - f.age * 0.32);
  let pigment = mix(vec3f(0.025, 0.54, 1.10), vec3f(1.24, 0.095, 0.29), hue);
  let energy = 0.82 + R.rms * 1.4 + R.strike * 0.15;
  let sheen = 0.22 + 0.65 * pow(f.face, 2.0) + 0.10 * threads + 0.06 * stitch;
  let edgeLight = mix(vec3f(0.44, 0.90, 1.32), vec3f(1.37, 0.49, 0.60), hue);
  let opacity = select(0.84, 0.22 * exp(-f.age * 0.32), f.age > 0.0);
  let taper = smoothstep(0.0, 0.018, f.uv.x) * (1.0 - smoothstep(0.975, 1.0, f.uv.x));
  return vec4f((pigment * sheen + edgeLight * selvedge * 0.72) * energy, opacity * taper);
}
