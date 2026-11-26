struct U {
  dims: vec4f,
  sim: vec4f,
  fx: vec4f,            // sheen, glow, warm, step_idx
  audio: vec4f,         // time, rms, bass, kick
  audio2: vec4f,        // mid, high, phase, onset
  burst: vec4f,
  pal: array<vec4f, 8>,
  pal_n: vec4f,
};

@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var<storage, read> dye: array<vec4f>;
@group(0) @binding(2) var<storage, read> vel: array<vec2f>;

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

fn idx(x: i32, y: i32) -> u32 {
  let w = i32(u.dims.x);
  let h = i32(u.dims.y);
  let wx = ((x % w) + w) % w;
  let wy = ((y % h) + h) % h;
  return u32(wy * w + wx);
}

fn sample_dye(fx: f32, fy: f32) -> vec4f {
  let w = u.dims.x;
  let h = u.dims.y;
  let x = fx - floor(fx / w) * w;
  let y = fy - floor(fy / h) * h;
  let x0 = i32(floor(x));
  let y0 = i32(floor(y));
  let tx = x - f32(x0);
  let ty = y - f32(y0);
  return mix(
    mix(dye[idx(x0, y0)], dye[idx(x0 + 1, y0)], tx),
    mix(dye[idx(x0, y0 + 1)], dye[idx(x0 + 1, y0 + 1)], tx),
    ty
  );
}

fn sample_vel(fx: f32, fy: f32) -> vec2f {
  let w = u.dims.x;
  let h = u.dims.y;
  let x = fx - floor(fx / w) * w;
  let y = fy - floor(fy / h) * h;
  let x0 = i32(floor(x));
  let y0 = i32(floor(y));
  let tx = x - f32(x0);
  let ty = y - f32(y0);
  return mix(
    mix(vel[idx(x0, y0)], vel[idx(x0 + 1, y0)], tx),
    mix(vel[idx(x0, y0 + 1)], vel[idx(x0 + 1, y0 + 1)], tx),
    ty
  );
}

@fragment
fn fs_render(v: VOut) -> @location(0) vec4f {
  let w = u.dims.x;
  let h = u.dims.y;
  let fx = v.uv.x * w - 0.5;
  let fy = v.uv.y * h - 0.5;

  let d = sample_dye(fx, fy);
  let dx = sample_dye(fx + 1.0, fy).w - sample_dye(fx - 1.0, fy).w;
  let dy = sample_dye(fx, fy + 1.0).w - sample_dye(fx, fy - 1.0).w;
  let vel_c = sample_vel(fx, fy);
  let spd = length(vel_c);

  let t = u.audio.x;
  let rms = u.audio.y;
  let bass = u.audio.z;
  let kick = u.audio.w;
  let high = u.audio2.y;
  let sheen = u.fx.x;
  let glow = u.fx.y;

  // velvet/silk surface shading from smoke density gradient + shear speed
  let n = normalize(vec3f(-dx * 4.5, -dy * 4.5, 1.0));
  let ldir = normalize(vec3f(cos(t * 0.35) * 0.65, sin(t * 0.42) * 0.65, 0.85));
  let rim = pow(clamp(1.0 - n.z, 0.0, 1.0), 1.6);
  let spec = pow(max(dot(n, normalize(ldir + vec3f(0.0, 0.0, 1.0))), 0.0001), 16.0);

  let asp = u.dims.z / max(u.dims.w, 1.0);
  let p = (v.uv - 0.5) * vec2f(asp, 1.0);
  let rad = length(p);

  let bg = pal(0.04) * (0.04 + 0.05 * exp(-rad * 1.4)) * (0.8 + 0.35 * rms);
  let body = d.rgb * glow * (0.88 + 0.35 * bass + 0.28 * kick);
  let silk_col = pal(fract(0.72 + spd * 0.18 + t * 0.03));
  let silk = silk_col * (rim * 0.65 + spec * (0.28 + 0.65 * high) * smoothstep(0.08, 0.6, d.w)) * sheen;
  let shear_glow = pal(fract(0.45 + spd * 0.25)) * smoothstep(0.6, 3.2, spd) * (0.14 + 0.22 * kick) * smoothstep(0.05, 0.35, d.w);

  var col = bg + body + silk + shear_glow;
  col = col * (1.0 - 0.22 * smoothstep(0.65, 1.38, rad));
  col = clamp(col, vec3f(0.0), vec3f(3.2));
  return vec4f(col, 1.0);
}
