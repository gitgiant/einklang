// Analytic plane projection, with filter widths evaluated before the sign split at the horizon.
fn grid_rail(coord: f32, footprint: f32, width: f32) -> f32 {
  let dist = abs(fract(coord + 0.5) - 0.5);
  let edge = min(footprint, 0.45);
  return (1.0 - smoothstep(width * edge, (width + 1.0) * edge, dist))
    * (1.0 - smoothstep(0.28, 0.78, footprint));
}

fn shade(uv: vec2f) -> vec4f {
  let x = (uv.x - 0.5) * aspect();
  let y = uv.y - p_horizon();
  let pixel = 1.0 / resolution().y;
  let pulse = max(onset(), 0.52 * exp(-phase() * 7.0) * smoothstep(0.01, 0.24, bass()));
  let night = palette(0.0);
  let dusk = palette(0.25);
  let neon = palette(0.5);
  let amber = palette(0.75);
  let gold = palette(1.0);

  // Tempo gives a constant forward rate; the sinusoid adds a seamless push on each beat.
  let beats = time() * max(bpm(), 55.0) / 60.0;
  let travel = p_pace() * (beats + 0.085 * sin(6.2831853 * phase()));
  let z = 0.55 / max(y, 0.012);
  let column = x * z * 3.3;
  let row = z * 2.9 + travel;
  let width = 0.35 + pulse * 0.57;
  let rails = max(grid_rail(column, fwidth(column), width),
                  grid_rail(row, fwidth(row), width));

  let haze = exp(-abs(y) * 10.5 - x * x * 2.2);
  let skyline = exp(-abs(y) * 150.0) * exp(-x * x * 2.9);
  var color = night * vec3f(0.54, 0.43, 0.76) + dusk * (0.13 + 0.79 * haze);
  if (y < 0.0) {
    let sun = vec2f(x, y + 0.158);
    let disc = 1.0 - smoothstep(0.143 - pixel, 0.143 + pixel, length(sun));
    let solarHeight = clamp((sun.y + 0.143) / 0.286, 0.0, 1.0);
    let bands = sun.y * 43.0 + sun.y * sun.y * 66.0;
    let gaps = smoothstep(0.52, 0.52 + pixel * 36.0, fract(bands));
    let cut = mix(1.0, gaps, smoothstep(0.39, 0.77, solarHeight));
    let glare = exp(-dot(sun, sun) * 27.0);
    color += amber * glare * (0.26 + 0.12 * pulse);
    color = mix(color, mix(gold, neon, solarHeight) * (1.27 + 0.16 * pulse), disc * cut);
  } else {
    let fade = smoothstep(0.012, 0.115, y);
    let tile = mix(0.7, 1.0, smoothstep(0.0, 0.5, abs(x)));
    color = night * 0.58 + dusk * haze * 0.54 + neon * fade * 0.018;
    color += mix(neon, amber, haze * 0.37) * rails * fade * tile
      * (0.72 + 1.33 * pulse) * p_glow();
  }
  color += mix(neon, amber, 0.52) * skyline * p_glow() * (0.57 + 0.46 * pulse);
  return vec4f(color, 1.0);
}
