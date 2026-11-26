struct U {
  dims: vec4f,          // sim_w, sim_h, out_w, out_h
  sim: vec4f,           // vorticity, force, decay, vel_decay
  fx: vec4f,            // sheen, glow, warm, step_idx
  audio: vec4f,         // time, rms, bass, kick
  audio2: vec4f,        // mid, high, phase, onset
  burst: vec4f,         // burst_ang, burst_amt, bar, 0
  pal: array<vec4f, 8>, // OKLab stops
  pal_n: vec4f,         // count, 0, 0, 0
};

@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var<storage, read> vel_in: array<vec2f>;
@group(0) @binding(2) var<storage, read_write> vel_out: array<vec2f>;
@group(0) @binding(3) var<storage, read> dye_in: array<vec4f>;
@group(0) @binding(4) var<storage, read_write> dye_out: array<vec4f>;
@group(0) @binding(5) var<storage, read> pres_in: array<f32>;
@group(0) @binding(6) var<storage, read_write> pres_out: array<f32>;
@group(0) @binding(7) var<storage, read_write> aux: array<f32>; // curl or divergence

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

fn bilerp_vel(fx: f32, fy: f32) -> vec2f {
  let w = u.dims.x;
  let h = u.dims.y;
  let x = fx - floor(fx / w) * w;
  let y = fy - floor(fy / h) * h;
  let x0 = i32(floor(x));
  let y0 = i32(floor(y));
  let tx = x - f32(x0);
  let ty = y - f32(y0);
  let a = vel_in[idx(x0, y0)];
  let b = vel_in[idx(x0 + 1, y0)];
  let c = vel_in[idx(x0, y0 + 1)];
  let d = vel_in[idx(x0 + 1, y0 + 1)];
  return mix(mix(a, b, tx), mix(c, d, tx), ty);
}

fn bilerp_dye(fx: f32, fy: f32) -> vec4f {
  let w = u.dims.x;
  let h = u.dims.y;
  let x = fx - floor(fx / w) * w;
  let y = fy - floor(fy / h) * h;
  let x0 = i32(floor(x));
  let y0 = i32(floor(y));
  let tx = x - f32(x0);
  let ty = y - f32(y0);
  let a = dye_in[idx(x0, y0)];
  let b = dye_in[idx(x0 + 1, y0)];
  let c = dye_in[idx(x0, y0 + 1)];
  let d = dye_in[idx(x0 + 1, y0 + 1)];
  return mix(mix(a, b, tx), mix(c, d, tx), ty);
}

@compute @workgroup_size(8, 8)
fn cs_clear(@builtin(global_invocation_id) gid: vec3u) {
  let w = u32(u.dims.x);
  let h = u32(u.dims.y);
  if (gid.x >= w || gid.y >= h) { return; }
  let i = gid.y * w + gid.x;
  vel_out[i] = vec2f(0.0);
  dye_out[i] = vec4f(0.0);
  pres_out[i] = 0.0;
  aux[i] = 0.0;
}

@compute @workgroup_size(8, 8)
fn cs_splat(@builtin(global_invocation_id) gid: vec3u) {
  let w = u32(u.dims.x);
  let h = u32(u.dims.y);
  if (gid.x >= w || gid.y >= h) { return; }
  let i = gid.y * w + gid.x;
  let uv = (vec2f(gid.xy) + 0.5) / u.dims.xy;
  let asp = u.dims.x / u.dims.y;
  let p = (uv - 0.5) * vec2f(asp, 1.0);

  let t = u.audio.x;
  let rms = u.audio.y;
  let bass = u.audio.z;
  let kick = u.audio.w;
  let mid = u.audio2.x;
  let high = u.audio2.y;
  let force = u.sim.y;

  var v = vel_in[i];
  var d = dye_in[i];

  // 3 orbiting harmonic fluid emitters pouring contrasting OKLab dye plumes
  for (var k = 0; k < 3; k++) {
    let kf = f32(k);
    let ang = t * (0.42 + 0.11 * kf) + kf * 2.0943951 + mid * 0.45;
    let rad = 0.24 + 0.11 * sin(t * 0.65 + kf * 1.9);
    let pos = vec2f(cos(ang) * 1.25, sin(ang) * 0.85) * rad;
    let diff = p - pos;
    let r2 = dot(diff, diff);
    let g = exp(-r2 / (0.0028 + 0.0022 * bass));

    // tangential + inward swirling jet direction
    let jang = ang + 1.85 + 0.55 * sin(t * 0.9 + kf * 2.1);
    let jdir = vec2f(cos(jang), sin(jang));
    let thrust = (1.15 + 2.4 * bass + 1.4 * rms + 1.6 * kick) * force;
    v = v + jdir * (g * thrust);

    let col = pal(fract(kf / 3.0 + t * 0.04 + high * 0.12));
    let dye_amt = g * (0.14 + 0.22 * rms + 0.18 * bass);
    d = vec4f(d.rgb + col * dye_amt, d.w + dye_amt);
  }

  // dramatic opposing dipole collision jets on audio onsets
  if (u.burst.y > 0.01) {
    let ba = u.burst.x;
    let dir = vec2f(cos(ba), sin(ba));
    let e1 = -dir * vec2f(0.46, 0.32);
    let e2 = dir * vec2f(0.46, 0.32);
    let g1 = exp(-dot(p - e1, p - e1) / 0.0055);
    let g2 = exp(-dot(p - e2, p - e2) / 0.0055);
    let imp = u.burst.y * force * 3.8;
    v = v + dir * (g1 * imp) - dir * (g2 * imp);
    let c1 = pal(fract(0.18 + u.burst.z * 0.25));
    let c2 = pal(fract(0.68 + u.burst.z * 0.25));
    d = vec4f(d.rgb + (c1 * g1 + c2 * g2) * (0.34 * u.burst.y), d.w + (g1 + g2) * 0.34 * u.burst.y);
  }

  vel_out[i] = clamp(v, vec2f(-6.0), vec2f(6.0));
  dye_out[i] = clamp(d, vec4f(0.0), vec4f(3.2));
}

@compute @workgroup_size(8, 8)
fn cs_curl(@builtin(global_invocation_id) gid: vec3u) {
  let w = u32(u.dims.x);
  let h = u32(u.dims.y);
  if (gid.x >= w || gid.y >= h) { return; }
  let x = i32(gid.x);
  let y = i32(gid.y);
  let vL = vel_in[idx(x - 1, y)].y;
  let vR = vel_in[idx(x + 1, y)].y;
  let vB = vel_in[idx(x, y - 1)].x;
  let vT = vel_in[idx(x, y + 1)].x;
  aux[gid.y * w + gid.x] = 0.5 * ((vR - vL) - (vT - vB));
}

@compute @workgroup_size(8, 8)
fn cs_vorticity(@builtin(global_invocation_id) gid: vec3u) {
  let w = u32(u.dims.x);
  let h = u32(u.dims.y);
  if (gid.x >= w || gid.y >= h) { return; }
  let x = i32(gid.x);
  let y = i32(gid.y);
  let i = gid.y * w + gid.x;

  let cL = abs(aux[idx(x - 1, y)]);
  let cR = abs(aux[idx(x + 1, y)]);
  let cB = abs(aux[idx(x, y - 1)]);
  let cT = abs(aux[idx(x, y + 1)]);
  let cC = aux[i];

  var grad = vec2f(cR - cL, cT - cB) * 0.5;
  let len = length(grad) + 0.0002;
  grad = grad / len;
  let force = vec2f(grad.y, -grad.x) * cC * u.sim.x * (0.75 + 0.85 * u.audio.z + 0.45 * u.audio2.y) * 0.14;
  vel_out[i] = clamp(vel_in[i] + force, vec2f(-6.0), vec2f(6.0));
}

@compute @workgroup_size(8, 8)
fn cs_divergence(@builtin(global_invocation_id) gid: vec3u) {
  let w = u32(u.dims.x);
  let h = u32(u.dims.y);
  if (gid.x >= w || gid.y >= h) { return; }
  let x = i32(gid.x);
  let y = i32(gid.y);
  let i = gid.y * w + gid.x;
  let uL = vel_in[idx(x - 1, y)].x;
  let uR = vel_in[idx(x + 1, y)].x;
  let vB = vel_in[idx(x, y - 1)].y;
  let vT = vel_in[idx(x, y + 1)].y;
  aux[i] = 0.5 * ((uR - uL) + (vT - vB));
  pres_out[i] = 0.0;
}

@compute @workgroup_size(8, 8)
fn cs_jacobi(@builtin(global_invocation_id) gid: vec3u) {
  let w = u32(u.dims.x);
  let h = u32(u.dims.y);
  if (gid.x >= w || gid.y >= h) { return; }
  let x = i32(gid.x);
  let y = i32(gid.y);
  let i = gid.y * w + gid.x;
  let pL = pres_in[idx(x - 1, y)];
  let pR = pres_in[idx(x + 1, y)];
  let pB = pres_in[idx(x, y - 1)];
  let pT = pres_in[idx(x, y + 1)];
  let div = aux[i];
  pres_out[i] = clamp(0.25 * (pL + pR + pB + pT - div), -12.0, 12.0);
}

@compute @workgroup_size(8, 8)
fn cs_project(@builtin(global_invocation_id) gid: vec3u) {
  let w = u32(u.dims.x);
  let h = u32(u.dims.y);
  if (gid.x >= w || gid.y >= h) { return; }
  let x = i32(gid.x);
  let y = i32(gid.y);
  let i = gid.y * w + gid.x;
  let pL = pres_in[idx(x - 1, y)];
  let pR = pres_in[idx(x + 1, y)];
  let pB = pres_in[idx(x, y - 1)];
  let pT = pres_in[idx(x, y + 1)];
  let v = vel_in[i] - 0.5 * vec2f(pR - pL, pT - pB);
  vel_out[i] = clamp(v, vec2f(-6.0), vec2f(6.0));
}

@compute @workgroup_size(8, 8)
fn cs_advect(@builtin(global_invocation_id) gid: vec3u) {
  let w = u32(u.dims.x);
  let h = u32(u.dims.y);
  if (gid.x >= w || gid.y >= h) { return; }
  let i = gid.y * w + gid.x;
  let v = vel_in[i];
  let dt = 0.88;
  let back_x = f32(gid.x) - v.x * dt;
  let back_y = f32(gid.y) - v.y * dt;

  vel_out[i] = clamp(bilerp_vel(back_x, back_y) * u.sim.w, vec2f(-6.0), vec2f(6.0));

  var d = bilerp_dye(back_x, back_y) * u.sim.z;
  // soft saturation knee keeps rich color separation even on dense audio
  let peak = max(d.r, max(d.g, d.b));
  let knee = 1.0 / (1.0 + 0.18 * peak);
  d = vec4f(d.rgb * knee, d.w * knee);
  dye_out[i] = clamp(d, vec4f(0.0), vec4f(3.0));
}
