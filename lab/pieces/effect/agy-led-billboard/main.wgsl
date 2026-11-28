// Stadium LED billboard wall: discrete RGB diode lamps grouped into modular cabinets,
// rolling refresh scan waves, onset-dropped/rebooting modules, and lit steel gantry trusses.

fn hash_u32(x: u32) -> u32 {
  var v = x * 747796405u + 2891336453u;
  v = ((v >> ((v >> 28u) + 4u)) ^ v) * 277803737u;
  return (v >> 22u) ^ v;
}

fn hash2(a: u32, b: u32) -> f32 {
  return f32(hash_u32(a ^ hash_u32(b * 374761393u + 668265263u)) & 0xFFFFu) / 65536.0;
}

fn soft_clip(c: vec3f) -> vec3f {
  let m = max(c, vec3f(0.0));
  return m / (vec3f(1.0) + m * 0.28);
}

fn shade(uv: vec2f) -> vec4f {
  let t = time();
  let b = bass();
  let on = onset();
  let r = rms();
  let ph = phase();
  let asp = max(aspect(), 0.5);

  let beat_kick = pow(max(0.0, 1.0 - ph * 2.8), 2.0) * (0.25 + 0.75 * b);
  let energy = clamp(on * 1.15 + beat_kick * 0.9 + r * 0.5, 0.0, 1.8);

  // Subtle camera breath and bass punch
  let punch = 1.0 + b * 0.025 + on * 0.02;
  let sway = vec2f(sin(t * 0.45) * 0.004, cos(t * 0.37) * 0.003);
  let cuv = (uv - 0.5) / punch + 0.5 + sway;

  // Map into stadium billboard bounds
  let margin_y = p_frame();
  let margin_x = margin_y * 0.72;
  let bmin = vec2f(margin_x, margin_y);
  let bmax = vec2f(1.0 - margin_x, 1.0 - margin_y);
  let bsize = max(bmax - bmin, vec2f(0.2));
  let buv = (cuv - bmin) / bsize;

  // Quick 4-tap ambient billboard spill color for the stadium gantry
  let sp0 = tex_in(vec2f(0.25, 0.3)).rgb;
  let sp1 = tex_in(vec2f(0.75, 0.3)).rgb;
  let sp2 = tex_in(vec2f(0.25, 0.7)).rgb;
  let sp3 = tex_in(vec2f(0.75, 0.7)).rgb;
  let avg_media = max((sp0 + sp1 + sp2 + sp3) * 0.25, vec3f(0.03, 0.04, 0.08));
  let spill_col = mix(avg_media, palette(0.55) * (0.4 + r * 0.8), 0.32) * (0.75 + b * 0.9 + on * 0.65);

  // --- OUTSIDE BILLBOARD: STADIUM STEEL GANTRY & FLOODLIGHTS ---
  if (buv.x < 0.0 || buv.x > 1.0 || buv.y < 0.0 || buv.y > 1.0) {
    let clamped_b = clamp(buv, vec2f(0.0), vec2f(1.0));
    let edge_d = length((buv - clamped_b) * vec2f(asp, 1.0));

    // Night arena backdrop + volumetric billboard glow halo
    var bg = vec3f(0.014, 0.018, 0.028) + spill_col * exp(-edge_d * 10.5) * 0.65;

    // Steel cross-braced truss lattice along frame borders
    let tp = vec2f(cuv.x * asp, cuv.y) * 26.0;
    let tf = fract(tp) - 0.5;
    let diag_a = abs(tf.x + tf.y);
    let diag_b = abs(tf.x - tf.y);
    let strut = 1.0 - smoothstep(0.06, 0.12, min(min(diag_a, diag_b), min(abs(tf.x), abs(tf.y))));
    let truss_shade = (0.045 + 0.14 * exp(-edge_d * 14.0)) * (vec3f(0.65, 0.72, 0.85) + spill_col * 0.9);
    bg = mix(bg, truss_shade, strut * 0.78);

    // Metallic billboard bezel rim
    if (edge_d < 0.018) {
      let bevel = smoothstep(0.018, 0.002, edge_d);
      bg = mix(bg, vec3f(0.08, 0.09, 0.11) + spill_col * 0.42, bevel);
    }

    // Top & bottom gantry 16-band LED indicator lamps
    let near_top = buv.y < 0.0 && buv.y > -0.045 && buv.x > 0.04 && buv.x < 0.96;
    let near_bot = buv.y > 1.0 && buv.y < 1.045 && buv.x > 0.04 && buv.x < 0.96;
    if (near_top || near_bot) {
      let lx = buv.x * 32.0;
      let li = i32(floor(lx)) % 16;
      let lf = fract(lx) - 0.5;
      let ly = select(buv.y - 1.022, buv.y + 0.022, near_top) * 22.0;
      let lamp_d = length(vec2f(lf, ly));
      let bv = band(li);
      let lamp_col = palette(f32(li) / 15.0) * (0.25 + bv * 1.65 + on * 0.5);
      bg += lamp_col * exp(-lamp_d * lamp_d * 18.0);
    }

    return vec4f(soft_clip(bg), 1.0);
  }

  // --- INSIDE BILLBOARD: MODULAR LED CABINETS ---
  let cab_cols = max(4.0, floor(p_cabinets()));
  let cab_rows = max(3.0, floor(cab_cols / max(asp * 0.95, 0.5)));
  let cab_grid = vec2f(cab_cols, cab_rows);
  let cab_pos = buv * cab_grid;
  let cab_f = floor(cab_pos);
  let cab_id = vec2u(u32(max(0.0, cab_f.x)), u32(max(0.0, cab_f.y)));
  let cab_uv = fract(cab_pos);
  let cab_seed = cab_id.x * 197u + cab_id.y * 541u;

  // Snap LED diode resolution cleanly to an integer multiple of cabinets so seams fall between LEDs
  let diodes_per_cab_y = max(6.0, floor(p_rows() / cab_rows + 0.5));
  let diodes_per_cab_x = max(6.0, floor(diodes_per_cab_y * (asp * cab_rows / cab_cols) + 0.5));
  let diode_grid = vec2f(cab_cols * diodes_per_cab_x, cab_rows * diodes_per_cab_y);
  let diode_pos = buv * diode_grid;
  let diode_f = floor(diode_pos);
  let diode_local = fract(diode_pos);
  let cell_uv = clamp((diode_f + 0.5) / diode_grid, vec2f(0.001), vec2f(0.999));

  // Subtle per-cabinet hardware calibration variance (realistic stadium panel look)
  let cab_gain = 0.94 + hash2(cab_seed, 17u) * 0.12;
  let cab_tint = vec3f(
    0.97 + hash2(cab_seed, 23u) * 0.06,
    0.98 + hash2(cab_seed, 31u) * 0.04,
    0.97 + hash2(cab_seed, 43u) * 0.06
  );

  // Hairline dark physical seam between LED cabinets
  let seam_x = smoothstep(0.0, 0.018, min(cab_uv.x, 1.0 - cab_uv.x));
  let seam_y = smoothstep(0.0, 0.022, min(cab_uv.y, 1.0 - cab_uv.y));
  let cab_seam = seam_x * seam_y;

  // --- DROPPED / GLITCHING / REBOOTING CABINET MODULES ON ONSETS ---
  let step_fast = u32(floor(t * 7.0 + on * 4.5));
  let step_hold = u32(floor(t * 2.6 + bar() * 0.5));
  let drop_roll = hash2(cab_seed ^ (step_hold * 2654435761u), step_fast / 2u);
  let drop_prob = clamp(p_dropout() * (0.025 + on * 0.36 + beat_kick * 0.18 + r * 0.10), 0.0, 0.52);
  let is_dropped = drop_roll < drop_prob;
  let fault_mode = hash_u32(cab_seed ^ (step_hold * 9187u)) % 4u;

  // Compute media sample UV (shifted/torn on data-bus faults)
  var sample_uv = cell_uv;
  var rgb_sep = (0.0015 + energy * 0.005) / asp;
  if (is_dropped && fault_mode == 1u) {
    let dx = (hash2(cab_seed, step_fast + 5u) - 0.5) * 0.22;
    let dy = (hash2(cab_seed, step_fast + 11u) - 0.5) * 0.14;
    sample_uv = clamp(cell_uv + vec2f(dx, dy), vec2f(0.001), vec2f(0.999));
    rgb_sep *= 3.2;
  }

  let sr = tex_in(clamp(sample_uv + vec2f(rgb_sep, 0.0), vec2f(0.001), vec2f(0.999))).r;
  let sg = tex_in(sample_uv).g;
  let sb = tex_in(clamp(sample_uv - vec2f(rgb_sep, 0.0), vec2f(0.001), vec2f(0.999))).b;
  var led_col = max(vec3f(sr, sg, sb), vec3f(0.0));

  let luma_m = clamp(tex_luma(sample_uv).x, 0.0, 1.0);
  let edge_m = clamp(length(tex_edges(sample_uv).xy), 0.0, 2.0);
  let col_band = band(i32(cab_id.x % 16u));

  // Electric neon contour highlight along media edges driven by bass & onset
  let edge_accent = palette(fract(luma_m * 0.7 + f32(cab_id.x) / cab_cols * 0.35 + t * 0.08));
  let edge_drive = smoothstep(0.14, 0.85, edge_m) * p_edge_glow() * (0.28 + b * 0.95 + on * 0.75);
  led_col += edge_accent * edge_drive * 0.85;

  // Apply cabinet fault modes
  var panel_power = 1.0;
  var diag_led = vec3f(0.0);
  if (is_dropped) {
    if (fault_mode == 0u) {
      // Unpowered dead LED cabinet with tiny blinking diagnostic status LED
      panel_power = 0.03;
      let blink = step(0.45, fract(t * 5.0 + hash2(cab_seed, 71u)));
      let diag_d = length((cab_uv - vec2f(0.88, 0.86)) * vec2f(1.0, 1.0));
      diag_led = vec3f(1.3, 0.22, 0.06) * blink * smoothstep(0.08, 0.02, diag_d);
    } else if (fault_mode == 1u) {
      // Data-bus channel swap + overdrive
      led_col = vec3f(led_col.b, led_col.r * 0.9 + led_col.g * 0.3, led_col.g) * (1.15 + on * 0.45);
    } else if (fault_mode == 2u) {
      // Half-scan row-driver fault: alternating dead diode rows + bright spectrum bar tint
      let row_odd = (i32(diode_f.y) & 1) == 1;
      if (row_odd) {
        panel_power = 0.08;
      } else {
        let bar_col = palette(clamp(col_band * 0.9 + 0.1, 0.0, 1.0));
        led_col = mix(led_col, bar_col * (0.7 + luma_m * 0.9), 0.65) * 1.25;
      }
    } else {
      // Rebooting calibration flash / color-bar stripe
      let stripe_i = floor(cab_uv.x * 4.0) / 3.0;
      let reboot_fade = 0.45 + 0.55 * (1.0 - fract(ph * 2.0));
      led_col = mix(led_col * 0.4, palette(stripe_i) * (0.95 + col_band * 0.7), 0.72) * reboot_fade;
    }
  }

  // --- SWEEPING REFRESH SCAN BAND & SHUTTER ROLL ---
  let scan_y = fract(t * 0.52 + ph * 0.22);
  let scan_d = min(abs(buv.y - scan_y), 1.0 - abs(buv.y - scan_y));
  let scan_band = exp(-scan_d * scan_d * 110.0) * p_scan() * (0.35 + r * 0.95 + on * 0.8);
  let scan2_y = fract(-t * 0.31 + 0.5);
  let scan2_d = min(abs(buv.y - scan2_y), 1.0 - abs(buv.y - scan2_y));
  let scan2_band = exp(-scan2_d * scan2_d * 260.0) * p_scan() * (0.2 + b * 0.55);

  // Subtle horizontal rolling shutter ripple across scan rows
  let shutter = 0.91 + 0.09 * sin(buv.y * 42.0 - t * 24.0) * (0.3 + r * 0.7);
  led_col = led_col * cab_gain * cab_tint * shutter * panel_power;
  led_col += (vec3f(0.55, 0.75, 1.0) * 0.35 + led_col * 0.85) * scan_band;
  led_col += palette(0.78) * scan2_band * 0.45;

  // Overall musical luminance pulse
  led_col *= p_glow() * (0.86 + r * 0.28 + beat_kick * 0.34 + on * 0.24);

  // --- DISCRETE RGB SUBPIXEL LED DIODE GEOMETRY ---
  // Three vertical micro-LED phosphors (R, G, B) inside each circular diode dome
  let d_r = length((diode_local - vec2f(0.24, 0.50)) * vec2f(2.6, 1.35));
  let d_g = length((diode_local - vec2f(0.50, 0.50)) * vec2f(2.6, 1.35));
  let d_b = length((diode_local - vec2f(0.76, 0.50)) * vec2f(2.6, 1.35));
  let sub_r = smoothstep(0.68, 0.16, d_r);
  let sub_g = smoothstep(0.68, 0.16, d_g);
  let sub_b = smoothstep(0.68, 0.16, d_b);

  // Circular epoxy dome glow so RGB subpixels fuse cleanly at viewing distance
  let dome_d = length(diode_local - vec2f(0.5, 0.5));
  let dome_halo = smoothstep(0.52, 0.08, dome_d);
  let diode_core = vec3f(
    led_col.r * (0.62 * sub_r + 0.58 * dome_halo),
    led_col.g * (0.62 * sub_g + 0.58 * dome_halo),
    led_col.b * (0.62 * sub_b + 0.58 * dome_halo)
  );

  // Matte black louver housing behind unlit diode gaps
  let housing = vec3f(0.012, 0.014, 0.019) * (0.7 + 0.3 * cab_seam);
  var out_col = (housing + diode_core * 1.18) * (0.22 + 0.78 * cab_seam) + diag_led;

  // Faint metallic glint along cabinet seam edges
  let seam_glint = (1.0 - cab_seam) * 0.045 * (0.5 + r);
  out_col += spill_col * seam_glint;

  return vec4f(soft_clip(out_col), 1.0);
}
