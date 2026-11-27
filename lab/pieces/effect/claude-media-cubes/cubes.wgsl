// A C x R grid of boxes on the xz plane (cell = 1), heights from the luma; exact 2D DDA.
const MC_PI = 3.14159265;
// ---- camera paths (the same set in claude-media-pins and claude-media-ridgelines; 0 here is the original orbit) ----
struct McCam { ro: vec3f, fwd: vec3f, side: vec3f, up: vec3f, focal: f32 };
fn mc_look(ro: vec3f, tgt: vec3f, focal: f32) -> McCam {
  let f = normalize(tgt - ro);
  let s = normalize(cross(vec3f(0.0, 1.0, 0.0), f));
  return McCam(ro, f, s, cross(f, s), focal);
}
// hx, hz: half extents of the field, hm: a typical height; 0 orbit, 1 flyover, 2 top-down, 3 crane, 4 spiral
fn mc_cam(mode: i32, hx: f32, hz: f32, hm: f32, kick: f32) -> McCam {
  let t = time();
  let R = max(hx, hz);
  let z = p_zoom();
  if (mode == 1) {
    let s = 0.5 + 0.5 * sin(t * 0.06);
    let ro = vec3f(hx * 0.35 * sin(t * 0.083), hm * 3.5 + R * 0.1 - kick * hm * 0.6, mix(-hz * 1.3, -hz * 0.5, s));
    return mc_look(ro, vec3f(ro.x * 0.3 + R * 0.1 * sin(t * 0.05), 0.0, ro.z + R * 0.95), 1.5 * z * (1.0 + 0.1 * kick));
  }
  if (mode == 2) {
    let ro = vec3f(hx * 0.12 * sin(t * 0.07), R * 1.25 + hm - kick * R * 0.12, -hz * 0.15 + hz * 0.1 * cos(t * 0.05));
    let f = normalize(vec3f(0.1 * sin(t * 0.09), -1.0, 0.25));
    let a = 0.25 * sin(t * 0.04) + 0.08 * sin(t * 0.13);
    let s = normalize(cross(vec3f(sin(a), 0.0, cos(a)), f));
    return McCam(ro, f, s, cross(f, s), 1.5 * z * (1.0 + 0.1 * kick));
  }
  if (mode == 3) {
    let ro = vec3f(hx * 0.75 * sin(t * 0.09), hm * 0.8 + R * 0.06, -hz - R * 0.45 + kick * R * 0.06);
    return mc_look(ro, vec3f(ro.x * 0.35, hm * 0.3, 0.0), 1.5 * z * (1.0 + 0.1 * kick));
  }
  var yaw = p_swing() * sin(t * 0.13) + t * p_spin() * 2.0 * MC_PI / 6.0;
  var el = p_tilt() + 0.08 * sin(t * 0.21);
  var dist = R * 1.9 / z;
  if (mode == 4) {
    yaw = t * 0.2 + 0.4 * sin(t * 0.07);
    el = 0.5 + 0.3 * sin(t * 0.13);
    dist = R * (1.55 + 0.25 * sin(t * 0.19)) / z;
  }
  dist *= 1.0 - 0.07 * kick;
  let tgt = vec3f(0.0, hm * 0.2, 0.0);
  return mc_look(tgt + dist * vec3f(sin(yaw) * cos(el), sin(el), -cos(yaw) * cos(el)), tgt, 1.5);
}

struct McHit { t: f32, n: vec3f, cell: vec2i, top: f32, h: f32, ok: bool };

fn mc_dims() -> vec2f {
  let c = round(f32(p_cells()));
  return vec2f(c, max(round(c / aspect()), 4.0));
}
fn mc_cuv(cell: vec2i, d: vec2f) -> vec2f { return (vec2f(cell) + 0.5) / d; }
fn mc_height(cell: vec2i, d: vec2f) -> f32 {
  let uv = mc_cuv(cell, d);
  let l = tex_height(vec2f(uv.x, 1.0 - uv.y)).x;
  let c = (vec2f(cell) + 0.5 - d * 0.5) / (d.x * 0.5);
  let r = length(c);
  let beat = fract(phase());
  let wave = exp(-pow((r - beat * 1.6) * 5.0, 2.0)) * (1.0 - beat) * (0.35 + bass());
  return 0.15 + l * p_height() * (1.0 + p_bass() * bass() * 1.5) + wave * p_wave() + p_kick() * p_punch() * (0.3 + 0.7 * l);
}
// ray / box: entry t and normal (-1e9 = miss; t < 0 = the ray starts inside)
fn mc_box(ro: vec3f, rd: vec3f, bmin: vec3f, bmax: vec3f) -> vec4f {
  let inv = 1.0 / rd;
  let t0 = (bmin - ro) * inv; let t1 = (bmax - ro) * inv;
  let tn = min(t0, t1); let tf = max(t0, t1);
  let tin = max(max(tn.x, tn.y), tn.z);
  let tout = min(min(tf.x, tf.y), tf.z);
  if (tin > tout || tout < 0.0) { return vec4f(-1e9); }
  var n = vec3f(0.0, 1.0, 0.0);
  if (tin == tn.x) { n = vec3f(-sign(rd.x), 0.0, 0.0); }
  else if (tin == tn.z) { n = vec3f(0.0, 0.0, -sign(rd.z)); }
  return vec4f(tin, n);
}

fn mc_trace(ro: vec3f, rd: vec3f, d: vec2f) -> McHit {
  var res = McHit(-1.0, vec3f(0.0), vec2i(0), 0.0, 0.0, false);
  let half = d * 0.5;
  let hmax = 0.15 + p_height() * (1.0 + p_bass() * 1.5) + p_wave() * 1.4 + p_punch() * p_kick() + 0.1;
  let bb = mc_box(ro, rd, vec3f(-half.x, 0.0, -half.y), vec3f(half.x, hmax, half.y));
  if (bb.x < -1e8) { return res; } // a miss (a camera inside the box has tin < 0)
  let t0 = max(bb.x, 0.0) + 1e-3;
  let p = ro + rd * t0;
  var cell = vec2i(clamp(floor(p.xz + half), vec2f(0.0), d - 1.0));
  let rxz = rd.xz;
  let stp = vec2i(sign(rxz));
  let tdel = abs(1.0 / rxz);
  let nb = vec2f(cell) + max(sign(rxz), vec2f(0.0)) - half; // next boundary in world
  var tmax = (nb - ro.xz) / rxz;
  let g = p_gap() * 0.5;
  let n = i32(d.x + d.y) + 2;
  for (var i = 0; i < n; i++) {
    if (cell.x < 0 || cell.y < 0 || cell.x >= i32(d.x) || cell.y >= i32(d.y)) { break; }
    let h = mc_height(cell, d);
    let lo = vec2f(cell) - half + g;
    let bx = mc_box(ro, rd, vec3f(lo.x, 0.0, lo.y), vec3f(lo.x + 1.0 - 2.0 * g, h, lo.y + 1.0 - 2.0 * g));
    if (bx.x >= 0.0) {
      res.t = bx.x; res.n = bx.yzw; res.cell = cell; res.h = h; res.ok = true;
      res.top = select(0.0, 1.0, bx.z > 0.5);
      return res;
    }
    if (tmax.x < tmax.y) { cell.x += stp.x; tmax.x += tdel.x; }
    else { cell.y += stp.y; tmax.y += tdel.y; }
  }
  return res;
}

fn shade(uv: vec2f) -> vec4f {
  let d = mc_dims();
  let beat = fract(phase());
  let bt = (bar() + beat) / 4.0;
  var cam: McCam;
  if (i32(p_path()) == 0) {
    let yaw = p_swing() * sin(time() * 0.13) + time() * p_spin() * 2.0 * MC_PI / 6.0 + 0.06 * p_swing() * sin(2.0 * MC_PI * bt);
    let tilt = p_tilt() + 0.08 * sin(time() * 0.21);
    let dist = max(d.x, d.y) * 0.95 / p_zoom() * (1.0 - 0.07 * p_kick());
    let tgt = vec3f(0.0, 0.5, 0.0);
    cam = mc_look(tgt + dist * vec3f(sin(yaw) * cos(tilt), sin(tilt), -cos(yaw) * cos(tilt)), tgt, 1.5);
  } else {
    cam = mc_cam(i32(p_path()), d.x * 0.5, d.y * 0.5, p_height() * 0.6, p_kick());
  }
  let ro = cam.ro;
  let q = (uv - 0.5) * vec2f(aspect(), -1.0);
  let rd = normalize(cam.fwd * cam.focal + cam.side * q.x + cam.up * q.y);

  // background: a palette glow behind, darker at the top
  var col = mix(palette(0.1) * 0.04, palette(0.4) * 0.12, clamp(0.6 - q.y, 0.0, 1.0)) * (1.0 + bass());
  let hit = mc_trace(ro, rd, d);
  let L = normalize(vec3f(0.5, 0.8, -0.35));
  if (hit.ok) {
    let p = ro + rd * hit.t;
    let cuv = mc_cuv(hit.cell, d);
    let img = tex_in(vec2f(cuv.x, 1.0 - cuv.y)).rgb;
    let l = tex_height(vec2f(cuv.x, 1.0 - cuv.y)).x;
    let mode = i32(p_colour());
    var alb = img * 1.35 + 0.02;
    if (mode == 1) { alb = palette(fract(l * 0.85 + 0.05)); }
    else if (mode == 2) { alb = mix(img * 1.35, palette(l), 0.45); }
    let dif = max(dot(hit.n, L), 0.0);
    // sides darken towards the floor (cheap occlusion)
    let ao = mix(clamp(p.y / max(hit.h, 0.01), 0.0, 1.0) * 0.8 + 0.2, 1.0, hit.top);
    col = alb * (0.3 + 0.9 * dif) * ao;
    col *= mix(0.75, 1.15, hit.top);
    // edges of the face: distance to the nearest box edge in face coordinates
    let g = p_gap() * 0.5;
    let lo = vec2f(hit.cell) - d * 0.5 + g;
    let fx = (p.x - lo.x) / (1.0 - 2.0 * g);
    let fz = (p.z - lo.y) / (1.0 - 2.0 * g);
    let fy = p.y / max(hit.h, 0.01);
    var e = 1.0;
    if (hit.top > 0.5) { e = min(min(fx, 1.0 - fx), min(fz, 1.0 - fz)); }
    else if (abs(hit.n.x) > 0.5) { e = min(min(fz, 1.0 - fz), (1.0 - fy) * hit.h); }
    else { e = min(min(fx, 1.0 - fx), (1.0 - fy) * hit.h); }
    let px = hit.t * 1.8 / resolution().y;
    let edge = 1.0 - smoothstep(px * 1.0, px * 2.5 + 0.01, e);
    let glow = (0.25 + exp(-beat * 4.0) * (0.6 + bass()) + onset() * 0.6) * p_edges();
    col += palette(fract(l * 0.5 + bt * 0.25)) * edge * glow;
    // the tallest cubes flash on onsets
    col += alb * onset() * smoothstep(0.6, 1.0, l) * 0.8;
  } else if (rd.y < 0.0) {
    // the floor under and around the grid
    let t = -ro.y / rd.y;
    let p = ro + rd * t;
    let inside = step(abs(p.x), d.x * 0.5) * step(abs(p.z), d.y * 0.5);
    let fade = exp(-max(length(max(abs(p.xz) - d * 0.5, vec2f(0.0))), 0.0) * 0.15);
    col = mix(col, palette(0.3) * (0.03 + 0.1 * bass()) * fade, 0.8 * fade) + palette(0.6) * inside * 0.03;
  }
  return vec4f(max(col, vec3f(0.0)), 1.0);
}
