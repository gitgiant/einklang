fn rot2(v: vec2f, a: f32) -> vec2f {
  let c = cos(a);
  let s = sin(a);
  return vec2f(v.x * c - v.y * s, v.x * s + v.y * c);
}

fn dot_screen(px: vec2f, cell: f32, deg: f32, density: f32, sharp: f32, punch: f32) -> f32 {
  let a = deg * 0.017453293;
  let r = rot2(px, a) / cell;
  let local = fract(r) - 0.5;
  let dist = length(local);
  // Crisp circular dots; onsets punch radius slightly larger for tactile ink gain
  let radius = sqrt(clamp(density, 0.0, 1.0)) * (0.68 + punch * 0.14);
  let aa = mix(0.18, 0.025, sharp) + (0.85 / max(cell, 3.0));
  return 1.0 - smoothstep(radius - aa, radius + aa, dist);
}

fn sample_cell_uv(px: vec2f, cell: f32, deg: f32, res: vec2f) -> vec2f {
  let a = deg * 0.017453293;
  let grid = (floor(rot2(px, a) / cell) + 0.5) * cell;
  let center = rot2(grid, -a);
  return clamp(center / res, vec2f(0.001), vec2f(0.999));
}

fn tonemap_01(c: vec3f) -> vec3f {
  let p = max(c, vec3f(0.0));
  return p / (vec3f(0.55) + p);
}

fn shade(uv: vec2f) -> vec4f {
  let res = resolution();
  let src = tex_in(uv).rgb;
  let scale = res.y / 1080.0;

  // Audio drivers: bass breathes the screen pitch, onsets + beat kicks punch dots and plates
  let b = bass();
  let r = rms();
  let hi = (band(10) + band(11) + band(12) + band(13)) * 0.25;
  let hit = onset();
  let beat_kick = pow(max(0.0, 1.0 - phase() * 2.5), 2.0) * smoothstep(0.12, 0.45, b);
  let punch = clamp(hit * 1.0 + beat_kick * 0.85, 0.0, 1.5);
  let energy = clamp(b * 0.70 + r * 0.55 + hi * 0.35, 0.0, 1.5);

  // Cell size breathes visibly with bass and kicks
  let cell_mod = max(0.35, 1.0 + p_bass() * (b * 1.45 + punch * 0.55));
  let cell = max(3.5, p_cell() * cell_mod * scale);

  let px = uv * res;
  let base_deg = p_angle() + punch * 12.0;
  let con = p_contrast() * (0.88 + b * 0.42 + punch * 0.45);
  let sharp = p_sharpness();

  // Dynamic press lighting: calm vintage stock on quiet, vivid illuminated stock on dense hits
  let paper_stock = p_paper() * (0.46 + energy * 0.62 + punch * 0.42);
  let input_lift = 0.78 + energy * 0.95 + punch * 0.55;

  var out_col: vec3f;

  if (p_mode() < 0.5) {
    // CMYK offset print: four angled screens with audio-driven plate misregistration
    let deg_c = base_deg + 15.0;
    let deg_m = base_deg + 75.0;
    let deg_y = base_deg + 0.0;
    let deg_k = base_deg + 45.0;

    // Vibrating press registration shift on bass & onsets
    let reg = (b * 0.20 + punch * 0.40) * cell;
    let px_c = px + vec2f(reg, -reg * 0.55);
    let px_m = px + vec2f(-reg * 0.85, reg * 0.65);
    let px_y = px + vec2f(reg * 0.25, reg * 0.95);
    let px_k = px;

    let rgb_c = tonemap_01(tex_in(sample_cell_uv(px_c, cell, deg_c, res)).rgb * input_lift);
    let rgb_m = tonemap_01(tex_in(sample_cell_uv(px_m, cell, deg_m, res)).rgb * input_lift);
    let rgb_y = tonemap_01(tex_in(sample_cell_uv(px_y, cell, deg_y, res)).rgb * input_lift);
    let rgb_k = tonemap_01(tex_in(sample_cell_uv(px_k, cell, deg_k, res)).rgb * input_lift);

    // Subtractive CMYK separation with moderated black key so C/M/Y dots stay vivid
    let kc = 1.0 - max(rgb_c.r, max(rgb_c.g, rgb_c.b));
    let km = 1.0 - max(rgb_m.r, max(rgb_m.g, rgb_m.b));
    let ky = 1.0 - max(rgb_y.r, max(rgb_y.g, rgb_y.b));
    let kk = 1.0 - max(rgb_k.r, max(rgb_k.g, rgb_k.b));

    let c_val = clamp(((1.0 - rgb_c.r - kc * 0.7) / max(1.0 - kc * 0.7, 0.08)) * con, 0.0, 1.0);
    let m_val = clamp(((1.0 - rgb_m.g - km * 0.7) / max(1.0 - km * 0.7, 0.08)) * con, 0.0, 1.0);
    let y_val = clamp(((1.0 - rgb_y.b - ky * 0.7) / max(1.0 - ky * 0.7, 0.08)) * con, 0.0, 1.0);
    let k_val = clamp(pow(kk, 1.35 / max(con, 0.15)) * 0.82, 0.0, 0.94);

    let dc = dot_screen(px_c, cell, deg_c, c_val, sharp, punch);
    let dm = dot_screen(px_m, cell, deg_m, m_val, sharp, punch);
    let dy = dot_screen(px_y, cell, deg_y, y_val, sharp, punch);
    let dk = dot_screen(px_k, cell, deg_k, k_val, sharp, punch);

    // Rich print inks in linear RGB multiplied onto warm stock
    let ink_c = vec3f(0.03, 0.74, 0.95);
    let ink_m = vec3f(0.92, 0.04, 0.50);
    let ink_y = vec3f(0.99, 0.86, 0.03);
    let ink_k = vec3f(0.025, 0.025, 0.04);

    var col = paper_stock;
    col *= mix(vec3f(1.0), ink_c, dc * 0.94);
    col *= mix(vec3f(1.0), ink_m, dm * 0.94);
    col *= mix(vec3f(1.0), ink_y, dy * 0.92);
    col = mix(col, ink_k, dk * 0.92);
    out_col = col;
  } else {
    // Single-ink dot screen: dot radius driven by luma at the cell center + onset punch
    let c_uv = sample_cell_uv(px, cell, base_deg, res);
    let c_rgb = tonemap_01(tex_in(c_uv).rgb * input_lift);
    let luma = dot(c_rgb, vec3f(0.2126, 0.7152, 0.0722));
    let density = clamp(luma * con, 0.0, 1.0);
    let d = dot_screen(px, cell, base_deg, density, sharp, punch);
    let tint = mix(p_ink(), c_rgb * (1.1 + punch * 0.45), 0.48);
    out_col = mix(paper_stock, tint, d);
  }

  return vec4f(mix(src, out_col, p_mix()), 1.0);
}
