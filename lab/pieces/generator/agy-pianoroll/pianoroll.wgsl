struct Uniforms {
  h0: vec4f, // width, height, time, headV
  h1: vec4f, // perspective, keyboardH, glow, grid
  h2: vec4f, // rms, bass, kick, subV
  h3: vec4f, // phase, bar, speed, palShift
  pal: array<vec4f, 8>,
  keys: array<vec4f, 12>, // 48 active key levels
};

@group(0) @binding(0) var<uniform> U: Uniforms;
@group(0) @binding(1) var roll_tex: texture_2d<f32>;
@group(0) @binding(2) var roll_samp: sampler;

const NUM_KEYS: i32 = 48;
const NUM_WHITE: f32 = 28.0; // 4 octaves * 7 white keys

fn pal_sample(x: f32) -> vec3f {
  let t = clamp(x, 0.0, 1.0) * 7.0;
  let i = min(6u, u32(floor(t)));
  let f = t - f32(i);
  return mix(U.pal[i].rgb, U.pal[i + 1u].rgb, f);
}

fn key_level(k: i32) -> f32 {
  let c = clamp(k, 0, NUM_KEYS - 1);
  let v = U.keys[c / 4];
  let m = c % 4;
  if (m == 0) { return v.x; }
  if (m == 1) { return v.y; }
  if (m == 2) { return v.z; }
  return v.w;
}

fn is_black(pc: i32) -> bool {
  return pc == 1 || pc == 3 || pc == 6 || pc == 8 || pc == 10;
}

// White key index (0..6) within an octave for a white pitch class
fn white_idx_in_oct(pc: i32) -> i32 {
  if (pc == 0) { return 0; }
  if (pc == 2) { return 1; }
  if (pc == 4) { return 2; }
  if (pc == 5) { return 3; }
  if (pc == 7) { return 4; }
  if (pc == 9) { return 5; }
  return 6;
}

// Pitch class (0..11) for white key index (0..6)
fn white_pc(wi: i32) -> i32 {
  if (wi == 0) { return 0; }
  if (wi == 1) { return 2; }
  if (wi == 2) { return 4; }
  if (wi == 3) { return 5; }
  if (wi == 4) { return 7; }
  if (wi == 5) { return 9; }
  return 11;
}

// Center x (in 0..NUM_WHITE units) of any key k (0..47)
fn key_center_w(k: i32) -> f32 {
  let oct = k / 12;
  let pc = k % 12;
  let base = f32(oct * 7);
  if (pc == 0) { return base + 0.5; }
  if (pc == 1) { return base + 0.96; }
  if (pc == 2) { return base + 1.5; }
  if (pc == 3) { return base + 2.04; }
  if (pc == 4) { return base + 2.5; }
  if (pc == 5) { return base + 3.5; }
  if (pc == 6) { return base + 3.94; }
  if (pc == 7) { return base + 4.5; }
  if (pc == 8) { return base + 5.0; }
  if (pc == 9) { return base + 5.5; }
  if (pc == 10) { return base + 6.06; }
  return base + 6.5;
}

// Map horizontal position wx in [0, NUM_WHITE) to the nearest black key (if any) and white key
fn black_key_at(wx: f32) -> vec2f {
  // Returns (keyIndex or -1, localX in -1..1)
  let oct = i32(floor(wx / 7.0));
  let lx = wx - f32(oct * 7);
  let half_w = 0.31;
  // Black key centers within an octave: C#=0.96, D#=2.04, F#=3.94, G#=5.00, A#=6.06
  let centers = array<f32, 5>(0.96, 2.04, 3.94, 5.00, 6.06);
  let pcs = array<i32, 5>(1, 3, 6, 8, 10);
  for (var i = 0; i < 5; i++) {
    let d = lx - centers[i];
    if (abs(d) < half_w) {
      let k = oct * 12 + pcs[i];
      if (k >= 0 && k < NUM_KEYS) {
        return vec2f(f32(k), d / half_w);
      }
    }
  }
  return vec2f(-1.0, 0.0);
}

fn note_color(k: i32) -> vec3f {
  let pc = f32(k % 12) / 12.0;
  let oct = f32(k / 12) / 4.0;
  let t = fract(pc * 0.72 + oct * 0.28 + U.h3.w * 0.25);
  return pal_sample(t);
}

@fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  let persp = U.h1.x;
  let kb_h = U.h1.y;
  let glow = U.h1.z;
  let grid = U.h1.w;

  let rms = U.h2.x;
  let bass = U.h2.y;
  let kick = U.h2.z;
  let sub_v = U.h2.w;
  let head_v = U.h0.w;

  let strike_y = 1.0 - kb_h;
  let margin_x = 0.035;

  // Reactive stage backdrop
  let bg_hue = pal_sample(fract(0.15 + U.h3.w * 0.3));
  let bg_energy = 0.02 + rms * 0.08 + bass * 0.10 + kick * 0.14;
  var col = bg_hue * bg_energy * (0.35 + 0.65 * (1.0 - uv.y));

  // ==================== FALLING NOTE HIGHWAY ====================
  if (uv.y < strike_y) {
    // Normalized highway y: 0 at strike line (now), 1 at top horizon (past)
    let hy = (strike_y - uv.y) / strike_y;

    // Optional 3D arcade perspective projection
    let z = 1.0 + hy * persp * 2.2;
    let hx = (uv.x - 0.5) * z + 0.5;
    let in_bounds = hx >= margin_x && hx <= (1.0 - margin_x);

    if (in_bounds) {
      let nx = (hx - margin_x) / (1.0 - 2.0 * margin_x);
      let wx = nx * NUM_WHITE;

      // Distance into the past along the ring buffer (perspective-corrected depth)
      let depth_v = (hy / (1.0 + (1.0 - hy) * persp * 0.45)) * 0.92;
      let sample_v = fract(head_v + sub_v - depth_v);

      // Perspective fade near top horizon
      let horizon_fade = smoothstep(1.0, 0.72, hy);

      // Highway surface
      let lane_oct = floor(wx / 7.0);
      let oct_tint = select(0.014, 0.026, (i32(lane_oct) % 2) == 0);
      col += bg_hue * (oct_tint * (0.4 + rms * 1.4)) * horizon_fade;

      // Vertical octave & key guide lines + scrolling beat grid
      if (grid > 0.01) {
        let f_oct = fract(wx / 7.0);
        let oct_line = smoothstep(0.025, 0.0, min(f_oct, 1.0 - f_oct));
        let f_key = fract(wx);
        let key_line = smoothstep(0.04, 0.0, min(f_key, 1.0 - f_key));
        // Beat grid lines scrolling down
        let beat_scroll = fract(hy * 6.0 - U.h3.x);
        let beat_line = smoothstep(0.03, 0.0, min(beat_scroll, 1.0 - beat_scroll));
        let grid_c = pal_sample(0.55) * (oct_line * 0.24 + key_line * 0.05 + beat_line * (0.14 + kick * 0.25));
        col += grid_c * grid * horizon_fade;
      }

      // Check white key lane underneath
      let wi_global = clamp(i32(floor(wx)), 0, 27);
      let oct_w = wi_global / 7;
      let w_k = oct_w * 12 + white_pc(wi_global % 7);
      let w_local = fract(wx) * 2.0 - 1.0; // -1..1 inside white key lane

      // Sample white key note
      let w_u = (f32(w_k) + 0.5) / f32(NUM_KEYS);
      let w_dat = textureSampleLevel(roll_tex, roll_samp, vec2f(w_u, sample_v), 0.0);

      // Check black key lane (overlays white lane edges)
      let bk = black_key_at(wx);
      let has_black = bk.x >= 0.0;
      var note_col = vec3f(0.0);
      var note_alpha = 0.0;

      // Render white key falling bar
      let w_body = w_dat.r;
      let w_att = w_dat.g;
      let w_aura = w_dat.b;
      let w_midi = w_dat.a;
      let w_c = note_color(w_k);

      // Soft ambient lane aura from continuous band energy
      col += w_c * w_aura * (0.14 + bass * 0.16) * horizon_fade * (1.0 - abs(w_local) * 0.5);

      if (w_body > 0.05) {
        let edge = smoothstep(0.92, 0.68, abs(w_local));
        let core = smoothstep(0.55, 0.0, abs(w_local));
        let bar_luma = (w_body * 1.15 + w_att * 0.95 + w_midi * 0.85) * glow;
        let highlight = mix(w_c, vec3f(1.0, 0.98, 0.95), clamp(core * 0.35 + w_att * 0.55 + w_midi * 0.4, 0.0, 0.85));
        note_col = highlight * bar_luma * edge;
        note_alpha = clamp(w_body * edge * 1.3, 0.0, 1.0);
      }

      // Render black key falling bar on top if present
      if (has_black) {
        let b_k = i32(bk.x);
        let b_local = bk.y;
        let b_u = (f32(b_k) + 0.5) / f32(NUM_KEYS);
        let b_dat = textureSampleLevel(roll_tex, roll_samp, vec2f(b_u, sample_v), 0.0);
        let b_body = b_dat.r;
        let b_att = b_dat.g;
        let b_midi = b_dat.a;
        let b_c = note_color(b_k) * 1.18;

        if (b_body > 0.05) {
          let b_edge = smoothstep(0.96, 0.62, abs(b_local));
          let b_core = smoothstep(0.50, 0.0, abs(b_local));
          let b_luma = (b_body * 1.25 + b_att * 1.0 + b_midi * 0.9) * glow;
          let b_hl = mix(b_c, vec3f(1.0, 0.96, 0.92), clamp(b_core * 0.4 + b_att * 0.6, 0.0, 0.9));
          let b_alpha = clamp(b_body * b_edge * 1.4, 0.0, 1.0);
          note_col = mix(note_col, b_hl * b_luma * b_edge, b_alpha);
          note_alpha = max(note_alpha, b_alpha);
        }
      }

      col = mix(col, col * 0.25 + note_col, note_alpha * horizon_fade);

      // Strike-line upward bloom from active keys hitting the keyboard
      let act_w = key_level(w_k);
      let act_b = select(0.0, key_level(i32(bk.x)), has_black);
      let act = max(act_w, act_b);
      let act_c = select(note_color(w_k), note_color(i32(bk.x)), has_black && act_b > act_w);
      let impact_glow = exp(-hy * 14.0) * (act * 1.35 + kick * 0.35) * glow;
      col += act_c * impact_glow;
    }

    // Glowing strike bar right above the keyboard
    let strike_d = abs(uv.y - strike_y);
    let strike_bar = exp(-strike_d * 240.0) * (0.45 + rms * 0.85 + kick * 1.2) * glow;
    let strike_tint = mix(pal_sample(0.6), vec3f(1.0, 0.97, 0.94), 0.45 + kick * 0.4);
    col += strike_tint * strike_bar;

  // ==================== PIANO KEYBOARD ====================
  } else {
    let ky = (uv.y - strike_y) / kb_h; // 0 at top of keys, 1 at bottom
    if (uv.x >= margin_x && uv.x <= (1.0 - margin_x)) {
      let nx = (uv.x - margin_x) / (1.0 - 2.0 * margin_x);
      let wx = nx * NUM_WHITE;

      let wi_global = clamp(i32(floor(wx)), 0, 27);
      let oct_w = wi_global / 7;
      let w_k = oct_w * 12 + white_pc(wi_global % 7);
      let w_lx = fract(wx);
      let w_act = key_level(w_k);
      let w_c = note_color(w_k);

      // White key geometry + subtle 3D shading
      let gap = smoothstep(0.0, 0.045, w_lx) * smoothstep(1.0, 0.955, w_lx);
      let bottom_lip = smoothstep(1.0, 0.90, ky);
      let depress = 1.0 - w_act * 0.08;
      let ivory = mix(vec3f(0.52, 0.54, 0.60), vec3f(0.84, 0.86, 0.90), smoothstep(0.0, 0.35, ky)) * bottom_lip * depress;
      // Lit white key glows with its note color
      let lit_white = mix(ivory * 0.32, w_c * (0.95 + w_act * 1.2) * glow, clamp(w_act * 1.25, 0.0, 1.0));
      let top_sheen = exp(-ky * 9.0) * w_act * glow * 0.85;
      var kcol = (lit_white + w_c * top_sheen) * gap;

      // Overlay raised black keys (occupy top 62% of keyboard height)
      let bk = black_key_at(wx);
      if (bk.x >= 0.0 && ky < 0.64) {
        let b_k = i32(bk.x);
        let b_lx = bk.y; // -1..1
        let b_act = key_level(b_k);
        let b_c = note_color(b_k);

        let bevel_x = smoothstep(1.0, 0.72, abs(b_lx));
        let bevel_y = smoothstep(0.64, 0.56, ky);
        let ebony = vec3f(0.03, 0.035, 0.05) + vec3f(0.06, 0.07, 0.09) * bevel_x * bevel_y;
        let rim = (1.0 - bevel_x * 0.65) * b_act * glow * 1.3;
        let face = b_c * b_act * (0.9 + b_act * 1.1) * glow * bevel_x * bevel_y;
        kcol = ebony + face + mix(b_c, vec3f(1.0), 0.35) * rim;
      }

      // Subtle shadow from strike bar onto top of keyboard
      kcol *= 0.72 + 0.28 * smoothstep(0.0, 0.12, ky);
      col = kcol;
    } else {
      // Cheek blocks on left/right of keyboard
      col = vec3f(0.02, 0.02, 0.03) + bg_hue * (0.04 + bass * 0.06);
    }
  }

  return vec4f(max(col, vec3f(0.0)), 1.0);
}
