// GPU particle physics for agy-cymatic-sand:
// Grains bounce out of Chladni / cymatic standing-wave antinodes, settle along pitch-driven
// nodal lines AND media edge contours, jolt on onsets, and re-form the picture on phrase turns.

struct Grain {
  pv: vec4f,   // xy: uv (0..1), zw: velocity
  col: vec4f,  // rgb: inherited media colour, w: excitation energy (0..2)
};

struct Sim {
  n: u32, mode: u32, seed: u32, jolt_hit: u32,
  aspect: f32, dt: f32, time: f32, reform_env: f32,
  bass: f32, mid: f32, hi: f32, rms: f32,
  kick: f32, beat: f32, react: f32, chladni: f32,
  edge_pull: f32, luma_warp: f32, vibrate: f32, jolt: f32,
  m0: f32, n0: f32, s0: f32, morph: f32,
  m1: f32, n1: f32, s1: f32, pitch_norm: f32,
  has_luma: f32, has_edges: f32, rot: f32, _pad0: f32,
};

@group(0) @binding(0) var<uniform> sim: Sim;
@group(0) @binding(1) var<storage, read_write> grains: array<Grain>;
@group(0) @binding(2) var smp: sampler;
@group(0) @binding(3) var tpic: texture_2d<f32>;
@group(0) @binding(4) var tluma: texture_2d<f32>;
@group(0) @binding(5) var tedges: texture_2d<f32>;

const PI: f32 = 3.14159265;

fn hash_u(x: u32) -> u32 {
  var v = x;
  v = v ^ (v >> 16u);
  v = v * 0x7feb352du;
  v = v ^ (v >> 15u);
  v = v * 0x846ca68bu;
  v = v ^ (v >> 16u);
  return v;
}

fn rand01(x: u32) -> f32 {
  return f32(hash_u(x) & 0x00ffffffu) / 16777216.0;
}

fn smp_luma(uv: vec2f) -> f32 {
  let c = clamp(uv, vec2f(0.002), vec2f(0.998));
  if (sim.has_luma > 0.5) {
    return clamp(textureSampleLevel(tluma, smp, c, 0.0).r, 0.0, 1.0);
  }
  let rgb = textureSampleLevel(tpic, smp, c, 0.0).rgb;
  return clamp(dot(rgb, vec3f(0.2126, 0.7152, 0.0722)), 0.0, 1.0);
}

fn smp_edge_mag(uv: vec2f) -> f32 {
  let c = clamp(uv, vec2f(0.002), vec2f(0.998));
  if (sim.has_edges > 0.5) {
    return clamp(length(textureSampleLevel(tedges, smp, c, 0.0).rg) * 1.45, 0.0, 1.8);
  }
  let eps = vec2f(0.004, 0.004);
  let gx = smp_luma(c + vec2f(eps.x, 0.0)) - smp_luma(c - vec2f(eps.x, 0.0));
  let gy = smp_luma(c + vec2f(0.0, eps.y)) - smp_luma(c - vec2f(0.0, eps.y));
  return clamp(length(vec2f(gx, gy)) * 5.0, 0.0, 1.8);
}

fn chladni_eval(p: vec2f, m: f32, n: f32, sgn: f32) -> f32 {
  let x = p.x * PI;
  let y = p.y * PI;
  return 0.5 * (cos(n * x) * cos(m * y) + sgn * cos(m * x) * cos(n * y));
}

fn dish_eval(p: vec2f, m: f32, n: f32, sgn: f32) -> f32 {
  let r = length(p);
  let a = atan2(p.y, p.x);
  let kr = (m + 1.5) * 1.45;
  let kang = max(2.0, floor(n + 1.0));
  let w1 = cos(kr * r * PI) * cos(kang * (a + sim.rot));
  let w2 = cos((kr + 1.15) * r * PI) * cos(max(1.0, kang - 1.0) * (a - sim.rot * 0.65));
  return 0.55 * w1 + 0.45 * sgn * w2;
}

fn dunes_eval(p: vec2f, m: f32, n: f32, sgn: f32) -> f32 {
  let ang = sim.rot * 0.7 + sgn * 0.45;
  let ca = cos(ang);
  let sa = sin(ang);
  let u = p.x * ca - p.y * sa;
  let v = p.x * sa + p.y * ca;
  let freq1 = (m + 2.2) * 1.65;
  let freq2 = (n + 1.8) * 1.35;
  let drift = sim.time * (0.9 + 0.8 * sim.bass);
  return 0.6 * sin(u * freq1 * PI - drift) * cos(v * (freq2 * 0.42) * PI)
       + 0.4 * sgn * cos((u + v * 0.6) * freq2 * PI + drift * 0.7);
}

fn standing_wave(uv: vec2f, lum: f32) -> f32 {
  // Centered aspect-aware plate coords, gently warped by media brightness
  let warp = (lum - 0.5) * sim.luma_warp * 0.24;
  let p = vec2f((uv.x - 0.5) * sim.aspect * 0.92, (uv.y - 0.5) * 1.04) + vec2f(warp, -warp * 0.8);
  var w0: f32;
  var w1: f32;
  if (sim.mode == 0u) {
    w0 = chladni_eval(p, sim.m0, sim.n0, sim.s0);
    w1 = chladni_eval(p, sim.m1, sim.n1, sim.s1);
  } else if (sim.mode == 1u) {
    w0 = dish_eval(p, sim.m0, sim.n0, sim.s0);
    w1 = dish_eval(p, sim.m1, sim.n1, sim.s1);
  } else {
    w0 = dunes_eval(p, sim.m0, sim.n0, sim.s0);
    w1 = dunes_eval(p, sim.m1, sim.n1, sim.s1);
  }
  return mix(w0, w1, sim.morph);
}

@compute @workgroup_size(256)
fn cs_init(@builtin(global_invocation_id) id: vec3u) {
  let i = id.x;
  if (i >= sim.n) { return; }
  let x = 0.02 + 0.96 * rand01(i * 3u + 17u);
  let y = 0.02 + 0.96 * rand01(i * 3u + 29u);
  let uv = vec2f(x, y);
  let rgb = max(textureSampleLevel(tpic, smp, uv, 0.0).rgb, vec3f(0.0));
  grains[i] = Grain(vec4f(x, y, 0.0, 0.0), vec4f(rgb, 0.2));
}

@compute @workgroup_size(256)
fn cs_step(@builtin(global_invocation_id) id: vec3u) {
  let i = id.x;
  if (i >= sim.n) { return; }

  var g = grains[i];
  var pos = g.pv.xy;
  var vel = g.pv.zw;
  var col = g.col.rgb;
  var energy = g.col.w;

  let lum = smp_luma(pos);
  let emC = smp_edge_mag(pos);

  // Audio activity: gentle calm contour settling on quiet, vigorous cymatic vibration on music
  let audio_lvl = clamp(sim.rms * 1.45 + sim.bass * 1.15 + sim.mid * 0.75 + sim.kick * 1.1, 0.0, 2.5);
  let act = smoothstep(0.025, 0.25, audio_lvl) * sim.react;
  let reform = sim.reform_env;

  // 1) Standing-wave Chladni potential |W|: gradient pushes grains downhill onto nodal lines (W = 0)
  let eps = 0.0045;
  let wC = standing_wave(pos, lum);
  let wR = standing_wave(pos + vec2f(eps, 0.0), lum);
  let wU = standing_wave(pos + vec2f(0.0, eps), lum);
  let aC = abs(wC);
  let grad_a = vec2f(abs(wR) - aC, abs(wU) - aC) / eps;

  // 2) Media edge-contour valleys: grains are drawn into strong edges of the picture
  let eEps = 0.008;
  let emR = smp_edge_mag(pos + vec2f(eEps, 0.0));
  let emL = smp_edge_mag(pos - vec2f(eEps, 0.0));
  let emD = smp_edge_mag(pos + vec2f(0.0, eEps));
  let emU = smp_edge_mag(pos - vec2f(0.0, eEps));
  let grad_edge = vec2f(emR - emL, emD - emU) / (2.0 * eEps);

  // During phrase re-formation, boost picture edge + luma settling and quiet the Chladni bounce
  let chladni_w = sim.chladni * (0.28 + 0.95 * act) * (1.0 - 0.72 * reform);
  let edge_w = sim.edge_pull * (0.45 + 0.65 * act + 1.25 * reform);

  var force = -grad_a * (0.042 * chladni_w) + grad_edge * (0.016 * edge_w);

  // Subtle pull toward bright image features during re-formation so the photo crystallizes cleanly
  if (reform > 0.05) {
    let lR = smp_luma(pos + vec2f(eEps, 0.0));
    let lL = smp_luma(pos - vec2f(eEps, 0.0));
    let lD = smp_luma(pos + vec2f(0.0, eEps));
    let lU = smp_luma(pos - vec2f(0.0, eEps));
    force += vec2f(lR - lL, lD - lU) * (0.14 * reform);
  }

  // Edge groove damping: sand resting on a strong media edge OR crisp Chladni node stays calmer
  let settled = clamp((1.0 - smoothstep(0.02, 0.22, aC)) * 0.65 + smoothstep(0.18, 0.75, emC) * 0.55, 0.0, 0.92);

  // 3) Acoustic plate vibration: antinodes bounce grains vigorously with bass/mids/kick!
  let h0 = rand01(i * 17u + sim.seed * 31u + 1u);
  let h1 = rand01(i * 17u + sim.seed * 31u + 7u);
  let ang = h0 * 6.283185;
  let jit_dir = vec2f(cos(ang), sin(ang));

  let vib_drive = sim.vibrate * (0.04 + (0.55 * sim.bass + 0.42 * sim.mid + 0.35 * sim.hi + 0.85 * sim.kick) * act)
                * (1.0 - 0.8 * reform);
  let antinode_kick = (0.14 + 1.45 * aC) * (1.0 - 0.55 * settled);
  force += jit_dir * (vib_drive * antinode_kick * (0.45 + 0.8 * h1) * 0.52);

  // 4) Onset jolt: launches grains in crisp radial + turbulent bursts across the plate!
  if (sim.jolt_hit > 0u && sim.jolt > 0.001 && act > 0.05) {
    let blast_dir = normalize(jit_dir + (pos - vec2f(0.5)) * 0.55 + vec2f(1e-4, 0.0));
    let jolt_str = sim.jolt * (0.045 + 0.095 * aC + 0.05 * sim.bass) * act * (1.0 - 0.65 * reform);
    vel += blast_dir * jolt_str * (0.4 + 0.9 * h1);
    energy = min(2.0, energy + 0.75 + 0.65 * aC);
  }

  // Integrate velocity with realistic plate friction (higher friction on quiet / settled nodes)
  let friction = mix(0.84, 0.70, settled * (0.4 + 0.6 * reform));
  vel = (vel + force * sim.dt) * friction;

  // Clamp velocity to avoid runaway particles
  let sp = length(vel);
  if (sp > 0.045) {
    vel = vel * (0.045 / sp);
  }

  // Aspect-corrected position update
  pos = pos + vec2f(vel.x / max(sim.aspect, 0.5), vel.y);

  // Soft elastic reflection at plate walls + tiny respawn if trapped at border
  if (pos.x < 0.008) { pos.x = 0.008; vel.x = abs(vel.x) * 0.65; }
  if (pos.x > 0.992) { pos.x = 0.992; vel.x = -abs(vel.x) * 0.65; }
  if (pos.y < 0.008) { pos.y = 0.008; vel.y = abs(vel.y) * 0.65; }
  if (pos.y > 0.992) { pos.y = 0.992; vel.y = -abs(vel.y) * 0.65; }

  // Small fraction of grains gently re-seed across the picture so empty corners never starve
  let r_reseed = rand01(i * 43u + sim.seed * 13u + 3u);
  if (r_reseed < (0.0025 + 0.014 * reform + 0.004 * sim.kick * act)) {
    pos = vec2f(0.02 + 0.96 * rand01(i * 19u + sim.seed + 5u), 0.02 + 0.96 * rand01(i * 23u + sim.seed + 11u));
    vel = vec2f(0.0);
  }

  // Inherit live picture colour at the grain's position
  let pic_rgb = max(textureSampleLevel(tpic, smp, pos, 0.0).rgb, vec3f(0.0));
  col = mix(col, pic_rgb, 0.16 + 0.25 * reform);

  // Excitation energy tracks grain speed + antinode agitation + onset glow
  let target_e = clamp(sp * 38.0 + aC * act * 0.45 + emC * 0.22 * sim.beat, 0.0, 1.8);
  energy = mix(energy, target_e, 0.14);

  grains[i] = Grain(vec4f(pos, vel), vec4f(col, energy));
}
