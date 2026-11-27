// The picture as a C x R pin-screen on the xz plane (cell = 1): a rod and a round head per cell, or a
// floating point cloud; heights from the luma, kicks push them; exact 2D DDA over the cells.
const MP_PI = 3.14159265;

// ---- camera paths (the same set in claude-media-cubes and claude-media-ridgelines) ----
struct MpCam { ro: vec3f, fwd: vec3f, side: vec3f, up: vec3f, focal: f32 };
fn mp_look(ro: vec3f, tgt: vec3f, focal: f32) -> MpCam {
  let f = normalize(tgt - ro);
  let s = normalize(cross(vec3f(0.0, 1.0, 0.0), f));
  return MpCam(ro, f, s, cross(f, s), focal);
}
// hx, hz: half extents of the field, hm: a typical height; 0 orbit, 1 flyover, 2 top-down, 3 crane, 4 spiral
fn mp_cam(mode: i32, hx: f32, hz: f32, hm: f32, kick: f32) -> MpCam {
  let t = time();
  let R = max(hx, hz);
  let z = p_zoom();
  if (mode == 1) {
    let s = 0.5 + 0.5 * sin(t * 0.06);
    let ro = vec3f(hx * 0.35 * sin(t * 0.083), hm * 3.5 + R * 0.1 - kick * hm * 0.6, mix(-hz * 1.3, -hz * 0.5, s));
    return mp_look(ro, vec3f(ro.x * 0.3 + R * 0.1 * sin(t * 0.05), 0.0, ro.z + R * 0.95), 1.5 * z * (1.0 + 0.1 * kick));
  }
  if (mode == 2) {
    let ro = vec3f(hx * 0.12 * sin(t * 0.07), R * 1.25 + hm - kick * R * 0.12, -hz * 0.15 + hz * 0.1 * cos(t * 0.05));
    let f = normalize(vec3f(0.1 * sin(t * 0.09), -1.0, 0.25));
    let a = 0.25 * sin(t * 0.04) + 0.08 * sin(t * 0.13);
    let s = normalize(cross(vec3f(sin(a), 0.0, cos(a)), f));
    return MpCam(ro, f, s, cross(f, s), 1.5 * z * (1.0 + 0.1 * kick));
  }
  if (mode == 3) {
    let ro = vec3f(hx * 0.75 * sin(t * 0.09), hm * 0.8 + R * 0.06, -hz - R * 0.45 + kick * R * 0.06);
    return mp_look(ro, vec3f(ro.x * 0.35, hm * 0.3, 0.0), 1.5 * z * (1.0 + 0.1 * kick));
  }
  var yaw = p_swing() * sin(t * 0.13) + t * p_spin() * 2.0 * MP_PI / 6.0;
  var el = p_tilt() + 0.08 * sin(t * 0.21);
  var dist = R * 1.9 / z;
  if (mode == 4) {
    yaw = t * 0.2 + 0.4 * sin(t * 0.07);
    el = 0.5 + 0.3 * sin(t * 0.13);
    dist = R * (1.55 + 0.25 * sin(t * 0.19)) / z;
  }
  dist *= 1.0 - 0.07 * kick;
  let tgt = vec3f(0.0, hm * 0.2, 0.0);
  return mp_look(tgt + dist * vec3f(sin(yaw) * cos(el), sin(el), -cos(yaw) * cos(el)), tgt, 1.5);
}

// ---- the field ----
fn mp_dims() -> vec2f {
  let c = round(f32(p_cells()));
  return vec2f(c, max(round(c / aspect()), 4.0));
}
fn mp_kick() -> f32 { return clamp(max(p_kick(), onset() * 0.8), 0.0, 1.5); }
fn mp_cuv(cell: vec2i, d: vec2f) -> vec2f { let u = (vec2f(cell) + 0.5) / d; return vec2f(u.x, 1.0 - u.y); }
fn mp_hmax() -> f32 { return 0.1 + p_height() * (1.0 + p_bass() * 1.5) + p_punch() * 1.5 + p_wave() * 1.4; }
fn mp_height(cell: vec2i, d: vec2f, l: f32) -> f32 {
  let c = (vec2f(cell) + 0.5 - d * 0.5) / (d.x * 0.5);
  let beat = fract(phase());
  let ring = exp(-pow((length(c) - beat * 1.6) * 5.0, 2.0)) * (1.0 - beat) * (0.35 + bass());
  return 0.1 + l * p_height() * (1.0 + p_bass() * bass() * 1.5) + mp_kick() * p_punch() * (0.3 + 0.7 * l) + ring * p_wave();
}
fn mp_radius() -> f32 { return select(p_size(), p_size() * 0.55, i32(p_shape()) == 1); }

// ray / sphere: nearest t (< 0 = miss)
fn mp_sphere(ro: vec3f, rd: vec3f, c: vec3f, r: f32) -> f32 {
  let oc = ro - c;
  let b = dot(oc, rd);
  let h = b * b - (dot(oc, oc) - r * r);
  if (h < 0.0) { return -1.0; }
  return -b - sqrt(h);
}
// ray / vertical rod (axis through c.xz, y in 0..top): nearest t (< 0 = miss)
fn mp_rod(ro: vec3f, rd: vec3f, c: vec2f, r: f32, top: f32) -> f32 {
  let o = ro.xz - c;
  let a = dot(rd.xz, rd.xz);
  if (a < 1e-8) { return -1.0; }
  let b = dot(o, rd.xz);
  let h = b * b - a * (dot(o, o) - r * r);
  if (h < 0.0) { return -1.0; }
  let t = (-b - sqrt(h)) / a;
  let y = ro.y + rd.y * t;
  if (t < 0.0 || y < 0.0 || y > top) { return -1.0; }
  return t;
}

struct MpHit { t: f32, n: vec3f, cell: vec2i, h: f32, head: bool, ok: bool, glow: vec3f };

fn mp_trace(ro: vec3f, rd: vec3f, d: vec2f) -> MpHit {
  var res = MpHit(-1.0, vec3f(0.0), vec2i(0), 0.0, false, false, vec3f(0.0));
  let half = d * 0.5;
  let r = mp_radius();
  let top = mp_hmax() + r + 0.1;
  // the field's box
  let inv = 1.0 / rd;
  let ta = (vec3f(-half.x, 0.0, -half.y) - ro) * inv;
  let tb = (vec3f(half.x, top, half.y) - ro) * inv;
  let tn = min(ta, tb); let tf = max(ta, tb);
  let tin = max(max(tn.x, tn.y), tn.z); let tout = min(min(tf.x, tf.y), tf.z);
  if (tin > tout || tout < 0.0) { return res; }
  let p = ro + rd * (max(tin, 0.0) + 1e-3);
  var cell = vec2i(clamp(floor(p.xz + half), vec2f(0.0), d - 1.0));
  let rxz = rd.xz;
  let stp = vec2i(sign(rxz));
  let tdel = abs(1.0 / rxz);
  let nb = vec2f(cell) + max(sign(rxz), vec2f(0.0)) - half;
  var tmax = (nb - ro.xz) / rxz;
  let points = i32(p_shape()) == 1;
  let n = i32(d.x + d.y) + 2;
  for (var i = 0; i < n; i++) {
    if (cell.x < 0 || cell.y < 0 || cell.x >= i32(d.x) || cell.y >= i32(d.y)) { break; }
    let l = tex_height(mp_cuv(cell, d)).x;
    let h = mp_height(cell, d, l);
    let cxz = vec2f(cell) + 0.5 - half;
    let c = vec3f(cxz.x, h, cxz.y);
    var best = mp_sphere(ro, rd, c, r);
    var head = best > 0.0;
    if (!points) {
      let tr = mp_rod(ro, rd, cxz, r * 0.28, h);
      if (tr > 0.0 && (!head || tr < best)) { best = tr; head = false; }
    } else {
      // a point cloud: each point glows a little past its surface
      let oc = c - ro;
      let tc = max(dot(oc, rd), 0.0);
      let dd = length(oc - rd * tc);
      let k = exp(-max(dd - r, 0.0) / 0.07);
      if (k > 0.01) { res.glow += (tex_in(mp_cuv(cell, d)).rgb + 0.03) * k * (0.12 + 0.5 * l); }
    }
    if (best > 0.0) {
      res.t = best; res.cell = cell; res.h = h; res.head = head; res.ok = true;
      let q = ro + rd * best;
      res.n = select(normalize(vec3f(q.x - cxz.x, 0.0, q.z - cxz.y)), normalize(q - c), head);
      return res;
    }
    if (tmax.x < tmax.y) { cell.x += stp.x; tmax.x += tdel.x; }
    else { cell.y += stp.y; tmax.y += tdel.y; }
  }
  return res;
}

fn shade(uv: vec2f) -> vec4f {
  let d = mp_dims();
  let beat = fract(phase());
  let bt = (bar() + beat) / 4.0;
  let kick = mp_kick();
  let cam = mp_cam(i32(p_path()), d.x * 0.5, d.y * 0.5, p_height() * 0.6, kick);
  let q = (uv - 0.5) * vec2f(aspect(), -1.0);
  let rd = normalize(cam.fwd * cam.focal + cam.side * q.x + cam.up * q.y);
  let ro = cam.ro;
  let points = i32(p_shape()) == 1;

  var col = mix(palette(0.1) * 0.03, palette(0.45) * 0.1, clamp(0.6 - q.y, 0.0, 1.0)) * (1.0 + bass());
  let hit = mp_trace(ro, rd, d);
  let L = normalize(vec3f(0.45, 0.85, -0.3));
  if (hit.ok) {
    let p = ro + rd * hit.t;
    let cuv = mp_cuv(hit.cell, d);
    let img = tex_in(cuv).rgb;
    let l = tex_height(cuv).x;
    let mode = i32(p_colour());
    var alb = img * 1.4 + 0.03;
    if (mode == 1) { alb = palette(fract(l * 0.85 + 0.05)); }
    else if (mode == 2) { alb = mix(img * 1.4, palette(l), 0.45); }
    let dif = max(dot(hit.n, L), 0.0);
    let spec = pow(max(dot(reflect(rd, hit.n), L), 0.0), 36.0);
    let rim = pow(1.0 - max(dot(hit.n, -rd), 0.0), 3.0);
    let pulse = (0.3 + exp(-beat * 4.0) * (0.6 + bass()) + onset() * 0.6) * p_glow();
    let rc = palette(fract(l * 0.5 + bt * 0.25));
    if (hit.head) {
      if (points) {
        col = alb * (0.55 + 0.75 * dif) + rc * rim * pulse;
      } else {
        col = alb * (0.25 + 0.95 * dif) + vec3f(spec) * (0.5 + kick) + rc * rim * pulse * 0.8;
      }
      // the brightest heads flash on onsets
      col += alb * onset() * smoothstep(0.55, 1.0, l) * 0.9;
    } else {
      // rods: dark steel, lighter near the head
      let up = clamp(p.y / max(hit.h, 0.01), 0.0, 1.0);
      col = (vec3f(0.05) + alb * 0.1) * (0.3 + dif) * (0.35 + 0.65 * up) + vec3f(spec) * 0.25 + rc * rim * pulse * 0.25;
    }
    col = mix(col, palette(0.15) * 0.05, 1.0 - exp(-hit.t * 0.004));
  } else if (rd.y < 0.0) {
    // the board: a dark plate with a hole under each pin
    let t = -ro.y / rd.y;
    let p = ro + rd * t;
    let inside = step(abs(p.x), d.x * 0.5) * step(abs(p.z), d.y * 0.5);
    let fade = exp(-length(max(abs(p.xz) - d * 0.5, vec2f(0.0))) * 0.15);
    let hole = smoothstep(0.12, 0.2, length(fract(p.xz + d * 0.5) - 0.5));
    let plate = palette(0.3) * (0.03 + 0.12 * bass()) * mix(1.0, 0.35 + 0.65 * hole, inside);
    col = mix(col, plate * fade, 0.85 * fade);
  }
  col += hit.glow * (0.8 + bass() + kick * 0.6);
  return vec4f(max(col, vec3f(0.0)), 1.0);
}
