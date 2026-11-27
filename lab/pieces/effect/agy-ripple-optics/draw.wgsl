// Optical render pass for agy-ripple-optics:
// Mode 0: Ripple tank refraction + true Laplacian caustics + chromatic glints
// Mode 1: Dynamic faceted prism & liquid lens array with 7-band spectral dispersion on highs
// Mode 2: Standing-wave Fresnel interferometer with thin-film optical iridescence

struct Draw {
  grid: vec2f, aspect: f32, mode: f32,
  refract: f32, caustic: f32, dispersion: f32, facets: f32,
  bass: f32, mid: f32, hi: f32, rms: f32,
  kick: f32, beat: f32, time: f32, reform_env: f32,
  pal_n: f32, pal_mix: f32, glow: f32, react: f32,
  has_luma: f32, has_edges: f32, pitch_norm: f32, shift: f32,
  pal: array<vec4f, 8>,
};

@group(0) @binding(0) var<uniform> dr: Draw;
@group(0) @binding(1) var<storage, read> cells: array<vec4f>;
@group(0) @binding(2) var smp: sampler;
@group(0) @binding(3) var tpic: texture_2d<f32>;
@group(0) @binding(4) var tluma: texture_2d<f32>;
@group(0) @binding(5) var tedges: texture_2d<f32>;

fn lab2lin(c: vec3f) -> vec3f {
  let l_ = c.x + 0.3963377774 * c.y + 0.2158037573 * c.z;
  let m_ = c.x - 0.1055613458 * c.y - 0.0638541728 * c.z;
  let s_ = c.x - 0.0894841775 * c.y - 1.291485548 * c.z;
  let l = l_ * l_ * l_;
  let m = m_ * m_ * m_;
  let s = s_ * s_ * s_;
  return max(vec3f(0.0), vec3f(
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ));
}

fn pal(x: f32) -> vec3f {
  let n = max(i32(dr.pal_n), 1);
  let t = fract(x + dr.shift);
  let f = t * f32(n - 1);
  let i = min(i32(floor(f)), n - 1);
  let j = min(i + 1, n - 1);
  return lab2lin(mix(dr.pal[i].xyz, dr.pal[j].xyz, f - f32(i)));
}

fn cell_at(x: i32, y: i32) -> vec4f {
  let w = i32(dr.grid.x);
  let h = i32(dr.grid.y);
  let cx = clamp(x, 0, w - 1);
  let cy = clamp(y, 0, h - 1);
  return cells[u32(cy * w + cx)];
}

fn smp_cell(uv: vec2f) -> vec4f {
  let q = uv * dr.grid - 0.5;
  let i = vec2i(floor(q));
  let f = q - floor(q);
  let c00 = cell_at(i.x, i.y);
  let c10 = cell_at(i.x + 1, i.y);
  let c01 = cell_at(i.x, i.y + 1);
  let c11 = cell_at(i.x + 1, i.y + 1);
  return mix(mix(c00, c10, f.x), mix(c01, c11, f.x), f.y);
}

fn hash2(p: vec2f) -> vec2f {
  let q = vec2f(dot(p, vec2f(127.1, 311.7)), dot(p, vec2f(269.5, 183.3)));
  return fract(sin(q) * 43758.5453);
}

fn smp_pic(uv: vec2f) -> vec3f {
  // Mirror-clamp at edges so strong prism/wave refraction never smears border stripes
  let m = abs(fract(uv * 0.5 + 0.5) * 2.0 - 1.0);
  return max(textureSampleLevel(tpic, smp, clamp(m, vec2f(0.001), vec2f(0.999)), 0.0).rgb, vec3f(0.0));
}

// 7-band physical spectral dispersion (sums exactly to (1,1,1) when spread == 0)
fn sample_spectrum7(uv: vec2f, dir: vec2f, spread: f32) -> vec3f {
  let s = clamp(spread, 0.0, 0.24);
  if (s < 0.0005) {
    return smp_pic(uv);
  }
  let w0 = vec3f(0.32, 0.01, 0.00); // deep red
  let w1 = vec3f(0.38, 0.14, 0.00); // orange
  let w2 = vec3f(0.24, 0.30, 0.02); // yellow
  let w3 = vec3f(0.05, 0.35, 0.10); // green
  let w4 = vec3f(0.01, 0.16, 0.30); // cyan
  let w5 = vec3f(0.00, 0.04, 0.38); // blue
  let w6 = vec3f(0.00, 0.00, 0.20); // violet
  // Normalized weights: R=1.00, G=1.00, B=1.00
  var acc = vec3f(0.0);
  acc += smp_pic(uv + dir * (s * -1.00)) * w0;
  acc += smp_pic(uv + dir * (s * -0.66)) * w1;
  acc += smp_pic(uv + dir * (s * -0.33)) * w2;
  acc += smp_pic(uv + dir * (s *  0.00)) * w3;
  acc += smp_pic(uv + dir * (s *  0.33)) * w4;
  acc += smp_pic(uv + dir * (s *  0.66)) * w5;
  acc += smp_pic(uv + dir * (s *  1.00)) * w6;
  return acc;
}

// 3-band crisp RGB chromatic refraction
fn sample_rgb(uv: vec2f, dir: vec2f, spread: f32) -> vec3f {
  let s = clamp(spread, 0.0, 0.18);
  let r = smp_pic(uv + dir * s).r;
  let g = smp_pic(uv).g;
  let b = smp_pic(uv - dir * s).b;
  return vec3f(r, g, b);
}

// Spectral rainbow colour from phase 0..1 (thin-film interference / dispersion glints)
fn spectral(t: f32) -> vec3f {
  return clamp(0.52 + 0.48 * cos(6.28318 * (t + vec3f(0.0, 0.33, 0.67))), vec3f(0.0), vec3f(1.0));
}

// Dynamic Voronoi crystal prism / liquid lens field
// Returns: (facet_dir.xy, facet_bevel_edge, cell_id_hash)
fn prism_field(uv: vec2f, scale: f32, rot: f32, wobble: f32) -> vec4f {
  let ca = cos(rot);
  let sa = sin(rot);
  let p0 = vec2f((uv.x - 0.5) * dr.aspect, uv.y - 0.5);
  let p = vec2f(ca * p0.x - sa * p0.y, sa * p0.x + ca * p0.y) * scale;
  let ip = floor(p);
  let fp = fract(p);

  var d1 = 10.0;
  var d2 = 10.0;
  var best_v = vec2f(0.0);
  var best_h = 0.0;

  for (var dy = -1; dy <= 1; dy = dy + 1) {
    for (var dx = -1; dx <= 1; dx = dx + 1) {
      let cell = ip + vec2f(f32(dx), f32(dy));
      let rnd = hash2(cell);
      let anim = 0.5 + 0.34 * sin(dr.time * (0.55 + 0.4 * wobble) + rnd * 6.28318);
      let v = vec2f(f32(dx), f32(dy)) + anim - fp;
      let d = dot(v, v);
      if (d < d1) {
        d2 = d1;
        d1 = d;
        best_v = v;
        best_h = rnd.x;
      } else if (d < d2) {
        d2 = d;
      }
    }
  }
  let edge_dist = sqrt(d2) - sqrt(d1);
  // Combine radial lens vector with per-facet prism tilt
  let tilt_ang = best_h * 6.28318 + rot * 1.5;
  let prism_dir = vec2f(cos(tilt_ang), sin(tilt_ang)) * 0.65 - best_v * 0.75;
  let bevel = smoothstep(0.16, 0.0, edge_dist);
  return vec4f(prism_dir, bevel, best_h);
}

@fragment fn fs_draw(@builtin(position) pos: vec4f, @location(0) uv: vec2f) -> @location(0) vec4f {
  let texel = 1.0 / dr.grid;
  let cC = smp_cell(uv);
  let hL = smp_cell(uv - vec2f(texel.x, 0.0)).x;
  let hR = smp_cell(uv + vec2f(texel.x, 0.0)).x;
  let hU = smp_cell(uv - vec2f(0.0, texel.y)).x;
  let hD = smp_cell(uv + vec2f(0.0, texel.y)).x;

  let dh = vec2f(hR - hL, hD - hU) * 0.5;
  let lap = (hL + hR + hU + hD) * 0.25 - cC.x;

  // Media luma & edges
  let raw_pic = smp_pic(uv);
  let lum = select(dot(raw_pic, vec3f(0.2126, 0.7152, 0.0722)),
                   textureSampleLevel(tluma, smp, uv, 0.0).r,
                   dr.has_luma > 0.5);
  let ed = select(vec2f(0.0), textureSampleLevel(tedges, smp, uv, 0.0).rg, dr.has_edges > 0.5);
  let em = clamp(length(ed) * 1.4, 0.0, 1.5);

  // Audio activity envelope: calm & clear on quiet, vivid & dramatic on techno/dense
  let audio_lvl = clamp(dr.rms * 1.5 + dr.bass * 1.1 + dr.hi * 0.9 + dr.kick * 1.1, 0.0, 2.5);
  let calm_scale = (1.0 - 0.78 * dr.reform_env);
  let react_gain = (0.14 + 0.86 * smoothstep(0.03, 0.32, audio_lvl) * dr.react) * calm_scale;

  let mode = i32(dr.mode + 0.5);
  var col = vec3f(0.0);

  if (mode == 0) {
    // === MODE 0: RIPPLE TANK & CAUSTICS ===
    let slope_vec = dh * vec2f(1.0 / dr.aspect, 1.0);
    let bend = dr.refract * (0.045 + 0.11 * react_gain * (0.4 + dr.bass + 0.9 * dr.kick));
    // Subtle refraction from picture's own edges as submerged glass relief
    let relief = ed * (0.005 + 0.018 * dr.bass * react_gain);
    let refract_uv = uv + slope_vec * bend + relief;

    // Chromatic dispersion widened by highs and wave steepness
    let disp_dir = select(normalize(slope_vec + vec2f(1e-4, 0.0)), vec2f(1.0, 0.0), length(slope_vec) < 1e-4);
    let disp_amt = dr.dispersion * (0.002 + (0.018 * dr.hi + 0.014 * dr.kick + 0.008 * dr.bass) * react_gain)
                 * (0.35 + 4.0 * length(dh));
    let refracted = sample_rgb(refract_uv, disp_dir, disp_amt);

    // True optical caustic focusing: bright webs where rays converge (-lap > 0)
    let focus_now = max(0.0, -lap) * 11.0;
    let focus_sharp = pow(clamp(focus_now + cC.z * 0.42, 0.0, 2.2), 1.65);
    let spec_normal = normalize(vec3f(-dh.x * 5.2, -dh.y * 5.2, 1.0));
    let light_dir = normalize(vec3f(0.35 * cos(dr.time * 0.4), 0.35 * sin(dr.time * 0.35), 1.0));
    let spec = pow(max(dot(spec_normal, light_dir), 0.0), 18.0) * (0.35 + 1.6 * length(dh));

    // Spectral caustic tint blending picture brightness + palette
    let pal_c = pal(fract(cC.x * 0.8 + lum * 0.45 + dr.pitch_norm * 0.35));
    let caustic_tint = mix(refracted * 1.45 + vec3f(0.18, 0.24, 0.28), pal_c * 1.35 + spectral(cC.x * 1.6 + dr.hi) * 0.35, dr.pal_mix);
    let caustic_pwr = dr.caustic * (0.18 + 0.95 * react_gain * (0.55 + 0.8 * dr.bass + 0.85 * dr.kick + 0.55 * dr.hi));

    // Shoreline shimmer where waves meet picture edges
    let shore = em * clamp(abs(cC.x) * 2.4 + cC.z * 0.7, 0.0, 1.4) * (0.2 + 0.9 * dr.hi + 0.6 * dr.kick) * react_gain;

    // Gentle deep-water contrast on active troughs, luminous caustic crests
    let trough_shade = mix(1.0, clamp(0.76 + 0.35 * cC.x, 0.55, 1.25), clamp(react_gain * 0.7, 0.0, 0.85));
    col = refracted * trough_shade
        + caustic_tint * focus_sharp * caustic_pwr * 0.62
        + mix(vec3f(0.95, 0.98, 1.0), pal_c, 0.45) * spec * caustic_pwr * 0.55
        + pal_c * shore * 0.45;
  } else if (mode == 1) {
    // === MODE 1: CHROMATIC PRISM & LIQUID LENS SIM ===
    let facets = dr.facets * (1.0 - 0.18 * dr.bass * react_gain);
    let rot = dr.time * 0.14 + dr.bass * 0.45 * react_gain + dr.pitch_norm * 0.8;
    let pf = prism_field(uv, facets, rot, dr.mid + dr.bass);
    let pdir = pf.xy;
    let bevel = pf.z;
    let cell_h = pf.w;

    // Combine crystal prism facet refraction + live wave ripples + media luma lens curvature
    let wave_n = dh * vec2f(1.0 / dr.aspect, 1.0);
    let lens_bend = dr.refract * (0.012 + 0.068 * react_gain * (0.45 + 0.95 * dr.bass + 0.85 * dr.kick));
    let prism_uv = uv + pdir * lens_bend + wave_n * (lens_bend * 1.4) + ed * (0.012 * react_gain);

    // 7-band full-spectrum rainbow splitting exploded by highs and onsets!
    let disp_dir = normalize(pdir + wave_n * 3.5 + ed * 1.2 + vec2f(0.001, 0.001));
    let hi_drive = dr.hi * 1.55 + dr.kick * 1.15 + dr.mid * 0.35;
    let spread = dr.dispersion * (0.004 + 0.085 * react_gain * hi_drive) * (0.45 + 0.9 * bevel + 1.8 * length(dh) + 0.4 * em);
    let dispersed = sample_spectrum7(prism_uv, disp_dir, spread);

    // Internal prism caustic beams & bevel Fresnel reflections
    let caustic_ray = pow(clamp(max(0.0, -lap) * 8.0 + bevel * (0.55 + 0.85 * dr.hi + 0.65 * dr.kick), 0.0, 2.0), 1.55);
    let spec_col = spectral(cell_h + dr.time * 0.18 + dr.hi * 0.6 + lum * 0.5);
    let pal_c = pal(fract(cell_h * 0.7 + dr.pitch_norm * 0.4 + dr.hi * 0.3));
    let facet_tint = mix(spec_col, pal_c, dr.pal_mix);

    // Slight per-facet glass sheen
    let glass_tint = mix(vec3f(1.0), 0.84 + 0.32 * facet_tint, 0.35 * react_gain);
    let rim = bevel * (0.14 + 0.85 * react_gain * (0.4 + dr.hi * 1.2 + dr.kick * 0.9)) * dr.caustic;

    col = dispersed * glass_tint
        + facet_tint * rim * 0.55
        + mix(dispersed, spec_col, 0.55) * caustic_ray * dr.caustic * react_gain * 0.42;
  } else {
    // === MODE 2: STANDING-WAVE INTERFEROMETER & THIN-FILM LENS ===
    let p = vec2f((uv.x - 0.5) * dr.aspect, uv.y - 0.5);
    let r = length(p);
    let radial_dir = select(p / r, vec2f(1.0, 0.0), r > 1e-4);

    // Fresnel wave-lens rings + live tank interference
    let ring_freq = 16.0 + 20.0 * dr.pitch_norm;
    let fresnel_slope = sin(r * ring_freq - dr.time * 3.8 - dr.bass * 2.5) * exp(-r * 1.3);
    let wave_n = dh * vec2f(1.0 / dr.aspect, 1.0);
    let total_n = wave_n * 1.45 + radial_dir * (fresnel_slope * 0.14 * (0.25 + dr.bass + dr.kick));

    let bend = dr.refract * (0.025 + 0.095 * react_gain * (0.45 + 0.85 * dr.bass + 0.9 * dr.kick));
    let refr_uv = uv + total_n * bend + ed * (0.01 * react_gain);

    let disp_dir = normalize(total_n + vec2f(1e-4, 0.0));
    let spread = dr.dispersion * (0.003 + 0.055 * react_gain * (dr.hi * 1.35 + dr.kick * 0.95 + dr.mid * 0.3)) * (0.4 + 2.8 * length(total_n));
    let refr = sample_spectrum7(refr_uv, disp_dir, spread);

    // Thin-film interference iridescence along wave crests & media contours
    let opd = cC.x * 2.6 + fresnel_slope * 0.9 + lum * 1.2 + dr.hi * 1.4 + dr.time * 0.25;
    let irid = spectral(opd);
    let pal_c = pal(fract(opd * 0.35 + dr.pitch_norm * 0.5));
    let film = mix(irid, pal_c, dr.pal_mix);

    let caustic_web = pow(clamp(max(0.0, -lap) * 10.0 + cC.z * 0.55 + abs(fresnel_slope) * 0.38, 0.0, 2.2), 1.6);
    let film_amt = (0.14 + 0.72 * react_gain * (0.35 + dr.hi * 0.85 + dr.bass * 0.65 + dr.kick * 0.75)) * dr.caustic;

    col = refr * (0.86 + 0.24 * clamp(cC.x * 0.8 + 0.5, 0.0, 1.2))
        + film * caustic_web * film_amt * 0.48
        + film * em * (0.12 + 0.55 * dr.hi * react_gain) * 0.45;
  }

  // Phrase re-formation snap: cleanly re-clarifies the live picture at phrase turns
  let clear_mix = clamp(dr.reform_env * 0.55, 0.0, 0.65);
  col = mix(col, raw_pic * (0.95 + 0.2 * dr.beat), clear_mix);

  // Beat / onset optical bloom breath & soft HDR shoulder so dense never blows out
  let exp_gain = dr.glow * (0.88 + 0.24 * dr.bass * react_gain + 0.22 * dr.kick * react_gain);
  col = max(col * exp_gain, vec3f(0.0));
  col = col / (vec3f(1.0) + col * 0.24);

  return vec4f(col, 1.0);
}
