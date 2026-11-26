// Analytic AA for a line every whole unit: u is the coordinate, w its change per pixel.
fn grid_line(u: f32, w: f32) -> f32 {
  let d = abs(fract(u + 0.5) - 0.5);
  let ww = max(w, 1e-5);
  let core = clamp(1.0 - d / (ww * 1.3), 0.0, 1.0);
  let halo = exp(-d / (ww * 5.0 + 0.015)) * 0.35;
  let fade = 1.0 - smoothstep(0.08, 0.45, ww);
  return (core + halo) * fade + 0.12 * (1.0 - fade);
}

fn shade(uv: vec2f) -> vec4f {
  let hz = p_horizon();
  let a = aspect();
  let px = 1.0 / resolution().y;
  let yv = max(uv.y - hz, 0.5 * px);
  let cover = clamp((uv.y - hz) / px + 0.5, 0.0, 1.0);
  let cell = p_cell();
  let H = p_height() * cell;
  let z = H / yv;
  let sway = p_curve() * sin(time() * 0.23 + 1.3 * sin(time() * 0.07));
  let wx = (uv.x - 0.5) * a * z - sway * z * z * 0.02;
  let gz = z / cell + p_beats() * p_speed();
  let gx = wx / cell;
  let wz = H / (yv * yv) * px / cell;
  let wxp = z * px / cell;
  let mode = i32(p_mode());
  let lc = palette(p_tint());
  let energy = p_glow() * (1.0 + p_pulse() * bass());
  // a light pulse sliding from the horizon to the camera over each beat
  let zw = mix(24.0, 0.6, phase());
  let wave = 1.0 + p_wave() * exp(-abs(z / cell - zw) * 0.9) * (0.4 + bass());

  var col = palette(0.05) * 0.06;
  if (mode == 1) {
    // checkerboard, AA'd by fading to the mean when tiles get small
    let ck = abs((floor(gx) + floor(gz)) % 2.0);
    let fade = 1.0 - smoothstep(0.15, 0.6, max(wxp, wz));
    let light = mix(0.5, ck, fade);
    col = mix(palette(0.08) * 0.25, lc * 0.9, light) * (0.7 + 0.3 * energy / max(p_glow(), 0.01)) * wave;
    let edge = max(grid_line(gx, wxp), grid_line(gz, wz)) * 0.25;
    col += lc * edge * energy * 0.3;
  } else {
    let lines = max(grid_line(gx, wxp), grid_line(gz, wz));
    col += lc * lines * energy * wave;
    if (mode == 2) {
      let rd = abs(gx);
      let rw = p_road();
      let inroad = clamp((rw - rd) / wxp, 0.0, 1.0);
      let edgel = exp(-abs(rd - rw) / (wxp * 2.0 + 0.02)) * 1.6;
      let dash = step(fract(gz * 0.5), 0.5) * clamp(1.0 - rd / (0.06 + wxp), 0.0, 1.0);
      let road = palette(0.1) * 0.08 + palette(0.95) * dash * energy * 0.8;
      col = mix(col, road, inroad) + palette(p_tint()) * edgel * energy * wave * 0.7;
    }
  }
  // wet-floor mirror of the sky
  let ry = clamp(2.0 * hz - uv.y, 0.0, hz);
  let rip = sin(z * 2.5 - time() * 3.0) * 0.004 * (1.0 + bass());
  let refl = tex_sky(vec2f(clamp(uv.x + rip, 0.0, 1.0), ry)).rgb;
  col += refl * p_reflect() * 0.45 * exp(-z * 0.03);
  // haze toward the horizon
  let fogk = exp(-z * p_fog());
  col = mix(palette(0.62) * 0.35, col, fogk);
  col += palette(0.62) * exp(-(uv.y - hz) * 40.0) * 0.5;
  return vec4f(max(col, vec3f(0.0)) * cover, cover);
}
