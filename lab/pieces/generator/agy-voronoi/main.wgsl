// Voronoi stained-glass / cracked-ice shatter generator.
// Seeds drift with the music, cells split into sub-shards on beats, and edges glow with treble.

fn v_hash22(p: vec2f) -> vec2f {
  var q = vec2f(
    dot(p, vec2f(127.1, 311.7)),
    dot(p, vec2f(269.5, 183.3))
  );
  return fract(sin(q) * 43758.5453123);
}

fn v_hash21(p: vec2f) -> f32 {
  return fract(sin(dot(p, vec2f(127.1, 311.7))) * 43758.5453123);
}

fn v_rot(p: vec2f, a: f32) -> vec2f {
  let c = cos(a);
  let s = sin(a);
  return vec2f(p.x * c - p.y * s, p.x * s + p.y * c);
}

struct VoronoiHit {
  edge: f32,
  dist: f32,
  cell_id: vec2f,
  local: vec2f,
}

fn voronoi_exact(x: vec2f, t: f32, wobble: f32) -> VoronoiHit {
  let n = floor(x);
  let f = fract(x);

  var mg = vec2f(0.0);
  var mr = vec2f(0.0);
  var md = 8.0;

  for (var j = -1; j <= 1; j = j + 1) {
    for (var i = -1; i <= 1; i = i + 1) {
      let g = vec2f(f32(i), f32(j));
      let o = v_hash22(n + g);
      let phase_o = 6.2831853 * o + vec2f(t * (0.7 + 0.6 * o.y), t * (0.65 + 0.55 * o.x));
      let seed = 0.5 + (0.38 + 0.08 * wobble) * sin(phase_o);
      let r = g + seed - f;
      let d = dot(r, r);
      if (d < md) {
        md = d;
        mr = r;
        mg = g;
      }
    }
  }

  var edge_d = 8.0;
  for (var j = -1; j <= 1; j = j + 1) {
    for (var i = -1; i <= 1; i = i + 1) {
      let g = mg + vec2f(f32(i), f32(j));
      let o = v_hash22(n + g);
      let phase_o = 6.2831853 * o + vec2f(t * (0.7 + 0.6 * o.y), t * (0.65 + 0.55 * o.x));
      let seed = 0.5 + (0.38 + 0.08 * wobble) * sin(phase_o);
      let r = g + seed - f;
      let diff = r - mr;
      if (dot(diff, diff) > 0.00001) {
        edge_d = min(edge_d, dot(0.5 * (mr + r), normalize(diff)));
      }
    }
  }

  var hit: VoronoiHit;
  hit.edge = edge_d;
  hit.dist = sqrt(md);
  hit.cell_id = n + mg;
  hit.local = -mr;
  return hit;
}

fn shade(uv: vec2f) -> vec4f {
  let asp = aspect();
  let t = time();

  let b_energy = bass();
  let mid_energy = (band(4) + band(5) + band(6) + band(7) + band(8)) * 0.2;
  let treble = (band(10) + band(11) + band(12) + band(13) + band(14) + band(15)) / 6.0;
  let energy = rms();
  let on = onset();
  let ph = phase();
  let br = bar();

  // Sharp beat impulse that splits and jolts cells
  let beat_env = pow(max(0.0, 1.0 - ph), 2.8);
  let shatter_amt = p_shatter();
  let shatter_pulse = clamp((beat_env * (0.35 + 1.15 * b_energy) + on * 0.95) * shatter_amt, 0.0, 2.2);

  // Aspect-corrected centered coordinates with gentle beat zoom & rotation
  var p = (uv - vec2f(0.5)) * vec2f(asp, 1.0);
  let zoom = 1.0 - 0.08 * shatter_pulse - 0.05 * b_energy;
  let spin = sin(t * 0.22) * 0.14 + 0.035 * sin(br * 1.5707963);
  p = v_rot(p * zoom, spin);

  // Slow drift of the whole crystal field with music
  let drift_spd = p_drift();
  let scroll = vec2f(
    sin(t * 0.19 * drift_spd) * 0.45 + t * 0.08 * drift_spd,
    cos(t * 0.15 * drift_spd) * 0.45 - t * 0.05 * drift_spd
  );

  let scale = p_cells();
  let seed_time = t * (0.55 + 0.55 * drift_spd) + b_energy * 0.42 + mid_energy * 0.35;
  let wobble = clamp(energy * 0.9 + b_energy * 0.6, 0.0, 1.2);

  // Primary Voronoi cells
  let v1 = voronoi_exact(p * scale + scroll, seed_time, wobble);
  let cid1 = v_hash21(v1.cell_id);
  let cdir = normalize(v_hash22(v1.cell_id + vec2f(17.3, 9.1)) - vec2f(0.5) + vec2f(0.0001));

  // Per-cell beat shatter impulse: some cells react more strongly per beat-in-bar
  let beat_gate = smoothstep(0.15, 0.95, fract(cid1 * 3.7 + br * 0.25));
  let cell_shatter = shatter_pulse * (0.45 + 0.75 * beat_gate);

  // Sub-cell splitting: evaluate a finer Voronoi layer inside each cell, rotated per cell
  let sub_p = v_rot(v1.local + cdir * (cell_shatter * 0.16), cid1 * 6.2831853 + cell_shatter * 0.22);
  let sub_scale = 2.15 + 0.45 * floor(fract(cid1 * 13.7) * 2.0);
  let v2 = voronoi_exact(sub_p * sub_scale + v1.cell_id * 1.37, seed_time * 1.35, wobble * 0.8);
  let cid2 = v_hash21(v2.cell_id + v1.cell_id * 0.31);

  // Split visibility: cells crack apart on beats and high treble
  let split_vis = clamp(smoothstep(0.18, 0.85, cell_shatter + treble * 0.65), 0.0, 1.0);

  // Combine facet identity so sub-shards get slightly shifted color and tilt on shatter
  let shard_hash = fract(cid1 + split_vis * (cid2 - 0.5) * 0.26);
  let shard_local = mix(v1.local, v2.local * 0.65 + v1.local * 0.5, split_vis * 0.65);

  // Stained-glass / cracked-ice base color from palette
  let pal_t = fract(shard_hash * 0.88 + br * 0.07 + b_energy * 0.14 + t * 0.015);
  let glass_col = palette(pal_t);
  let ice_tint = mix(vec3f(0.58, 0.84, 1.0), vec3f(0.92, 0.97, 1.0), 0.45);
  let ice_mix = p_ice();

  // Simulated 3D crystal facet normal and moving specular light
  let tilt = (v_hash22(v1.cell_id + vec2f(3.1, 7.7)) - vec2f(0.5)) * (0.85 + 0.65 * cell_shatter);
  let sub_tilt = (v_hash22(v2.cell_id + vec2f(5.3, 2.9)) - vec2f(0.5)) * (0.75 * split_vis);
  let n_xy = shard_local * 0.75 + tilt + sub_tilt;
  let facet_n = normalize(vec3f(n_xy, 1.0));

  let light_ang = t * 0.65 + b_energy * 0.8;
  let light_dir = normalize(vec3f(cos(light_ang) * 0.65, sin(light_ang * 0.8) * 0.65, 0.85));
  let half_v = normalize(light_dir + vec3f(0.0, 0.0, 1.0));
  let diff = max(dot(facet_n, light_dir), 0.0);
  let spec = pow(max(dot(facet_n, half_v), 0.0), 14.0) * (0.45 + 1.35 * treble + 0.9 * cell_shatter);

  // Internal glass depth: darker translucent core, brighter refracted rim near edges
  let inner_rim = exp(-v1.edge * 6.5);
  let caustic = 0.5 + 0.5 * sin(dot(shard_local, vec2f(9.0, -7.0)) + t * 2.2 + cid1 * 6.2831);
  let facet_base = mix(glass_col, mix(glass_col, ice_tint, 0.48), ice_mix);

  // Audio-reactive body luminosity: clearly visible when quiet, dramatic swell on bass/rms
  let body_gain = 0.16 + 0.58 * energy + 0.52 * b_energy + 0.35 * beat_env * b_energy;
  let facet_shade = (0.38 + 0.62 * diff + 0.22 * caustic * (0.3 + mid_energy) + 0.42 * inner_rim) * body_gain;
  var col = facet_base * facet_shade;

  // Add crystalline specular glint on tilted shards
  col = col + mix(glass_col + vec3f(0.35), vec3f(0.95, 0.98, 1.0), 0.55 + 0.35 * ice_mix) * spec;

  // Dark stained-glass leading right inside the crack seam (gives crisp graphic contrast)
  let lead_width = 0.022 + 0.014 * cell_shatter;
  let lead_mask = 1.0 - smoothstep(lead_width * 0.4, lead_width * 1.4, v1.edge);
  col = col * (1.0 - 0.62 * lead_mask * (1.0 - 0.5 * ice_mix));

  // Treble-reactive primary edge glow
  let glow_param = p_edge_glow();
  let treble_drive = (0.28 + 2.25 * treble + 1.05 * on + 0.55 * b_energy) * glow_param;
  let edge_core = exp(-v1.edge * (36.0 - 10.0 * clamp(treble, 0.0, 1.0)));
  let edge_halo = exp(-v1.edge * (9.5 - 2.5 * clamp(energy, 0.0, 1.0)));
  let edge_col = mix(palette(fract(pal_t + 0.42)), vec3f(0.88, 0.96, 1.0), 0.38 + 0.42 * ice_mix);

  col = col + edge_col * edge_halo * treble_drive * 0.48;
  col = col + mix(edge_col, vec3f(1.0, 0.98, 1.0), 0.65) * edge_core * treble_drive * 0.95;

  // Beat-triggered sub-fracture cracks splitting cells apart
  let sub_core = exp(-v2.edge * 42.0);
  let sub_halo = exp(-v2.edge * 13.0);
  let crack_drive = split_vis * (0.45 + 1.85 * treble + 1.15 * cell_shatter) * glow_param;
  let crack_col = mix(palette(fract(pal_t + 0.65)), vec3f(0.92, 0.98, 1.0), 0.55);
  col = col + crack_col * (sub_halo * 0.35 + sub_core * 1.05) * crack_drive;

  // Subtle radial vignette so edges frame the center cleanly
  let vig = 1.0 - 0.28 * dot(uv - vec2f(0.5), uv - vec2f(0.5)) * 2.2;
  col = max(col * vig, vec3f(0.0));

  return vec4f(col, 1.0);
}
