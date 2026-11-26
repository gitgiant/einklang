fn shade(uv: vec2f) -> vec4f {
  let cols = max(p_cols(), 16.0);
  let rows = max(round(cols / max(aspect(), 0.25)), 8.0);
  let grid = vec2f(cols, rows);

  let cell = floor(uv * grid);
  let center_uv = (cell + 0.5) / grid;
  let local = fract(uv * grid) - 0.5;
  let inv = 0.25 / grid;

  // 4-tap box sample of input texture inside the LED cell for clean anti-aliased diodes
  let src = (
    tex_in(center_uv + vec2f(-inv.x, -inv.y)).rgb +
    tex_in(center_uv + vec2f( inv.x, -inv.y)).rgb +
    tex_in(center_uv + vec2f(-inv.x,  inv.y)).rgb +
    tex_in(center_uv + vec2f( inv.x,  inv.y)).rgb
  ) * 0.25;

  // 16-band LED matrix VU spectrum columns (grouped cleanly across the LED grid)
  let band_f = center_uv.x * 16.0;
  let b_idx = clamp(i32(floor(band_f)), 0, 15);
  let b_cell = fract(band_f);
  // Crisp thin separator between adjacent spectrum band clusters
  let band_sep = step(0.08, b_cell) * step(b_cell, 0.92);
  let row_y = 1.0 - (cell.y + 0.5) / rows; // 0 at bottom, 1 at top
  let b_lvl = band(b_idx) * 0.92;
  let lit_bar = step(row_y, b_lvl) * band_sep;
  let crest = exp(-abs(row_y - b_lvl) * rows * 0.9) * step(0.02, b_lvl) * band_sep;

  let spec_pal = palette(fract(f32(b_idx) / 16.0 * 0.72 + row_y * 0.28 + time() * 0.02));
  let spec_col = spec_pal * (lit_bar * (0.45 + 0.65 * row_y) + crest * 1.15) * p_spec_mix();

  let fresh = src + spec_col;

  // Cell-locked falling peak-hold & LED persistence (center gain == 1.0 so decay < 0.92 is strictly bounded)
  let prev_c = min(prev(center_uv).rgb, vec3f(3.0)) * (p_decay() * 0.93);
  let energy = max(fresh, prev_c);

  // Physical domed LED geometry
  let r = length(local) * 2.0;
  let dot_r = p_dot();
  let lens = smoothstep(dot_r + 0.06, dot_r - 0.14, r);
  let core = exp(-r * r * 4.5);
  // At r == 0, (0.65 + 0.35 * core) == 1.0 exactly, keeping feedback gain strictly bounded!
  let diode_profile = (0.65 + 0.35 * core) * lens;

  // Subtle glass dome highlight offset from center so it never feeds back at r == 0
  let spec_hl = exp(-dot(local - vec2f(-0.14, -0.14), local - vec2f(-0.14, -0.14)) * 95.0) * lens * 0.16;
  // Soft diode-to-bezel bleed halo outside the lens
  let halo = exp(-r * r * 2.2) * (1.0 - lens) * p_bloom() * 0.28;

  // Dark matte PCB + subtle unlit LED dome housing
  let pcb = vec3f(0.004, 0.005, 0.007) + vec3f(0.02, 0.024, 0.032) * p_bezel() * lens;
  let lit = energy * (diode_profile + halo) + vec3f(spec_hl) * clamp(dot(energy, vec3f(0.333)), 0.0, 1.2);

  return vec4f(max(pcb + lit, vec3f(0.0)), 1.0);
}
