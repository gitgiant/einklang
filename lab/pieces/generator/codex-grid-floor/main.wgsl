// Analytic plane projection, with filter widths evaluated before the sign split at the horizon.
fn grid_rail(coord: f32, footprint: f32, width: f32) -> f32 {
  let dist = abs(fract(coord + 0.5) - 0.5);
  let edge = min(footprint, 0.45);
  return (1.0 - smoothstep(width * edge, (width + 1.0) * edge, dist))
    * (1.0 - smoothstep(0.28, 0.78, footprint));
}

fn shade(uv: vec2f) -> vec4f {
  let x = (uv.x - 0.5) * aspect();
  let pixel = 1.0 / resolution().y;
  let kick = smoothstep(0.10, 0.78, bass());
  let pressure = smoothstep(0.13, 0.56, (band(4) + band(6) + band(8)) / 3.0);
  let drive = smoothstep(0.22, 0.68, rms());
  let beat = phase();
  let pulse = max(onset(), kick * exp(-beat * 3.8));
  let y = uv.y - p_horizon() - (0.038 * kick + 0.026 * pulse);
  let night = palette(0.0);
  let dusk = palette(0.25);
  let neon = palette(0.5);
  let amber = palette(0.75);
  let gold = palette(1.0);

  // Advance more of each beat's travel in its attack, with no position jump at the seam.
  let beats = time() * max(bpm(), 55.0) / 60.0;
  let surge = (1.0 - exp(-4.0 * beat)) / (1.0 - exp(-4.0)) - beat;
  let travel = p_pace() * (beats + (0.08 + 0.71 * kick) * surge);
  let z = 0.55 / max(y, 0.012);
  let column = x * z * 3.3;
  let row = z * 2.9 + travel;
  let width = 0.35 + 2.6 * pulse + 0.85 * kick;
  let rails = max(grid_rail(column, fwidth(column), width),
                  grid_rail(row, fwidth(row), width));

  let haze = exp(-abs(y) * (10.5 - 6.8 * drive) - x * x * (2.2 - 1.35 * pressure));
  let skyline = exp(-abs(y) * (150.0 - 110.0 * pulse)) * exp(-x * x * 2.9);
  var color = night * vec3f(0.54, 0.43, 0.76) + dusk * (0.13 + 0.79 * haze);
  if (y < 0.0) {
    color += mix(dusk, neon, 0.37) * haze * min(rms(), 0.24) * 0.43;
    let sunRadius = 0.135 + 0.057 * kick + 0.036 * pulse;
    let sun = vec2f(x, y + sunRadius + 0.019);
    let dist = length(sun);
    let disc = 1.0 - smoothstep(sunRadius - pixel, sunRadius + pixel, dist);
    let solarY = sun.y * 0.135 / sunRadius;
    let solarHeight = clamp((solarY + 0.135) / 0.27, 0.0, 1.0);
    let bands = solarY * 43.0 + solarY * solarY * 66.0;
    let gaps = smoothstep(0.52, 0.52 + pixel * 36.0, fract(bands));
    let cut = mix(1.0, gaps, smoothstep(0.39, 0.77, solarHeight));
    let glare = exp(-dot(sun, sun) * (24.0 - 16.0 * drive));
    let flareRadius = sunRadius + beat * (0.30 + 0.24 * kick);
    let flare = exp(-abs(dist - flareRadius) * 45.0) * pulse;
    color += mix(neon, amber, pressure) * glare * (0.12 + 0.47 * kick + 0.36 * drive);
    color += mix(neon, gold, 0.4) * flare * 0.35;
    color = mix(color, mix(gold, neon, solarHeight) * (1.27 + 0.16 * pulse), disc * cut);
  } else {
    let fade = smoothstep(0.012, 0.115, y);
    let tile = mix(0.7, 1.0, smoothstep(0.0, 0.5, abs(x)));
    // Broad reflections carry the moving beat down the road between the fine wires.
    let reflection = exp(-x * x * 3.1 / (0.57 + y * 2.3)) * exp(-y * 2.9);
    let echo = exp(-abs(fract(row * 0.19 + 0.5) - 0.5) * 8.0);
    color = night * 0.58 + dusk * haze * 0.54 + neon * fade * 0.018;
    color += mix(neon, amber, 0.34 + 0.37 * pressure) * reflection * fade
      * (0.44 * kick + 0.43 * drive * echo + 0.30 * pulse);
    color += mix(neon, amber, haze * 0.37) * rails * fade * tile
      * (0.72 + 1.33 * pulse) * p_glow();
  }
  color += mix(neon, amber, 0.52) * skyline * p_glow() * (0.57 + 1.1 * pulse);
  return vec4f(color, 1.0);
}
