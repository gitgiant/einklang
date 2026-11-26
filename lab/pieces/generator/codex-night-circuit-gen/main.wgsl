fn blockHash(x: f32) -> f32 {
  return fract(fract(x * 0.1031) * fract(x * 0.3917) * 123.53);
}

fn shade(uv: vec2f) -> vec4f {
  let p = (floor((uv - 0.5) * vec2f(aspect(), 1.0) * 270.0) + 0.5) / 270.0;
  let t = time();
  let surge = mix(p_surge(), bass(), 0.45);
  let pulse = pow(1.0 - phase(), 3.0);
  let horizon = -0.065 - 0.046 * surge + 0.009 * sin(t * 1.9);
  let shift = sin(t * 0.71);
  let y = p.y - horizon;
  let night = palette(0.0);
  let plum = palette(1.0 / 6.0);
  let violet = palette(2.0 / 6.0);
  let pink = palette(0.5);
  let cyan = palette(4.0 / 6.0);

  if (y < 0.0) {
    let dusk = 1.0 - smoothstep(0.015, 0.42, -y);
    var sky = mix(night, mix(plum, violet * 0.75, dusk), dusk);
    let stars = floor(p * 31.0);
    let h = blockHash(stars.x * 3.7 + stars.y * 37.8);
    let spark = 1.0 - step(0.092, length(fract(p * 31.0) - vec2f(h, fract(h * 17.0))));
    sky += cyan * spark * step(0.78, h) * (0.22 + 0.35 * band(12));

    let sun = vec2f(p.x + 0.23 + 0.047 * shift, y + 0.147);
    let sunMask = 1.0 - step(0.151, length(sun));
    let gaps = step(0.22 + 0.34 * smoothstep(-0.02, 0.13, sun.y), fract(sun.y * 69.0));
    let light = mix(palette(1.0), pink, smoothstep(-0.13, 0.13, sun.y));
    sky = mix(sky, light * (0.82 + 0.12 * pulse), sunMask * max(gaps, step(sun.y, -0.02)));

    // Two silhouettes scroll at different rates against the sun.
    let farX = p.x * 4.6 + 0.26 * shift + t * 0.19;
    let ridge = mix(blockHash(floor(farX)), blockHash(floor(farX) + 1.0), fract(farX));
    sky = mix(sky, plum * 0.73, step(-0.023 - 0.091 * ridge, y));
    let cityX = p.x * 23.0 + 0.65 * shift + t * 0.61;
    let height = 0.016 + blockHash(floor(cityX) + 0.35) * 0.065;
    let building = step(-height, y) * step(0.13, fract(cityX)) * step(fract(cityX), 0.91);
    let window = step(0.58, fract(cityX * 3.0)) * step(0.70, fract(y * 120.0))
      * step(0.4, blockHash(floor(cityX) + floor(y * 120.0) * 7.1));
    sky = mix(sky, night + cyan * window * 0.23, building);
    return vec4f(sky, 1.0);
  }

  // Sample a moving ground plane. The horizon floor keeps coordinates finite.
  let depth = 0.72 / max(y, 0.009);
  let z = depth + t * 9.1;
  let x = (p.x - 0.19 * shift * y - 0.055 * sin(z * 0.26) * y) * depth;
  let road = 1.0 - step(0.63, abs(x));
  let dash = step(0.43, fract(z / 2.45));
  let lane = (1.0 - step(0.017, abs(x))) * dash;
  let curb = 1.0 - step(0.043, abs(abs(x) - 0.63));
  let shoulder = 1.0 - step(0.035, abs(abs(x) - 0.86));
  let tile = fract((floor(x * 2.0) + floor(z * 0.8)) * 0.5) * 2.0;
  let asphalt = mix(plum * 0.55, plum * 0.86, tile);
  let ground = mix(violet * 0.21, violet * 0.49, tile);
  var color = mix(ground, asphalt, road);
  color += violet * shoulder * (0.45 + 0.38 * dash);
  color = mix(color, mix(pink, cyan, dash) * (0.65 + 0.38 * surge), curb);
  color += cyan * lane * (0.50 + 0.55 * surge + 0.22 * pulse);

  // Pixel stipple and distance fog keep the projected checks stable at the horizon.
  let dither = fract(floor(p.x * 270.0) * 0.5 + floor(p.y * 270.0) * 0.5) * 2.0;
  let fog = smoothstep(0.027, 0.23, y);
  color = mix(violet * (0.21 + 0.07 * dither), color, fog);
  color += pink * (1.0 - step(0.004, y)) * 0.66;
  return vec4f(color, 1.0);
}
