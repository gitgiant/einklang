struct Pendulum {
  size: vec2f,
  reveal: f32,
  bpm: f32,
  phrase: f32,
  fade: f32,
  rms: f32,
  strike: f32,
  spread: f32,
  ink: f32,
  segments: f32,
  period: f32,
}
@group(0) @binding(0) var<uniform> P: Pendulum;

const TAU = 6.2831853;

fn scale() -> f32 {
  return min(P.size.x, P.size.y);
}

@fragment fn paper(@builtin(position) pixel: vec4f) -> @location(0) vec4f {
  let q = (pixel.xy - P.size * 0.5) / scale();
  let radius = length(q);
  let light = clamp(P.rms * 2.9 + P.strike * 0.12, 0.0, 1.0);
  let wash = exp(-dot(q, q) * 2.7);
  let grid = abs(fract(q / 0.05 + 0.5) - 0.5) * 0.05 * scale();
  let dotGrid = (1.0 - smoothstep(0.45, 1.45, length(grid))) * exp(-radius * radius * 8.0);
  let circle = 1.0 - smoothstep(0.35, 1.45, abs(radius - 0.427) * scale());
  let angle = atan2(q.y, q.x + 0.000001);
  let ticks = smoothstep(0.975, 0.999, cos(48.0 * angle)) *
    smoothstep(0.427, 0.432, radius) * (1.0 - smoothstep(0.436, 0.441, radius));
  let grain = fract(52.9829189 * fract(dot(floor(pixel.xy), vec2f(0.06711056, 0.00583715))));
  let base = vec3f(0.006, 0.012, 0.022);
  let pigment = mix(vec3f(0.012, 0.038, 0.063), vec3f(0.033, 0.18, 0.145), light);
  let marks = vec3f(0.08, 0.15, 0.14) * (dotGrid * 0.45 + circle * 0.32 + ticks * 0.5);
  return vec4f(base + pigment * wash * (0.89 + 0.22 * grain) + marks, 1.0);
}

fn pendulum(t: f32, phrase: f32) -> vec2f {
  let tempo = clamp((P.bpm - 80.0) / 100.0, 0.0, 1.0);
  let angle = TAU * t;
  let phase = phrase * 0.49;
  // Primary and secondary pendulums contribute to each axis at different damping rates.
  let primary = vec2f(sin((5.0 + tempo) * angle + phase),
                      sin((7.0 - tempo) * angle + phase * 0.72 + 1.1)) * exp(-0.91 * t);
  let secondary = vec2f(sin((9.0 + tempo) * angle - phase * 0.64),
                        sin((4.0 + tempo) * angle + phase + 0.8)) * exp(-1.8 * t);
  let extent = (0.18 + 0.23 * sqrt(P.rms) + 0.024 * P.strike) * P.spread;
  return (primary + 0.31 * secondary) * extent * scale();
}

struct Stroke {
  @builtin(position) pos: vec4f,
  @location(0) coordinate: vec2f,
  @location(1) @interpolate(flat) extent: f32,
  @location(2) @interpolate(flat) style: vec3f,
}

@vertex fn strokeVertex(@builtin(vertex_index) vertex: u32, @builtin(instance_index) instance: u32) -> Stroke {
  let quad = array<vec2f, 6>(vec2f(0, -1), vec2f(1, -1), vec2f(0, 1),
                              vec2f(0, 1), vec2f(1, -1), vec2f(1, 1));
  let corner = quad[vertex];
  let segment = f32(instance % u32(P.segments));
  let previous = instance >= u32(P.segments);
  let reveal = select(P.reveal, 1.0, previous);
  let phrase = P.phrase - select(0.0, P.period, previous);
  let t0 = min(segment / P.segments, reveal);
  let t1 = min((segment + 1.0) / P.segments, reveal);
  let a = pendulum(t0, phrase);
  let b = pendulum(t1, phrase);
  let extent = length(b - a);
  let tangent = (b - a) / max(0.0001, extent);
  let normal = vec2f(-tangent.y, tangent.x);
  let halo = max(2.2, scale() * 0.007);
  let along = mix(-halo, extent + halo, corner.x);
  let across = halo * corner.y;
  let pt = a + tangent * along + normal * across;
  let head = exp(-75.0 * (reveal - t1));
  let fresh = (0.29 + 0.71 * exp(-3.4 * (reveal - t1))) * step(0.0001, extent);
  let ghost = 0.24 * pow(P.fade, 4.0);
  return Stroke(vec4f(pt / P.size * vec2f(2.0, -2.0), 0.0, 1.0),
                vec2f(along, across), extent, vec3f(select(fresh, ghost, previous), t1, select(head, 0.0, previous)));
}

@fragment fn strokeInk(s: Stroke) -> @location(0) vec4f {
  let d = length(vec2f(s.coordinate.x - clamp(s.coordinate.x, 0.0, s.extent), s.coordinate.y));
  let weight = min(1.0, s.extent / max(2.0, scale() * 0.004));
  let nib = max(0.68, scale() * (0.00115 + P.rms * 0.0013));
  let body = 1.0 - smoothstep(nib * 0.5, nib + 0.55, d);
  let glow = exp(-d * d / (max(1.0, scale() * 0.003) * max(1.0, scale() * 0.003)));
  let ink = mix(vec3f(0.22, 0.81, 0.63), vec3f(1.28, 0.36, 0.09), smoothstep(0.06, 0.78, s.style.y));
  let color = mix(ink, vec3f(1.38, 0.91, 0.47), s.style.z * 0.66);
  let intensity = (body * 0.87 + glow * (0.095 + s.style.z * 0.18)) * s.style.x * weight;
  return vec4f(color * intensity * P.ink * (0.78 + P.rms * 1.35 + P.strike * 0.25), 1.0);
}
