const PIN_TURN = 6.283185307;
const PIN_COUNT = 96.0;

fn pin_at(index: f32) -> vec2f {
  let angle = index * (PIN_TURN / PIN_COUNT);
  return vec2f(cos(angle), sin(angle));
}

fn pin_index(v: vec2f) -> f32 {
  return round(atan2(v.y, v.x) * (PIN_COUNT / PIN_TURN));
}

// Intersect the ray through this pixel and the first pin with the hoop. Snapping
// the far end to a pin gives the nearest strand in that pin's fan.
fn pin_fan(p: vec2f, start: f32, normal: vec2f, aa: f32, pull: f32, reset: f32) -> f32 {
  let a = pin_at(start);
  let ray = p - a;
  let b = pin_at(pin_index(a - 2.0 * dot(ray, a) / max(dot(ray, ray), 0.00001) * ray));
  let chord = b - a;
  let chord_sq = max(dot(chord, chord), 0.00001);
  let at = clamp(dot(ray, chord) / chord_sq, 0.0, 1.0);
  let direction = chord * inverseSqrt(chord_sq);
  let sideways = vec2f(direction.y, -direction.x);
  // A taut thread straightens on bass. Its ends stay fixed on their pins.
  let sag = at * (1.0 - at) * 0.024 * (1.0 - pull);
  let distance = length(ray - chord * at - sideways * sag);
  let thread = 1.0 - smoothstep(aa * 0.37, aa * (1.28 + 0.68 * pull), distance);
  let alignment = 1.0 - abs(dot(normal, direction));
  let feed = 1.0 - smoothstep(1.0 - reset * 0.96, 1.04 - reset * 0.95, at);
  return thread * feed * (0.34 + 0.66 * alignment * alignment);
}

fn pin_grain(uv: vec2f) -> f32 {
  let pixel = floor(uv * resolution() * 0.8);
  return fract(52.9829189 * fract(dot(pixel, vec2f(0.06711056, 0.00583715))));
}

fn shade(uv: vec2f) -> vec4f {
  // The oval stretches across the screen with breathing room around the pinheads.
  let p = (uv - 0.5) * vec2f(2.34, 2.32);
  let radius = length(p);
  let aa = clamp(1.8 / resolution().y, 0.0035, 0.006);
  let salt = pin_grain(uv);
  let pull = smoothstep(0.10, 0.72, bass());
  let air = smoothstep(0.12, 0.68, (band(7) + band(10) + band(13)) / 3.0);
  let outside = vec3f(0.025, 0.019, 0.023) * (0.83 + 0.2 * salt - 0.20 * radius);
  var result = outside;

  if (radius < 1.035) {
    let knot = pin_at(pin_index(p + vec2f(0.00001, 0.0)));
    let pin_delta = p - knot;
    let pin_shadow = 1.0 - smoothstep(0.010, 0.017, length(pin_delta - vec2f(0.006, 0.008)));
    let metal = 1.0 - smoothstep(0.009, 0.009 + aa * 1.2, length(pin_delta));
    let shine = 1.0 - smoothstep(0.002, 0.008 + aa, length(pin_delta + vec2f(0.003)));
    let hoop = smoothstep(0.019, 0.004, abs(radius - 1.0));
    let paper = vec3f(0.013, 0.025, 0.047) * (1.15 + 0.25 * salt);
    let color = tex_picture(uv).rgb;
    let luma = tex_light(uv).r;
    let edge = tex_edges(uv).xy;
    let edge_size = length(edge);
    let normal = edge / max(edge_size, 0.002);
    let detail = smoothstep(0.006, 0.087, edge_size);
    let ink = vec3f(0.011, 0.023, 0.037) + color * vec3f(0.24, 0.30, 0.37);
    let start = round(p_layout() * PIN_COUNT);
    let reset = p_reset();
    let gold = pin_fan(p, start, normal, aa, pull, reset);
    let blue = pin_fan(p, start + 25.0, normal, aa, pull, reset * 0.84);
    let silver = pin_fan(p, start + 54.0, normal, aa, pull, reset * 0.70);
    let red = pin_fan(p, start + 72.0, normal, aa, pull, reset * 0.55);
    let fiber = gold * vec3f(0.62, 0.28, 0.092)
      + blue * vec3f(0.12, 0.43, 0.63)
      + silver * vec3f(0.41, 0.53, 0.54)
      + red * vec3f(0.46, 0.18, 0.15);
    let dye = 0.64 + 0.36 * sqrt(clamp(color, vec3f(0.0), vec3f(1.0)));
    let line_strength = (0.10 + 0.33 * luma + 0.95 * detail) * (0.64 + 0.82 * pull + 0.30 * air);
    let lit = ink * (0.45 + 0.7 * pull + 0.55 * air) + fiber * dye * line_strength * (0.87 + 0.17 * salt);
    let face = mix(paper, lit + paper * 0.6, 1.0 - smoothstep(0.994, 1.0, radius));
    let frame = mix(outside, face, 1.0 - smoothstep(0.996, 1.026, radius));
    result = (frame + vec3f(0.14, 0.069, 0.031) * hoop) * (1.0 - 0.65 * pin_shadow);
    result += metal * (vec3f(0.53, 0.27, 0.085) + vec3f(0.43, 0.32, 0.16) * shine);
  }
  return vec4f(result, 1.0);
}
