fn rot2(v: vec2f, a: f32) -> vec2f {
  let c = cos(a);
  let s = sin(a);
  return vec2f(v.x * c - v.y * s, v.x * s + v.y * c);
}

fn dot_screen(px: vec2f, cell: f32, deg: f32, density: f32, sharp: f32) -> f32 {
  let a = deg * 0.017453293;
  let r = rot2(px, a) / cell;
  let local = fract(r) - 0.5;
  let dist = length(local);
  // Radius 0..0.72 covers the cell smoothly at full density
  let radius = sqrt(clamp(density, 0.0, 1.0)) * 0.72;
  let aa = mix(0.22, 0.035, sharp) + (1.0 / max(cell, 2.0));
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
  return p / (vec3f(0.65) + p);
}

fn shade(uv: vec2f) -> vec4f {
  let res = resolution();
  let src = tex_in(uv).rgb;
  let scale = res.y / 1080.0;
  let cell = max(2.5, p_cell() * (1.0 + p_bass() * bass()) * scale);
  let px = uv * res;
  let base_deg = p_angle();
  let con = p_contrast();
  let sharp = p_sharpness();
  let paper = p_paper();

  var out_col: vec3f;

  if (p_mode() < 0.5) {
    // CMYK offset print: four angled screens sampled at each plate's cell center
    let deg_c = base_deg + 15.0;
    let deg_m = base_deg + 75.0;
    let deg_y = base_deg + 0.0;
    let deg_k = base_deg + 45.0;

    let rgb_c = tonemap_01(tex_in(sample_cell_uv(px, cell, deg_c, res)).rgb);
    let rgb_m = tonemap_01(tex_in(sample_cell_uv(px, cell, deg_m, res)).rgb);
    let rgb_y = tonemap_01(tex_in(sample_cell_uv(px, cell, deg_y, res)).rgb);
    let rgb_k = tonemap_01(tex_in(sample_cell_uv(px, cell, deg_k, res)).rgb);

    // Subtractive CMYK separation with under-color removal
    let kc = 1.0 - max(rgb_c.r, max(rgb_c.g, rgb_c.b));
    let km = 1.0 - max(rgb_m.r, max(rgb_m.g, rgb_m.b));
    let ky = 1.0 - max(rgb_y.r, max(rgb_y.g, rgb_y.b));
    let kk = 1.0 - max(rgb_k.r, max(rgb_k.g, rgb_k.b));

    let c_val = clamp(((1.0 - rgb_c.r - kc) / max(1.0 - kc, 0.05)) * con, 0.0, 1.0);
    let m_val = clamp(((1.0 - rgb_m.g - km) / max(1.0 - km, 0.05)) * con, 0.0, 1.0);
    let y_val = clamp(((1.0 - rgb_y.b - ky) / max(1.0 - ky, 0.05)) * con, 0.0, 1.0);
    let k_val = clamp(pow(kk, 1.0 / max(con, 0.1)), 0.0, 1.0);

    let dc = dot_screen(px, cell, deg_c, c_val, sharp);
    let dm = dot_screen(px, cell, deg_m, m_val, sharp);
    let dy = dot_screen(px, cell, deg_y, y_val, sharp);
    let dk = dot_screen(px, cell, deg_k, k_val, sharp);

    // Rich print inks in linear RGB multiplied onto warm stock
    let ink_c = vec3f(0.06, 0.72, 0.92);
    let ink_m = vec3f(0.88, 0.06, 0.48);
    let ink_y = vec3f(0.98, 0.84, 0.05);
    let ink_k = vec3f(0.03, 0.03, 0.045);

    var col = paper;
    col *= mix(vec3f(1.0), ink_c, dc * 0.92);
    col *= mix(vec3f(1.0), ink_m, dm * 0.92);
    col *= mix(vec3f(1.0), ink_y, dy * 0.90);
    col = mix(col, ink_k, dk * 0.95);
    out_col = col;
  } else {
    // Single-ink dot screen: dot radius driven by luma at the cell center
    let c_uv = sample_cell_uv(px, cell, base_deg, res);
    let c_rgb = tonemap_01(tex_in(c_uv).rgb);
    let luma = dot(c_rgb, vec3f(0.2126, 0.7152, 0.0722));
    let density = clamp(luma * con, 0.0, 1.0);
    let d = dot_screen(px, cell, base_deg, density, sharp);
    let tint = mix(p_ink(), c_rgb * 1.15, 0.45);
    out_col = mix(paper, tint, d);
  }

  return vec4f(mix(src, out_col, p_mix()), 1.0);
}
