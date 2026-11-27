struct Controls {
  frame: vec4f, // aspect, time, reset, plate
  sound: vec4f, // level, bass, onset age, drive
  impact: vec4f, // onset center, refraction, photo strength
}

@group(0) @binding(0) var<uniform> u: Controls;
@group(0) @binding(1) var linear_clamp: sampler;
@group(0) @binding(2) var surface: texture_2d<f32>;
@group(0) @binding(3) var next_surface: texture_storage_2d<rgba16float, write>;
@group(0) @binding(4) var luma: texture_2d<f32>;
@group(0) @binding(5) var edges: texture_2d<f32>;
@group(0) @binding(6) var photo: texture_2d<f32>;

fn plate_mode(uv: vec2f, mode: f32) -> f32 {
  let p = uv - 0.5;
  if (mode > 1.5) {
    let r = length(p * vec2f(u.frame.x, 1.0));
    return cos(r * 58.0) * cos((p.x - p.y) * 19.0) * (1.0 - smoothstep(0.25, 1.05, r));
  }
  if (mode > 0.5) {
    return cos(p.x * 37.7) * cos(p.y * 25.1) - cos(p.x * 12.6) * cos(p.y * 43.98);
  }
  return sin(uv.x * 19.0 + uv.y * 14.0) * cos(uv.y * 28.0 - uv.x * 18.0);
}

@compute @workgroup_size(8, 8)
fn cs_wave(@builtin(global_invocation_id) tid: vec3u) {
  let size = textureDimensions(surface);
  if (any(tid.xy >= size)) { return; }
  let p = vec2i(tid.xy);
  let last = vec2i(size) - 1;
  let uv = (vec2f(p) + 0.5) / vec2f(size);
  let mode = plate_mode(uv, u.frame.w);
  if (u.frame.z > 0.5) {
    let initial = mode * 0.075;
    textureStore(next_surface, p, vec4f(initial, initial, 0.0, 0.0));
    return;
  }

  // Leapfrog wave equation. The luma-dependent coefficient stays below the 2D stability limit.
  let h = textureLoad(surface, p, 0).rg;
  let left = textureLoad(surface, max(p - vec2i(1, 0), vec2i(0)), 0).r;
  let right = textureLoad(surface, min(p + vec2i(1, 0), last), 0).r;
  let up = textureLoad(surface, max(p - vec2i(0, 1), vec2i(0)), 0).r;
  let down = textureLoad(surface, min(p + vec2i(0, 1), last), 0).r;
  let light = textureSampleLevel(luma, linear_clamp, uv, 0.0).r;
  let edge = length(textureSampleLevel(edges, linear_clamp, uv, 0.0).rg);
  let speed2 = mix(0.17, 0.43, clamp(light, 0.0, 1.0));
  let wall = min(min(uv.x, 1.0 - uv.x), min(uv.y, 1.0 - uv.y));
  let damping = 0.993 - min(0.19, edge * 0.34) - 0.08 * (1.0 - smoothstep(0.0, 0.04, wall));

  let kick_age = u.sound.z;
  let strike = max(0.0, 1.0 - kick_age * 0.22);
  let r = length((uv - u.impact.xy) * vec2f(u.frame.x, 1.0));
  let spot = max(0.0, 1.0 - r * 15.0);
  let kick = spot * spot * strike * u.sound.w * 0.085;
  let pump = sin(u.frame.y * (4.2 + u.frame.w * 1.7));
  let vibration = mode * pump * (0.002 + u.sound.y * 0.013);
  let laplacian = left + right + up + down - 4.0 * h.x;
  let next = h.x + damping * (h.x - h.y) + speed2 * laplacian + vibration + kick;
  textureStore(next_surface, p, vec4f(clamp(next, -2.0, 2.0), h.x, 0.0, 0.0));
}

fn height_at(uv: vec2f) -> f32 {
  return textureSampleLevel(surface, linear_clamp, uv, 0.0).r;
}

@fragment fn fs_wave(input: VOut) -> @location(0) vec4f {
  let uv = input.uv;
  let texel = 1.0 / vec2f(textureDimensions(surface));
  let h = height_at(uv);
  let slope = vec2f(height_at(uv + vec2f(texel.x, 0.0)), height_at(uv + vec2f(0.0, texel.y))) - h;
  let level = u.sound.x;
  let mode = u.frame.w;
  let nodal = mode > 0.5 && mode < 1.5;
  let warm = mode > 1.5;
  let tone = select(select(vec3f(0.10, 0.81, 0.86), vec3f(0.61, 0.78, 1.0), nodal),
                    vec3f(1.0, 0.47, 0.16), warm);
  let r = length((uv - u.impact.xy) * vec2f(u.frame.x, 1.0));
  let strike = 1.0 - smoothstep(1.0, 24.0, u.sound.z);
  let crest = exp(-abs(r - u.sound.z * 0.012) * 63.0) * strike;
  let warp = slope * u.impact.z * (0.46 + level * 0.32) + (uv - u.impact.xy) * crest * 0.032;
  let rgb = max(vec3f(0.0), textureSampleLevel(photo, linear_clamp, uv + warp, 0.0).rgb);
  let light = dot(rgb, vec3f(0.2126, 0.7152, 0.0722));
  let raw_edges = textureSampleLevel(edges, linear_clamp, uv, 0.0).rg;
  let gradient = dot(slope, vec2f(18.0, -24.0));
  let shimmer = clamp(0.5 + gradient, 0.0, 1.0);
  let lines = 1.0 - smoothstep(0.024, 0.11, abs(h));
  let foam = smoothstep(0.25, 0.93, shimmer) * (0.32 + 0.68 * min(1.0, abs(h) * 1.8));
  let gleam = select(foam, lines * (0.40 + shimmer * 0.60), nodal);
  let colored = mix(rgb, light * (vec3f(0.19, 0.24, 0.28) + tone), select(0.40, 0.67, nodal));
  let picture = colored * u.impact.w * (0.43 + level * 0.98) * (0.52 + shimmer * 0.86);
  let etched = min(0.18, length(raw_edges)) * (0.25 + level * 0.38);
  let glow = gleam * (0.075 + level * 0.19) + etched + crest * 0.10;
  let vignette = 1.0 - 0.55 * dot(uv - 0.5, uv - 0.5);
  return vec4f((vec3f(0.012, 0.017, 0.028) + tone * (0.012 + level * 0.052 + glow) + picture) * vignette, 1.0);
}
