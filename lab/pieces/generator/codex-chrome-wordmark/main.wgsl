fn cut(d: f32, aa: f32) -> f32 {
  return 1.0 - smoothstep(-aa, aa, d);
}

fn box(p: vec2f, h: vec2f) -> f32 {
  let d = abs(p) - h;
  return length(max(d, vec2f(0.0))) + min(max(d.x, d.y), 0.0);
}

fn stroke(p: vec2f, a: vec2f, b: vec2f, radius: f32) -> f32 {
  let v = b - a;
  return length(p - a - v * clamp(dot(p - a, v) / dot(v, v), 0.0, 1.0)) - radius;
}

// AURA is four geometric glyphs cut from the same beveled stock.
fn wordmark(p: vec2f) -> f32 {
  let letter = clamp(floor((p.x + 0.61) / 0.305), 0.0, 3.0);
  let q = vec2f(p.x + 0.4575 - letter * 0.305 + p.y * 0.14, p.y);
  if (letter == 0.0 || letter == 3.0) {
    let leg = stroke(vec2f(abs(q.x), q.y), vec2f(0.0, -0.105), vec2f(0.109, 0.108), 0.021);
    return min(leg, box(q - vec2f(0.0, 0.043), vec2f(0.075, 0.017)));
  }
  if (letter == 1.0) {
    let outer = box(q - vec2f(0.0, -0.015), vec2f(0.093, 0.112)) - 0.019;
    let inner = box(q - vec2f(0.0, -0.056), vec2f(0.067, 0.139)) - 0.007;
    return max(outer, -inner);
  }
  let stem = box(q + vec2f(0.092, 0.0), vec2f(0.021, 0.127));
  let bowl = box(q + vec2f(0.0, 0.059), vec2f(0.087, 0.047)) - 0.021;
  let hole = box(q + vec2f(0.004, 0.059), vec2f(0.061, 0.026)) - 0.005;
  let leg = stroke(q, vec2f(-0.009, -0.002), vec2f(0.106, 0.109), 0.023);
  return min(min(stem, max(bowl, -hole)), leg);
}

fn shade(uv: vec2f) -> vec4f {
  let t = time();
  let aa = 1.05 / resolution().y;
  let p = vec2f((uv.x - 0.5) * aspect(), uv.y);
  let lift = clamp(1.45 * bass() + 1.30 * rms(), 0.0, 1.0);
  let kick = max(onset(), exp(-phase() * 11.0) * 0.65 * lift);
  let dusk = palette(0.0);
  let orchid = palette(0.2);
  let pink = palette(0.4);
  let peach = palette(0.6);
  let aqua = palette(0.8);

  let horizon = 0.68;
  let glow = exp(-4.5 * length((p - vec2f(0.0, horizon)) * vec2f(0.65, 1.0)));
  var rgb = mix(dusk * 0.45, orchid * (0.50 + 1.65 * lift), glow);
  rgb += pink * (0.13 + 0.32 * lift) * exp(-13.0 * abs(p.y - horizon));

  let sun = p - vec2f(0.032 * sin(0.27 * t), 0.350 - 0.045 * lift);
  let radius = 0.264 + 0.035 * lift;
  let sunEdge = length(sun) - radius;
  let stripeY = sun.y + 0.005 * kick * sin(sun.y * 48.0);
  let slit = smoothstep(-0.055, 0.225, sun.y) * (0.68 - 0.18 * kick);
  let stripes = smoothstep(slit - 0.04, slit + 0.04, fract(stripeY / 0.044 + 0.4));
  let disc = cut(sunEdge, aa) * mix(1.0, stripes, smoothstep(-0.041, 0.021, sun.y));
  let sunColor = mix(peach * 1.52, pink * 1.02, smoothstep(-radius, radius, sun.y));
  rgb += sunColor * (0.09 + 0.22 * lift) * exp(-22.0 * max(sunEdge, 0.0));
  rgb = mix(rgb, sunColor * (0.80 + 0.55 * lift), disc);

  if (p.y > horizon) {
    let depth = p.y - horizon;
    let z = 0.51 / (depth + 0.024);
    let grid = vec2f(p.x * z * 2.6, z + t * (0.77 + 0.10 * sin(t * 0.42)));
    let edge = abs(fract(grid + 0.5) - 0.5);
    let footprint = aa * vec2f(z * 2.6, z * z / 0.51);
    let line = 1.0 - smoothstep(vec2f(0.014), vec2f(0.026) + footprint, edge);
    let visibility = smoothstep(0.038, 0.123, depth);
    let floorColor = mix(orchid * (0.57 + 1.05 * lift), dusk * 0.53, smoothstep(0.0, 0.32, depth));
    let beam = mix(pink, aqua, visibility) * (0.55 + lift * 0.85);
    rgb = floorColor + beam * max(line.x, line.y) * visibility;
    rgb += pink * (0.65 + 0.38 * kick) * exp(-depth * 118.0);
  }

  let title = p - vec2f(0.023 * sin(t * 0.71), 0.531 + 0.025 * sin(t * 0.43) - 0.024 * lift);
  let d = wordmark(title);
  let shadow = wordmark(title - vec2f(0.010, 0.019));
  rgb = mix(rgb, dusk * 0.68, 0.84 * cut(shadow - 0.008, aa));
  let fringe = 0.003 + 0.003 * kick;
  rgb += pink * 0.26 * cut(wordmark(title - vec2f(fringe, 0.0)) - 0.010, aa);
  rgb += aqua * 0.23 * cut(wordmark(title + vec2f(fringe, 0.0)) - 0.010, aa);
  rgb += aqua * 0.08 * exp(-65.0 * abs(d));
  let contour = cut(d - 0.008, aa);
  rgb = mix(rgb, vec3f(0.045, 0.024, 0.095), contour);
  let reflectedSky = mix(vec3f(0.056, 0.08, 0.28), vec3f(1.04, 1.36, 1.63), smoothstep(-0.13, -0.010, title.y));
  let reflectedGround = mix(vec3f(0.09, 0.017, 0.14), vec3f(0.78, 0.32, 0.60), smoothstep(0.016, 0.119, title.y));
  var chrome = mix(reflectedSky, reflectedGround, smoothstep(-0.005, 0.004, title.y));
  chrome += vec3f(0.60, 0.88, 1.04) * exp(-190.0 * abs(title.y + 0.007));
  let bevel = exp(-130.0 * abs(d + 0.0015));
  chrome = mix(chrome, mix(pink, vec3f(1.7, 1.9, 2.15), (1.0 - smoothstep(-0.13, 0.09, title.y))), bevel * 0.73);
  let sweep = title.x + title.y * 0.75 - (fract(t * 0.18) * 1.68 - 0.84);
  chrome += vec3f(0.64, 0.90, 1.0) * exp(-32.0 * abs(sweep)) * (0.55 + kick);
  rgb = mix(rgb, chrome, cut(d, aa));

  let starPos = title - vec2f(0.385, -0.101);
  let rays = exp(-length(starPos * vec2f(90.0, 450.0))) + exp(-length(starPos * vec2f(450.0, 79.0)));
  rgb += vec3f(0.72, 1.08, 1.30) * rays * (0.52 + kick * 1.8);
  rgb *= 1.0 - 0.34 * dot(uv - vec2f(0.5), uv - vec2f(0.5));
  return vec4f(rgb, 1.0);
}
