// 2D Shallow-water wave tank compute simulation driven by picked media (luma depth,
// edge coastlines & emitters) and audio (onset pebbles, bass swells, pitch harmonics).

struct Sim {
  w: u32, h: u32, mode: u32, drop_count: u32,
  aspect: f32, c2: f32, damp: f32, edge_wall: f32,
  bass: f32, mid: f32, hi: f32, rms: f32,
  kick: f32, beat: f32, time: f32, pitch_freq: f32,
  has_luma: f32, has_edges: f32, reform_env: f32, swell: f32,
  edge_emit: f32, react: f32, step_frac: f32, _pad0: f32,
  drops: array<vec4f, 8>,
};

@group(0) @binding(0) var<uniform> sim: Sim;
@group(0) @binding(1) var<storage, read> src: array<vec4f>;
@group(0) @binding(2) var<storage, read_write> dst: array<vec4f>;
@group(0) @binding(3) var smp: sampler;
@group(0) @binding(4) var tpic: texture_2d<f32>;
@group(0) @binding(5) var tluma: texture_2d<f32>;
@group(0) @binding(6) var tedges: texture_2d<f32>;

fn idx(x: i32, y: i32) -> u32 {
  let cx = clamp(x, 0, i32(sim.w) - 1);
  let cy = clamp(y, 0, i32(sim.h) - 1);
  return u32(cy) * sim.w + u32(cx);
}

fn sample_luma(uv: vec2f) -> f32 {
  if (sim.has_luma > 0.5) {
    return clamp(textureSampleLevel(tluma, smp, uv, 0.0).r, 0.0, 1.0);
  }
  let c = textureSampleLevel(tpic, smp, uv, 0.0).rgb;
  return clamp(dot(c, vec3f(0.2126, 0.7152, 0.0722)), 0.0, 1.0);
}

fn sample_edge(uv: vec2f) -> vec2f {
  if (sim.has_edges > 0.5) {
    return textureSampleLevel(tedges, smp, uv, 0.0).rg;
  }
  let dx = vec2f(1.0 / f32(sim.w), 0.0);
  let dy = vec2f(0.0, 1.0 / f32(sim.h));
  let gx = sample_luma(uv + dx) - sample_luma(uv - dx);
  let gy = sample_luma(uv + dy) - sample_luma(uv - dy);
  return vec2f(gx, gy) * 3.0;
}

@compute @workgroup_size(16, 16)
fn cs_init(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= sim.w || id.y >= sim.h) { return; }
  let uv = (vec2f(id.xy) + 0.5) / vec2f(f32(sim.w), f32(sim.h));
  let lum = sample_luma(uv);
  let h0 = (lum - 0.5) * 0.08;
  dst[id.y * sim.w + id.x] = vec4f(h0, h0, 0.0, 0.0);
}

@compute @workgroup_size(16, 16)
fn cs_step(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= sim.w || id.y >= sim.h) { return; }
  let x = i32(id.x);
  let y = i32(id.y);
  let uv = (vec2f(id.xy) + 0.5) / vec2f(f32(sim.w), f32(sim.h));
  let k = id.y * sim.w + id.x;

  let cur = src[k];
  let hC = cur.x;
  let hPrev = cur.y;

  // Isotropic 9-point Laplacian for clean circular wave fronts
  let hL = src[idx(x - 1, y)].x;
  let hR = src[idx(x + 1, y)].x;
  let hU = src[idx(x, y - 1)].x;
  let hD = src[idx(x, y + 1)].x;
  let hUL = src[idx(x - 1, y - 1)].x;
  let hUR = src[idx(x + 1, y - 1)].x;
  let hDL = src[idx(x - 1, y + 1)].x;
  let hDR = src[idx(x + 1, y + 1)].x;

  let lap = (hL + hR + hU + hD) * 0.20 + (hUL + hUR + hDL + hDR) * 0.05 - hC;

  // Media shapes the optical/fluid medium: luma = depth (wave speed), edges = reflective coastline
  let lum = sample_luma(uv);
  let ev = sample_edge(uv);
  let em = clamp(length(ev) * 1.4, 0.0, 1.5);

  let depth_mod = mix(0.62, 1.24, lum);
  let wall_mod = mix(1.0, 0.28, clamp(em * sim.edge_wall, 0.0, 0.85));
  let c2_loc = clamp(sim.c2 * depth_mod * wall_mod, 0.03, 0.39);

  // Extra gentle damping during phrase re-formation and at tank boundaries
  let edge_dist = min(min(uv.x, 1.0 - uv.x), min(uv.y, 1.0 - uv.y));
  let border_damp = smoothstep(0.06, 0.0, edge_dist) * 0.055;
  let reform_damp = sim.reform_env * 0.14;
  let d = clamp(sim.damp + border_damp + reform_damp + em * sim.edge_wall * 0.012, 0.004, 0.32);

  var vel = (hC - hPrev) * (1.0 - d);
  var hNext = hC + vel + c2_loc * lap;

  // Apply pebble drops on the first substep of the tick
  if (sim.step_frac < 0.5 && sim.drop_count > 0u) {
    for (var i = 0u; i < sim.drop_count; i = i + 1u) {
      let dr = sim.drops[i];
      let delta = vec2f((uv.x - dr.x) * sim.aspect, uv.y - dr.y);
      let r2 = dot(delta, delta);
      let rad = max(dr.z, 0.008);
      let q = r2 / (rad * rad);
      if (q < 6.0) {
        // Mexican-hat pebble impulse: central depression + raised splash ring
        let splash = (1.0 - 0.65 * q) * exp(-q * 1.15);
        hNext = hNext + dr.w * splash * (1.0 - 0.55 * sim.reform_env);
      }
    }
  }

  // Audio-driven tank forcing (active when music plays; calm on silence)
  let energy = sim.rms + 0.85 * sim.bass + 0.6 * sim.kick;
  let quiet_calm = smoothstep(0.02, 0.14, energy);
  let act = (1.0 - 0.82 * sim.reform_env) * sim.react * quiet_calm;

  // 1) Media edge contours emit subtle standing ripples on bass and beat hits
  if (sim.edge_emit > 0.001 && em > 0.08) {
    let phase_wave = sin(sim.time * (5.5 + 3.5 * sim.pitch_freq) + lum * 6.28318);
    hNext = hNext + em * phase_wave * (0.018 * sim.bass + 0.028 * sim.kick + 0.012 * sim.beat * sim.mid) * sim.edge_emit * act;
  }

  // 2) Bass swell & harmonic standing wave emitters
  if (sim.swell > 0.001) {
    let p = vec2f((uv.x - 0.5) * sim.aspect, uv.y - 0.5);
    if (sim.mode == 2u) {
      // Interferometer mode: twin/quad pitch-tuned coherent oscillators
      let ang = sim.time * 0.38 + sim.bass * 0.8;
      let sep = 0.28 + 0.12 * sin(sim.time * 0.6);
      let e1 = vec2f(cos(ang), sin(ang)) * sep;
      let e2 = -e1;
      let e3 = vec2f(-sin(ang), cos(ang)) * (sep * 0.85);
      let r1 = length(p - e1);
      let r2 = length(p - e2);
      let r3 = length(p - e3);
      let freq = 26.0 + 34.0 * sim.pitch_freq;
      let osc = sin(sim.time * (8.0 + 10.0 * sim.pitch_freq) - r1 * freq) * exp(-r1 * 2.2)
              + sin(sim.time * (8.0 + 10.0 * sim.pitch_freq) - r2 * freq) * exp(-r2 * 2.2)
              + 0.7 * sin(sim.time * (10.0 + 12.0 * sim.pitch_freq) - r3 * (freq * 1.15)) * exp(-r3 * 2.4);
      hNext = hNext + osc * (0.024 * sim.bass + 0.02 * sim.mid + 0.032 * sim.kick) * sim.swell * act;
    } else {
      // Ripple tank & prism modes: bass-pumped tank boundary wave + capillary highs
      let wall_s = smoothstep(0.08, 0.0, edge_dist);
      let bwave = sin(sim.time * 6.5 + (p.x * 7.0 + p.y * 5.0)) * wall_s;
      let center_r = length(p);
      let ring_pulse = sin(center_r * (18.0 + 14.0 * sim.pitch_freq) - sim.time * 9.0) * exp(-center_r * 2.6);
      hNext = hNext + (bwave * 0.035 * sim.bass + ring_pulse * 0.018 * (sim.bass + sim.beat * 0.7)) * sim.swell * act;
    }
  }

  // Soft clamp for unconditional numerical stability
  hNext = clamp(hNext, -2.4, 2.4);

  // Track smoothed caustic / crest energy and capillary excitation for rendering
  let slope = abs(hR - hL) + abs(hD - hU);
  let caustic_inst = clamp(max(0.0, -lap) * 6.5 + slope * 1.4, 0.0, 2.5);
  let energy_acc = mix(cur.z, caustic_inst, 0.24);
  let cap_acc = mix(cur.w, clamp(abs(hNext - hC) * 4.5 + sim.hi * slope * 2.2, 0.0, 2.5), 0.22);

  dst[k] = vec4f(hNext, hC, energy_acc, cap_acc);
}
