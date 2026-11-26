fn rg_hash(i: vec2i) -> f32 {
  var h = (bitcast<u32>(i.x) * 0x8da6b343u) ^ (bitcast<u32>(i.y) * 0xd8163841u);
  h = (h ^ (h >> 13u)) * 0x5bd1e995u;
  h = h ^ (h >> 15u);
  return f32(h >> 8u) / 16777216.0;
}

fn rg_noise(p: vec2f) -> f32 {
  let i = vec2i(floor(p));
  let f = fract(p);
  let u = f * f * (3.0 - 2.0 * f);
  let a = rg_hash(i);
  let b = rg_hash(i + vec2i(1, 0));
  let c = rg_hash(i + vec2i(0, 1));
  let d = rg_hash(i + vec2i(1, 1));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

fn rg_line(u: f32, w: f32) -> f32 {
  let d = abs(fract(u + 0.5) - 0.5);
  let fade = 1.0 - smoothstep(0.1, 0.45, w);
  return clamp(1.0 - d / (max(w, 1e-5) * 1.4), 0.0, 1.0) * fade + 0.15 * (1.0 - fade);
}

fn shade(uv: vec2f) -> vec4f {
  let hz = p_horizon();
  let px = 1.0 / resolution().y;
  let sx = (uv.x - 0.5) * aspect();
  let v = hz - uv.y;
  let H = 0.5;
  let B = p_beats() * p_speed();
  let fb = fract(B);
  let ib = i32(floor(B));
  let n = i32(p_rows());
  let zmax = f32(n);
  let camx = p_sway() * sin(time() * 0.21) * 0.8 + p_sway() * 0.4 * sin(time() * 0.53);
  let bi = i32(clamp(abs(uv.x - 0.5) * 2.0 * 15.0, 0.0, 15.0));
  let lift = 1.0 + p_audio() * band(bi);
  let hmax = p_height() * lift * 1.05;
  let zw = mix(zmax * 0.8, 1.5, phase());

  var col = vec3f(0.0);
  var alpha = 0.0;
  var vprev = -2.0;
  var zprev = 0.3;
  for (var k = 0; k < n; k++) {
    let z = f32(k) + 1.0 - fb;
    if (z < 0.3) { continue; }
    let lw = px * (1.0 + 1.5 / z);
    // rows farther than this cannot reach the pixel any more
    if (v > max((hmax - H) / z, 0.0) + lw) { break; }
    let xw = sx * z + camx;
    let rk = f32(ib + k + 1);
    let side = smoothstep(p_valley(), p_valley() + 2.5, abs(xw));
    let r = 1.0 - abs(2.0 * rg_noise(vec2f(xw * 0.32, rk * 0.43)) - 1.0);
    let h = p_height() * side * lift * (0.25 + 0.6 * r * r + 0.25 * rg_noise(vec2f(xw * 0.9 + 17.0, rk * 0.9)));
    let vk = (h - H) / z;
    if (v <= vk + lw) {
      let fog = 1.0 - smoothstep(zmax * 0.55, zmax - 0.5, z);
      let near = clamp(z / zmax, 0.0, 1.0);
      let lc = palette(fract(p_tint() + 0.4 * near));
      let flash = 1.0 + 1.5 * exp(-abs(z - zw) * 0.8) * (0.3 + bass());
      let ridge = clamp(1.0 - abs(v - vk) / lw, 0.0, 1.0);
      // depth between this ridge and the nearer one below, for the vertical grid lines
      let t = clamp((vk - v) / max(vk - vprev, 1e-4), 0.0, 1.0);
      let zz = mix(z, zprev, t);
      let wl = rg_line((sx * zz + camx) * 2.0, zz * px * 2.0) * 0.55;
      let lines = max(ridge, wl * step(v, vk - lw * 0.5));
      col = palette(0.0) * p_fill() * (0.6 + 0.4 * side) + lc * lines * p_glow() * flash * (0.8 + 0.5 * rms());
      alpha = fog;
      col *= fog;
      break;
    }
    vprev = vk;
    zprev = z;
  }
  return vec4f(max(col, vec3f(0.0)), alpha);
}
