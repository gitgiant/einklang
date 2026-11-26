fn ridge_random(column: i32, row: i32) -> f32 {
  return f32(h32(bitcast<u32>(column), bitcast<u32>(row)) >> 8u) / 16777216.0;
}

fn peak(column: i32, row: i32, lift: f32) -> f32 {
  let x = f32(column);
  // A wider profile across the pass and a different seed for the fine mesh relief.
  let bank = smoothstep(1.0, 4.0, abs(x) + 0.35 * sin(f32(row) * 0.64));
  let crest = 0.35 + 0.65 * max(0.0, 1.0 - abs(abs(x) - 5.0) / 5.2);
  let longRow = f32(row) / 4.0;
  let lower = i32(floor(longRow));
  let fine = fract(longRow);
  let ridge = mix(ridge_random(column, lower), ridge_random(column, lower + 1),
                  fine * fine * (3.0 - 2.0 * fine));
  return bank * crest * (0.24 + 0.66 * ridge) * lift;
}

fn ridge_line(dist: f32, radius: f32, pixel: f32) -> f32 {
  return 1.0 - smoothstep(radius * pixel, (radius + 1.0) * pixel, dist);
}

fn ridge_segment(p: vec2f, a: vec2f, b: vec2f) -> f32 {
  let delta = b - a;
  let t = clamp(dot(p - a, delta) / max(dot(delta, delta), 0.00000001), 0.0, 1.0);
  return length(p - a - delta * t);
}

fn shade(uv: vec2f) -> vec4f {
  let horizon = 0.49;
  let x = (uv.x - 0.5) * aspect();
  let p = vec2f(x, uv.y);
  let pixel = 1.0 / resolution().y;
  let night = palette(0.0);
  let mist = palette(0.25);
  let teal = palette(0.5);
  let mint = palette(0.75);
  let amber = palette(1.0);
  let drive = time() * p_speed() * 1.6;
  let start = i32(floor(drive));
  let lift = 0.72 + 0.82 * p_lift() + 0.65 * smoothstep(0.01, 0.65, bass());
  let dusk = exp(-abs(uv.y - horizon) * 5.4 - x * x * 0.85);
  var color = night * 0.64 + mist * dusk * 0.66;

  // A crescent fixes the skyline in place while the terrain passes beneath it.
  let moon = p - vec2f(0.34, 0.195);
  let disc = 1.0 - smoothstep(0.052 - pixel, 0.052 + pixel, length(moon));
  let eclipse = smoothstep(0.048 - pixel, 0.048 + pixel, length(moon - vec2f(0.021, -0.015)));
  color += amber * (disc * eclipse * 0.85 + 0.052 * exp(-dot(moon, moon) * 61.0));

  // Project parallel terrain rows from back to front. Dark faces in front obscure distant wires.
  // The two columns around this pixel give the local cross-section and its depth rails.
  for (var step = 13; step >= 0; step--) {
    let row = start + step;
    let z = 0.82 + (f32(step) - fract(drive) + 1.0) * 0.46;
    let nearScale = 1.0 / z;
    let farScale = 1.0 / (z + 0.46);
    let span = 0.29 * nearScale;
    let column = i32(floor(x / span));
    let left = f32(column) * 0.29;
    let right = left + 0.29;
    let a = vec2f(left * nearScale, horizon + (0.62 - peak(column, row, lift)) * nearScale);
    let b = vec2f(right * nearScale, horizon + (0.62 - peak(column + 1, row, lift)) * nearScale);
    let c = vec2f(left * farScale, horizon + (0.62 - peak(column, row + 1, lift)) * farScale);
    let d = vec2f(right * farScale, horizon + (0.62 - peak(column + 1, row + 1, lift)) * farScale);
    let depth = 1.0 - smoothstep(0.85, 7.5, z);
    let edge = ridge_line(ridge_segment(p, a, b), 0.50 + 0.44 * depth, pixel);
    let rail = ridge_line(min(ridge_segment(p, c, a), ridge_segment(p, d, b)), 0.34, pixel);
    let y = mix(a.y, b.y, fract(x / span));
    let face = smoothstep(y - pixel, y + pixel, uv.y) * smoothstep(0.31, 0.46, abs(x) * z);
    let wire = mix(teal, mint, depth) * p_glow() * (0.29 + 0.8 * depth);
    color = mix(color, mix(night, mist, 0.18 + 0.30 * depth) * 0.59, face);
    color += wire * (edge * 0.85 + rail * 0.61) * smoothstep(0.26, 0.5, abs(x) * z);
  }

  // The central pass is a dark road picked out by amber reflectors.
  let ground = uv.y - horizon;
  if (ground > 0.025) {
    let z = 0.62 / ground;
    let worldX = abs(x) * z;
    let shoulder = abs(worldX - 0.35) / z;
    let markers = smoothstep(0.55, 0.73, fract(z / 0.46 + drive));
    let paint = ridge_line(shoulder, 0.48, pixel) * markers;
    color += amber * paint * smoothstep(0.04, 0.31, ground) * (0.47 + 0.36 * p_glow());
  }
  return vec4f(color, 1.0);
}
