struct Uniforms {
  h0: vec4f, // width, height, time, wheelAngle
  h1: vec4f, // bestK, keyHue, web, pulse
  h2: vec4f, // glow, labels, rms, bass
  h3: vec4f, // kick, phase, bar, keyConf
  chroma: array<vec4f, 3>, // 12 pitch classes in fifths order
  scores: array<vec4f, 3>, // 12 normalized key scores
  wcol: array<vec4f, 12>,  // 12 wedge linear RGB colors
  kcol: vec4f,             // estimated key linear RGB color
};

@group(0) @binding(0) var<uniform> U: Uniforms;

const PI: f32 = 3.14159265359;
const TAU: f32 = 6.28318530718;

fn get_chroma(k: i32) -> f32 {
  let c = ((k % 12) + 12) % 12;
  let v = U.chroma[c / 4];
  let m = c % 4;
  if (m == 0) { return v.x; }
  if (m == 1) { return v.y; }
  if (m == 2) { return v.z; }
  return v.w;
}

fn get_score(k: i32) -> f32 {
  let c = ((k % 12) + 12) % 12;
  let v = U.scores[c / 4];
  let m = c % 4;
  if (m == 0) { return v.x; }
  if (m == 1) { return v.y; }
  if (m == 2) { return v.z; }
  return v.w;
}

// 3x5 bitpacked font for note letters: 0=A, 1=B, 2=C, 3=D, 4=E, 5=F, 6=G, 7=#, 8=b
fn glyph_bit(id: i32, gx: i32, gy: i32) -> f32 {
  if (gx < 0 || gx > 2 || gy < 0 || gy > 4) { return 0.0; }
  var bits: u32 = 0u;
  if (id == 0) { bits = 0x57752u; }      // A: 010 101 111 101 101
  else if (id == 1) { bits = 0x65656u; } // B: 110 101 110 101 110
  else if (id == 2) { bits = 0x71117u; } // C: 111 100 100 100 111 (LSB left)
  else if (id == 3) { bits = 0x65556u; } // D: 110 101 101 101 110
  else if (id == 4) { bits = 0x71317u; } // E: 111 100 110 100 111
  else if (id == 5) { bits = 0x11317u; } // F: 111 100 110 100 100
  else if (id == 6) { bits = 0x75617u; } // G: 111 100 101 101 111 -> fixed below
  else if (id == 7) { bits = 0x57575u; } // #
  else if (id == 8) { bits = 0x75711u; } // b: 100 100 111 101 111
  // Explicit row masks (3 bits per row, bit 0 = left, bit 2 = right)
  var row: u32 = 0u;
  if (id == 0) {
    let r = array<u32, 5>(2u, 5u, 7u, 5u, 5u); row = r[gy]; // A
  } else if (id == 1) {
    let r = array<u32, 5>(3u, 5u, 3u, 5u, 3u); row = r[gy]; // B
  } else if (id == 2) {
    let r = array<u32, 5>(6u, 1u, 1u, 1u, 6u); row = r[gy]; // C
  } else if (id == 3) {
    let r = array<u32, 5>(3u, 5u, 5u, 5u, 3u); row = r[gy]; // D
  } else if (id == 4) {
    let r = array<u32, 5>(7u, 1u, 3u, 1u, 7u); row = r[gy]; // E
  } else if (id == 5) {
    let r = array<u32, 5>(7u, 1u, 3u, 1u, 1u); row = r[gy]; // F
  } else if (id == 6) {
    let r = array<u32, 5>(6u, 1u, 5u, 5u, 6u); row = r[gy]; // G
  } else if (id == 7) {
    let r = array<u32, 5>(5u, 7u, 5u, 7u, 5u); row = r[gy]; // #
  } else if (id == 8) {
    let r = array<u32, 5>(1u, 1u, 3u, 5u, 3u); row = r[gy]; // b
  }
  let _unused = bits;
  return f32((row >> u32(gx)) & 1u);
}

// Render label for circle-of-fifths index k (0=C, 1=G, 2=D, 3=A, 4=E, 5=B, 6=F#, 7=Db, 8=Ab, 9=Eb, 10=Bb, 11=F)
fn sample_label(k: i32, lp: vec2f) -> f32 {
  let letters = array<i32, 12>(2, 6, 3, 0, 4, 1, 5, 3, 0, 4, 1, 5);
  let accs    = array<i32, 12>(-1, -1, -1, -1, -1, -1, 7, 8, 8, 8, 8, -1);
  let ch0 = letters[k];
  let ch1 = accs[k];

  // lp in approx [-1, 1] x [-1, 1]
  if (ch1 < 0) {
    // Single letter centered
    let gx = i32(floor((lp.x + 0.52) / 0.35));
    let gy = i32(floor((lp.y + 0.72) / 0.29));
    return glyph_bit(ch0, gx, gy);
  } else {
    // Two characters side-by-side
    let gx0 = i32(floor((lp.x + 0.92) / 0.28));
    let gy0 = i32(floor((lp.y + 0.68) / 0.27));
    let gx1 = i32(floor((lp.x - 0.06) / 0.28));
    let gy1 = i32(floor((lp.y + 0.68) / 0.27));
    return max(glyph_bit(ch0, gx0, gy0), glyph_bit(ch1, gx1, gy1));
  }
}

fn seg_dist(p: vec2f, a: vec2f, b: vec2f) -> f32 {
  let pa = p - a;
  let ba = b - a;
  let h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-6), 0.0, 1.0);
  return length(pa - ba * h);
}

fn rot2(v: vec2f, a: f32) -> vec2f {
  let c = cos(a);
  let s = sin(a);
  return vec2f(v.x * c - v.y * s, v.x * s + v.y * c);
}

@fragment fn fs_main(@location(0) uv: vec2f) -> @location(0) vec4f {
  let aspect = U.h0.x / max(U.h0.y, 1.0);
  let time = U.h0.z;
  let wheel_ang = U.h0.w;

  let best_k = i32(round(U.h1.x));
  let web_amt = U.h1.z;
  let pulse_amt = U.h1.w;

  let glow = U.h2.x;
  let show_labels = U.h2.y;
  let rms = U.h2.z;
  let bass = U.h2.w;

  let kick = U.h3.x;
  let phase = U.h3.y;

  let key_col = U.kcol.rgb;

  // Aspect-corrected centered coordinates: y down in uv, so top (12 o'clock) is (0, -1)
  let p = (uv - 0.5) * vec2f(aspect, 1.0);
  let r = length(p);

  // Key-tinted reactive backdrop with radial glow
  let bg_pulse = 0.025 + rms * 0.09 + bass * 0.14 * pulse_amt + kick * 0.18 * pulse_amt;
  let bg_radial = exp(-r * r * 3.8);
  var col = key_col * bg_pulse * (0.35 + 1.35 * bg_radial);

  // Subtle concentric harmonic ripple rings expanding on beat phase & onsets
  let ripple_r = fract(phase) * 0.58 + 0.12;
  let ripple = exp(-abs(r - ripple_r) * 75.0) * (1.0 - fract(phase)) * (0.2 + kick * 0.9 + bass * 0.5) * pulse_amt;
  col += key_col * ripple * glow * 0.7;

  // Outer ambient halo ring
  let halo = exp(-abs(r - 0.435) * 42.0) * (0.12 + rms * 0.45 + kick * 0.65);
  col += key_col * halo * glow * 0.55;

  // ==================== ROTATED WHEEL COORDINATES ====================
  // Angle clockwise from 12 o'clock (0, -1): atan2(x, -y) in [-PI, PI]
  let raw_ang = atan2(p.x, -p.y);
  let rel_ang = raw_ang - wheel_ang;
  // Map to [0, TAU) with wedge 0 centered at 0 (12 o'clock)
  let shifted = ((rel_ang + TAU / 24.0) % TAU + TAU) % TAU;
  let sector_f = shifted / (TAU / 12.0);
  let k = clamp(i32(floor(sector_f)), 0, 11);
  let sector_u = fract(sector_f) - 0.5; // -0.5..0.5 within wedge

  let act = get_chroma(k);
  let kscore = get_score(k);
  let wcol = U.wcol[k].rgb;
  let is_tonic = k == best_k;
  // Adjacent fifths (IV and V) relative to estimated key
  let dist_key = min((k - best_k + 12) % 12, (best_k - k + 12) % 12);
  let is_neighbor = dist_key == 1;

  // Wedge geometry: inner radius and outer radius expand with activation & bass pulse
  let r_in = 0.245 + bass * 0.015 * pulse_amt;
  let r_out_base = 0.395 + select(0.0, 0.018, is_tonic) + act * 0.055 * (0.6 + 0.4 * pulse_amt) + kick * 0.014 * pulse_amt;

  // Anti-aliased radial & angular wedge mask
  let gap_ang = 0.022 / max(r, 0.15);
  let ang_mask = smoothstep(0.5, 0.5 - gap_ang * 4.0, abs(sector_u));
  let rad_mask = smoothstep(r_in - 0.005, r_in + 0.004, r) * smoothstep(r_out_base + 0.006, r_out_base - 0.004, r);
  let wedge_mask = ang_mask * rad_mask;

  if (wedge_mask > 0.001) {
    let r_norm = clamp((r - r_in) / max(r_out_base - r_in, 0.01), 0.0, 1.0);
    // Base metallic dark glass body + strong chroma illumination
    let base_fill = wcol * (0.08 + 0.06 * kscore + 0.08 * rms);
    let active_fill = wcol * (act * (1.25 + 0.85 * r_norm) + select(0.0, 0.32 + kick * 0.45, is_tonic) + select(0.0, 0.14, is_neighbor)) * glow;
    // Crisp inner/outer bevel rim
    let rim = (smoothstep(0.14, 0.0, r_norm) + smoothstep(0.84, 1.0, r_norm)) * (0.28 + act * 1.1 + select(0.0, 0.7, is_tonic));
    let rim_col = mix(wcol, vec3f(1.0, 0.98, 0.95), 0.45 + act * 0.35);
    var w_rgb = base_fill + active_fill + rim_col * rim * glow * 0.55;

    // Hot white-tinted energy bar rising inside active wedges
    let bar_fill = smoothstep(act + 0.04, act - 0.08, r_norm) * act;
    w_rgb += mix(wcol, vec3f(1.0), 0.35) * bar_fill * 0.55 * glow;

    // Upright note label centered inside each wedge
    if (show_labels > 0.5) {
      let mid_ang = f32(k) * (TAU / 12.0) + wheel_ang;
      let label_r = 0.318;
      let center_pos = vec2f(sin(mid_ang), -cos(mid_ang)) * label_r;
      let lp = (p - center_pos) / 0.028;
      let bit = sample_label(k, lp);
      if (bit > 0.5) {
        let txt_col = mix(vec3f(0.88, 0.90, 0.95), vec3f(1.0, 1.0, 1.0), clamp(act + select(0.0, 0.6, is_tonic), 0.0, 1.0));
        w_rgb = mix(w_rgb, txt_col * (0.95 + act * 0.8 + kick * 0.35) * glow, 0.92);
      }
    }

    col = mix(col, w_rgb, wedge_mask);
  }

  // Outer tonic crown arc highlighting the estimated key wedge
  if (is_tonic) {
    let crown_r = r_out_base + 0.016;
    let crown = exp(-abs(r - crown_r) * 160.0) * ang_mask * (0.85 + kick * 0.9 + bass * 0.5) * glow;
    col += mix(key_col, vec3f(1.0, 0.98, 0.92), 0.5) * crown;
  }

  // ==================== FIXED 12 O'CLOCK KEY POINTER ====================
  // Small glowing chevron pointing down at the top tonic wedge
  let ptr_p = p - vec2f(0.0, -0.468 - kick * 0.01 * pulse_amt);
  let ptr_d = max(abs(ptr_p.x) * 1.45 - ptr_p.y * 0.95 - 0.014, -ptr_p.y - 0.018);
  let ptr_mask = smoothstep(0.005, -0.003, ptr_d);
  let ptr_glow = exp(-max(ptr_d, 0.0) * 90.0) * (0.45 + kick * 0.8 + rms * 0.4) * glow;
  col += mix(key_col, vec3f(1.0), 0.55) * (ptr_mask * 1.35 * glow + ptr_glow);

  // ==================== INNER HARMONIC CONSTELLATION WEB ====================
  if (r < 0.255 && web_amt > 0.01) {
    let node_r = 0.222 + bass * 0.012 * pulse_amt;
    var nodes: array<vec2f, 12>;
    for (var i = 0; i < 12; i++) {
      let a = f32(i) * (TAU / 12.0) + wheel_ang;
      nodes[i] = vec2f(sin(a), -cos(a)) * node_r;
    }

    // Glowing chord filaments between active pitch classes
    var web_col = vec3f(0.0);
    for (var i = 0; i < 12; i++) {
      let ai = get_chroma(i);
      if (ai < 0.16) { continue; }
      let ci = U.wcol[i].rgb;
      // Node dot on the inner rim
      let nd = length(p - nodes[i]);
      web_col += mix(ci, vec3f(1.0), 0.35) * exp(-nd * 95.0) * ai * 1.15;

      for (var j = i + 1; j < 12; j++) {
        let aj = get_chroma(j);
        if (aj < 0.16) { continue; }
        let strength = ai * aj;
        if (strength < 0.045) { continue; }
        let d = seg_dist(p, nodes[i], nodes[j]);
        let line = exp(-d * 185.0) * strength * 1.35;
        let line_c = mix(ci, U.wcol[j].rgb, 0.5);
        web_col += line_c * line;
      }
    }
    col += web_col * web_amt * glow;
  }

  // ==================== CENTRAL KEY ORB ====================
  let orb_r = 0.055 + bass * 0.032 * pulse_amt + kick * 0.022 * pulse_amt;
  let orb_core = smoothstep(orb_r + 0.008, orb_r * 0.25, r);
  let orb_ring = exp(-abs(r - (orb_r + 0.022)) * 130.0) * (0.45 + rms * 0.8 + kick * 1.0);
  let orb_halo = exp(-r * 11.0) * (0.25 + rms * 0.75 + bass * 0.9 * pulse_amt);
  // Subtle rotating interference shimmer inside core
  let swirl = 0.85 + 0.15 * sin(raw_ang * 3.0 - time * 2.5 + phase * TAU);
  col += mix(key_col, vec3f(1.0, 0.98, 0.95), 0.45 * orb_core) * (orb_core * (0.55 + bass * 1.1 + kick * 0.9) * swirl + orb_ring + orb_halo) * glow;

  return vec4f(max(col, vec3f(0.0)), 1.0);
}
