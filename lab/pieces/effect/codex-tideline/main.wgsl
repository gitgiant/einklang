// Coordinates are in screen heights, with the skyline sitting on the waterline.
fn box(p: vec2f, half_size: vec2f) -> f32 {
  let d = abs(p) - half_size;
  return length(max(d, vec2f(0.0))) + min(max(d.x, d.y), 0.0);
}

fn hash_cell(x: f32) -> f32 {
  return fract(sin(x * 21.71 + 4.8) * 43758.5453);
}

fn shade(uv: vec2f) -> vec4f {
  let p = (uv - vec2f(0.5, 0.68)) * vec2f(aspect(), 1.0);
  let aa = 1.25 / resolution().y;
  let t = time();
  let hit = pow(1.0 - phase(), 5.0) * bass();
  let energy = clamp(bass() * 1.35 + rms() * 0.7 + onset() * 0.16, 0.0, 1.0);
  let violet = vec3f(0.30, 0.025, 0.40);
  let amber = vec3f(1.00, 0.26, 0.08);
  let aqua = vec3f(0.05, 0.60, 0.75);
  let water = p.y > 0.0;
  let depth = max(p.y, 0.0);
  var q = p;
  if (water) {
    let ripple = sin(depth * 119.0 - t * 3.8 + sin(p.x * 7.0)) + 0.36 * sin(depth * 251.0 + t * 6.0);
    q.x += ripple * (0.002 + depth * (0.10 + 0.25 * energy));
    q.y = -depth * 1.58;
  }

  let dusk = exp(q.y * 5.0);
  var col = vec3f(0.008, 0.006, 0.034) + dusk * mix(violet * 0.22, amber * 0.46, energy);
  let sun_pos = q - vec2f(0.52, -0.33);
  let sun = 1.0 - smoothstep(0.144, 0.144 + aa, length(sun_pos));
  let sunset_bands = smoothstep(0.27, 0.42, fract((sun_pos.y + 0.16) * 49.0));
  col += sun * mix(amber, vec3f(0.76, 0.075, 0.37), clamp(sun_pos.y * 3.0 + 0.48, 0.0, 1.0))
    * mix(1.0, sunset_bands, smoothstep(-0.06, 0.10, sun_pos.y));

  let city_x = q.x * 24.0 + 0.27;
  let block = floor(city_x);
  let roof = 0.024 + 0.145 * pow(hash_cell(block), 2.0);
  let building = q.y > -roof && fract(city_x) < 0.85;
  if (building) {
    let pane = fract(vec2f(city_x * 3.0, q.y * 125.0));
    let pane_lit = hash_cell(block * 27.0 + floor(q.y * 125.0)) > 0.54 - energy * 0.32;
    col = vec3f(0.008, 0.009, 0.024);
    if (pane_lit && pane.x > 0.24 && pane.x < 0.55 && pane.y > 0.26 && pane.y < 0.49) {
      col += amber * (0.3 + 0.9 * hit);
    }
  }

  // The media is sampled on both sides of the waterline through the same screen geometry.
  let sign_center = vec2f(-0.15, -0.31);
  let sign_half = vec2f(0.397, 0.218);
  let sign = q - sign_center;
  let frame = box(sign, sign_half + vec2f(0.018, 0.032));
  let face = box(sign, sign_half);
  col += exp(-max(frame, 0.0) * 43.0) * mix(0.28 * violet, 0.55 * aqua, energy);
  if (q.y > -0.10 && abs(abs(sign.x) - 0.30) < 0.013) {
    col = vec3f(0.023, 0.024, 0.063);
  }
  if (frame < aa) {
    col = mix(col, vec3f(0.023, 0.012, 0.049), 1.0 - smoothstep(-aa, aa, frame));
    col += mix(aqua, amber, energy) * (0.72 + hit) * (1.0 - smoothstep(0.0018, 0.0018 + aa, abs(frame + 0.004)));
    if (face < aa) {
      let image_uv = sign / (2.0 * sign_half) + 0.5;
      let image = tex_picture(image_uv).rgb;
      let lum = dot(image, vec3f(0.2126, 0.7152, 0.0722));
      let tint = mix(vec3f(0.23, 0.66, 1.00), vec3f(1.00, 0.57, 0.13), energy);
      let pixel_row = 0.88 + 0.12 * cos(image_uv.y * 640.0);
      let panel = (image * 0.75 + lum * tint * 0.6 + tint * 0.035) * pixel_row * (0.82 + energy * 1.4);
      col = mix(col, panel, 1.0 - smoothstep(-aa, aa, face));
    }
    if (sign.y > sign_half.y + 0.006 && sign.y < sign_half.y + 0.019) {
      let segments = (sign.x / (2.0 * sign_half.x) + 0.5) * 16.0;
      let strength = band(i32(floor(segments)));
      col += mix(aqua, amber, segments / 16.0) * (0.15 + 1.9 * strength)
        * smoothstep(0.1, 0.2, fract(segments)) * (1.0 - smoothstep(0.78, 0.88, fract(segments)));
    }
  }

  if (water) {
    let waves = pow(0.5 + 0.5 * sin(depth * 185.0 - t * 4.7 + sin(p.x * 6.0 + depth * 24.0)), 4.0);
    col = col * exp(-depth * 4.0) * (0.51 + 0.25 * waves)
      + vec3f(0.013, 0.014, 0.041) + waves * vec3f(0.029, 0.038, 0.074) * (0.45 + energy);
  }
  col += exp(-abs(p.y) * 410.0) * mix(violet, amber, energy) * 0.32;
  return vec4f(col, 1.0);
}
