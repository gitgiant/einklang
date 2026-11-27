struct TankUniforms {
  view: vec4f, // aspect-preserving scale, seconds, pixel size
  water: vec4f, // wave number, audio level, swell
  drops: array<vec4f, 4>, // center, age in seconds, wave number at impact
};
@group(0) @binding(0) var<uniform> U: TankUniforms;

fn roundedBox(p: vec2f, size: vec2f, r: f32) -> f32 {
  let q = abs(p) - size + r;
  return min(max(q.x, q.y), 0.) + length(max(q, vec2f(0.))) - r;
}

// A circular wave train and its analytic radial slope. age=0 marks
// a continuously vibrating transducer; impacts have a finite wavefront.
fn wave(p: vec2f, source: vec2f, k: f32, shift: f32, age: f32) -> vec3f {
  let d = p - source;
  let radius = max(0.001, length(d));
  let theta = k * radius - shift;
  var envelope = 0.18 / (1. + 2.4 * radius);
  if (age > 0.) {
    let front = age * 1.19 - radius;
    envelope = 0.64 * smoothstep(0., 0.14, front) * (1. - smoothstep(0.78, 1.74, front))
      * (1. - smoothstep(1.32, 1.94, age)) / (1. + 1.65 * radius);
  }
  return vec3f(cos(theta) * envelope, sin(theta) * (-k / 34.) * envelope * d / radius);
}

@fragment fn fs_tank(in: VOut) -> @location(0) vec4f {
  let p = (in.uv - 0.5) * U.view.xy;
  let aa = U.view.w;
  let t = U.view.z;
  let level = U.water.y;
  let swell = U.water.z;
  let dims = 0.447 * U.view.xy;
  let edge = roundedBox(p, dims, 0.047);
  let inner = edge + 0.022;
  let light = clamp(0.65 - p.x * 0.31 - p.y * 0.35, 0.18, 1.);
  let vignette = max(0., 1. - length(p / U.view.xy) * 1.45);
  let slate = vec3f(0.010, 0.015, 0.020) + vignette * vec3f(0.026, 0.040, 0.046);
  let shadow = 1. - 0.73 * (1. - smoothstep(0., 0.05, roundedBox(p - vec2f(0.013, 0.027), dims, 0.047)));
  var color = slate * shadow;
  if (edge > aa) {
    return vec4f(color, 1.);
  }

  let rail = vec3f(0.054, 0.069, 0.074) * light;
  let lip = (1. - smoothstep(aa, 3.*aa, abs(inner - 0.005))) * light;
  let marks = (1. - smoothstep(0.037, 0.10, abs(fract(p.x * 32. + 0.5) - 0.5)))
    * smoothstep(0.001, 0.003, inner) * (1. - smoothstep(0.011, 0.014, inner))
    * (1. - smoothstep(0.011, 0.030, abs(abs(p.y) - dims.y)));
  let metal = rail + (0.24 * lip + 0.25 * marks) * vec3f(0.82, 0.53, 0.26);
  color = mix(color, metal, 1. - smoothstep(-aa, aa, edge));
  if (inner > aa) {
    return vec4f(color, 1.);
  }

  let k = U.water.x;
  let port = 0.27 * U.view.x;
  let left = vec2f(-port, -0.08);
  let right = vec2f(port, 0.08);
  let drift = t * 4.2;
  var surface = wave(p, left, k, drift, 0.) + wave(p, right, k, drift + 1.25, 0.);
  var impacts = 0.;
  for (var i = 0u; i < 4u; i++) {
    let drop = U.drops[i];
    if (drop.z > 0.) {
      surface += wave(p, drop.xy, drop.w, drop.w * drop.z * 1.19, drop.z) * swell;
      impacts += (1. - smoothstep(0.006, 0.025 + drop.z * 0.03, distance(p, drop.xy)))
        * (1. - smoothstep(0., 0.25, drop.z));
    }
  }

  let normal = normalize(vec3f(-surface.yz * (1.45 + 0.85 * level), 1.));
  let key = max(0., dot(normal, vec3f(-0.38, -0.31, 0.872)));
  let strip = exp(-17. * abs(normal.y + 0.19)) * (0.58 + 0.42 * cos(3.1 * p.x));
  let trough = clamp(0.5 + surface.x * 0.62, 0., 1.);
  let depth = vec3f(0.011, 0.035, 0.057) + level * swell * vec3f(0.012, 0.104, 0.120);
  let blue = vec3f(0.026, 0.154, 0.210) * trough * key;
  let reflection = vec3f(0.30, 0.76, 0.85) * strip * (0.31 + level * 0.26);
  let crossed = smoothstep(0.44, 0.96, surface.x) * vec3f(0.38, 0.63, 0.47);
  let portDistance = min(distance(p, left), distance(p, right));
  let pin = (1. - smoothstep(0.008, 0.014, portDistance)) * vec3f(0.34, 0.78, 0.75);
  let meniscus = exp(min(0., inner * 98.)) * vec3f(0.068, 0.24, 0.26);
  let water = (depth + blue + reflection + crossed) * (0.68 + 0.34 * vignette)
    + pin + meniscus + impacts * vec3f(0.52, 0.94, 0.68);
  return vec4f(mix(color, water, 1. - smoothstep(-aa, aa, inner)), 1.);
}
