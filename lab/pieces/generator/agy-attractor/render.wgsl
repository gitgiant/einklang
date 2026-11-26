struct Particle {
  pos_age: vec4f,
  vel_seed: vec4f,
};

struct U {
  vp: mat4x4f,
  sim: vec4f,           // count, attractor_idx, speed, chaos
  draw: vec4f,          // streak, size, glow, aspect
  audio: vec4f,         // time, rms, bass, kick
  audio2: vec4f,        // mid, high, phase, onset
  extra: vec4f,         // tick_mod, warm, res_x, res_y
  pal: array<vec4f, 8>,
  pal_n: vec4f,
};

@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var<storage, read> parts: array<Particle>;

fn oklab_lin(c: vec3f) -> vec3f {
  let l_ = c.x + 0.3963377774 * c.y + 0.2158037573 * c.z;
  let m_ = c.x - 0.1055613458 * c.y - 0.0638541728 * c.z;
  let s_ = c.x - 0.0894841775 * c.y - 1.291485548 * c.z;
  let l = l_ * l_ * l_; let m = m_ * m_ * m_; let s = s_ * s_ * s_;
  return max(vec3f(0.0), vec3f(
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s
  ));
}

fn pal(x: f32) -> vec3f {
  let n = max(i32(u.pal_n.x), 1);
  let f = clamp(x, 0.0, 1.0) * f32(n - 1);
  let i = min(i32(floor(f)), n - 1);
  let j = min(i + 1, n - 1);
  return oklab_lin(mix(u.pal[i].xyz, u.pal[j].xyz, f - f32(i)));
}

fn norm_pos(p: vec3f, kind: i32) -> vec3f {
  if (kind == 0) {
    return (p - vec3f(0.0, 0.0, 0.45)) * 0.68;
  } else if (kind == 1) {
    return p * 0.28;
  } else if (kind == 2) {
    return p * 0.115;
  } else {
    return (p + vec3f(1.4, 1.4, 1.4)) * 0.11;
  }
}

fn norm_scale(kind: i32) -> f32 {
  if (kind == 0) { return 0.68; }
  if (kind == 1) { return 0.28; }
  if (kind == 2) { return 0.115; }
  return 0.11;
}

@fragment
fn fs_bg(v: VOut) -> @location(0) vec4f {
  let asp = u.draw.w;
  let p = (v.uv - 0.5) * vec2f(asp, 1.0);
  let r = length(p);
  let t = u.audio.x;
  let rms = u.audio.y;
  let bass = u.audio.z;
  let kick = u.audio.w;

  let halo = exp(-r * r * (3.2 - 0.9 * bass));
  let dr = (r - 0.34 - 0.08 * kick) / 0.14;
  let ring = exp(-(dr * dr)) * (0.25 + 0.55 * kick);
  let c0 = pal(0.06) * 0.035;
  let c1 = pal(fract(0.22 + t * 0.02)) * halo * (0.09 + 0.14 * rms + 0.12 * bass);
  let c2 = pal(fract(0.68 + t * 0.02)) * ring * 0.10;
  return vec4f(clamp(c0 + c1 + c2, vec3f(0.0), vec3f(0.8)), 1.0);
}

struct POut {
  @builtin(position) pos: vec4f,
  @location(0) local: vec2f,
  @location(1) col: vec3f,
};

@vertex
fn vs_part(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> POut {
  let pt = parts[ii];
  let kind = i32(round(u.sim.y));
  let wp = norm_pos(pt.pos_age.xyz, kind);
  let wv = pt.vel_seed.xyz * norm_scale(kind);
  let age = pt.pos_age.w;
  let seed = pt.vel_seed.w;

  let asp = u.draw.w;
  let bass = u.audio.z;
  let kick = u.audio.w;
  let high = u.audio2.y;

  let c0 = u.vp * vec4f(wp, 1.0);
  let c1 = u.vp * vec4f(wp + wv * (0.024 * u.draw.x * (0.85 + 0.7 * bass + 0.5 * kick)), 1.0);

  var o: POut;
  if (c0.w <= 0.15 || c1.w <= 0.15) {
    o.pos = vec4f(2.0, 2.0, 0.0, 1.0);
    o.local = vec2f(0.0);
    o.col = vec3f(0.0);
    return o;
  }

  let ndc0 = c0.xy / c0.w;
  let ndc1 = c1.xy / c1.w;
  // work in aspect-corrected screen space so filaments stay round & uniform
  var d = (ndc1 - ndc0) * vec2f(asp, 1.0);
  let dlen = length(d);
  let dir = select(vec2f(1.0, 0.0), d / dlen, dlen > 0.0002);
  let perp = vec2f(-dir.y, dir.x);

  let depth_s = clamp(1.75 / c0.w, 0.25, 1.65);
  let half_w = clamp(0.0046 * u.draw.y * depth_s * (0.75 + 0.55 * seed + 0.35 * kick), 0.0018, 0.018);
  let half_l = clamp(max(half_w * 1.4, dlen * 0.65), half_w * 1.4, 0.095);

  var corners = array<vec2f, 6>(
    vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0),
    vec2f(-1.0, -1.0), vec2f(1.0, 1.0), vec2f(-1.0, 1.0)
  );
  let q = corners[vi];
  let off = (dir * (q.x * half_l) + perp * (q.y * half_w)) / vec2f(asp, 1.0);
  let mid_ndc = (ndc0 + ndc1) * 0.5;
  o.pos = vec4f(mid_ndc + off, 0.0, 1.0);
  o.local = q;

  let spd = clamp(length(wv) * 0.35, 0.0, 1.0);
  let fade = smoothstep(0.0, 0.08, age) * smoothstep(1.0, 0.82, age);
  let fresh = exp(-age * 9.0) * (0.7 + 1.4 * kick);
  let pal_t = fract(spd * 0.65 + (wp.z + wp.y) * 0.22 + seed * 0.2 + u.audio.x * 0.025);
  let depth_fade = clamp(1.25 / (0.55 + c0.w * 0.45), 0.3, 1.35);
  let intensity = (0.085 + 0.075 * spd + 0.065 * high + 0.09 * fresh) * u.draw.z * fade * depth_fade;
  o.col = mix(pal(pal_t), pal(0.95), fresh * 0.45) * intensity;
  return o;
}

@fragment
fn fs_part(v: POut) -> @location(0) vec4f {
  // soft capsule falloff for smooth luminous streaks
  let r2 = v.local.x * v.local.x + v.local.y * v.local.y;
  if (r2 > 1.0) { discard; }
  let g = exp(-r2 * 4.2) * (1.0 - r2);
  let col = clamp(v.col * g, vec3f(0.0), vec3f(1.8));
  return vec4f(col, 1.0);
}
