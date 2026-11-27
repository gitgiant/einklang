// The picture as K ridgelines standing in 3D: row j is a curtain in the plane z = z_j whose top edge is
// that scanline of the image raised by its luma. The ray crosses the row planes front to back.
const MR_PI = 3.14159265;
const MR_HX = 1.6;

// ---- camera paths (the same set in claude-media-cubes and claude-media-pins; spiral here is an arc) ----
struct MrCam { ro: vec3f, fwd: vec3f, side: vec3f, up: vec3f, focal: f32 };
fn mr_look(ro: vec3f, tgt: vec3f, focal: f32) -> MrCam {
  let f = normalize(tgt - ro);
  let s = normalize(cross(vec3f(0.0, 1.0, 0.0), f));
  return MrCam(ro, f, s, cross(f, s), focal);
}
fn mr_cam(mode: i32, hx: f32, hz: f32, hm: f32, kick: f32) -> MrCam {
  let t = time();
  let R = max(hx, hz);
  let z = p_zoom();
  if (mode == 1) {
    let s = 0.5 + 0.5 * sin(t * 0.06);
    let ro = vec3f(hx * 0.3 * sin(t * 0.083), hm * 3.5 + R * 0.1 - kick * hm * 0.6, mix(-hz * 1.3, -hz * 0.5, s));
    return mr_look(ro, vec3f(ro.x * 0.3 + R * 0.1 * sin(t * 0.05), 0.0, ro.z + R * 0.95), 1.5 * z * (1.0 + 0.1 * kick));
  }
  if (mode == 2) {
    let ro = vec3f(hx * 0.12 * sin(t * 0.07), R * 1.25 + hm - kick * R * 0.12, -hz * 0.55 + hz * 0.1 * cos(t * 0.05));
    let f = normalize(vec3f(0.1 * sin(t * 0.09), -1.0, 0.55));
    let a = 0.2 * sin(t * 0.04) + 0.06 * sin(t * 0.13);
    let s = normalize(cross(vec3f(sin(a), 0.0, cos(a)), f));
    return MrCam(ro, f, s, cross(f, s), 1.5 * z * (1.0 + 0.1 * kick));
  }
  if (mode == 3) {
    let ro = vec3f(hx * 0.6 * sin(t * 0.09), hm * 0.9 + R * 0.06, -hz - R * 0.5 + kick * R * 0.06);
    return mr_look(ro, vec3f(ro.x * 0.3, hm * 0.35, 0.0), 1.5 * z * (1.0 + 0.1 * kick));
  }
  var yaw = p_swing() * sin(t * 0.13) + 0.25 * sin(t * p_spin() * 2.0 * MR_PI / 6.0);
  var el = p_tilt() + 0.06 * sin(t * 0.21);
  var dist = R * 1.9 / z;
  if (mode == 4) {
    yaw = 0.8 * sin(t * 0.11) + 0.2 * sin(t * 0.29);
    el = 0.45 + 0.3 * sin(t * 0.13);
    dist = R * (1.6 + 0.25 * sin(t * 0.19)) / z;
  }
  dist *= 1.0 - 0.07 * kick;
  let tgt = vec3f(0.0, hm * 0.25, 0.0);
  return mr_look(tgt + dist * vec3f(sin(yaw) * cos(el), sin(el), -cos(yaw) * cos(el)), tgt, 1.5);
}

fn mr_kick() -> f32 { return clamp(max(p_kick(), onset() * 0.8), 0.0, 1.5); }
fn mr_amp() -> f32 { return p_height() * (1.0 + p_bass() * bass() * 1.5); }
// world height of row v (0 = image top = far) at image column u
fn mr_h(u: f32, v: f32, amp: f32, kick: f32) -> f32 {
  let l = tex_height(vec2f(u, v)).x;
  return 0.004 + l * amp + kick * p_punch() * (0.25 + 0.75 * l) * (0.6 + 0.4 * sin(u * 9.0 + v * 5.0 + time()));
}

fn shade(uv: vec2f) -> vec4f {
  let K = i32(p_lines());
  let hx = MR_HX;
  let hz = hx / aspect();
  let kick = mr_kick();
  let amp = mr_amp();
  let beat = fract(phase());
  let bt = (bar() + beat) / 4.0;
  let cam = mr_cam(i32(p_path()), hx, hz, p_height() * 0.6, kick);
  let q = (uv - 0.5) * vec2f(aspect(), -1.0);
  let rdu = cam.fwd * cam.focal + cam.side * q.x + cam.up * q.y;
  let ro = cam.ro;
  let px = 1.0 / resolution().y;
  let th = p_thickness() * resolution().y / 1080.0;

  // the sky: dark, a palette glow at the horizon
  let rn = normalize(rdu);
  var bg = palette(0.08) * 0.03 + palette(0.5) * 0.12 * exp(-abs(rn.y + 0.05) * 7.0) * (0.6 + bass());
  var col = vec3f(0.0);
  var T = 1.0;
  let hmax = amp + p_punch() * 1.6 + 0.05;
  if (abs(rdu.z) > 1e-5) {
    // the box's z range along the ray, as row indices
    let inv = 1.0 / rdu;
    let ta = (vec3f(-hx, -0.01, -hz) - ro) * inv;
    let tb = (vec3f(hx, hmax, hz) - ro) * inv;
    let tn = min(ta, tb); let tf = max(ta, tb);
    let tin = max(max(max(tn.x, tn.y), tn.z), 0.0); let tout = min(min(tf.x, tf.y), tf.z);
    if (tin < tout) {
      let dz = 2.0 * hz / f32(K);
      let za = ro.z + rdu.z * tin; let zb = ro.z + rdu.z * tout;
      let dir = select(-1, 1, rdu.z > 0.0);
      var j = i32(select(ceil((za + hz) / dz - 0.5), floor((za + hz) / dz - 0.5), dir < 0));
      let jend = i32(select(ceil((zb + hz) / dz - 0.5), floor((zb + hz) / dz - 0.5), dir < 0));
      let steps = min(abs(jend - j) + 2, K + 1);
      let mode = i32(p_colour());
      let e = 3.0 / resolution().x;
      // per-pixel steps of the ray on a plane z = const (screen up, screen right)
      let au = cam.up - rdu * (cam.up.z / rdu.z);
      let as_ = cam.side - rdu * (cam.side.z / rdu.z);
      for (var i = 0; i < steps; i++) {
        if (j >= 0 && j < K) {
          let zj = -hz + (f32(j) + 0.5) * dz;
          let s = (zj - ro.z) / rdu.z;
          if (s > 0.0) {
            let p = ro + rdu * s;
            if (abs(p.x) <= hx) {
              let u = (p.x + hx) / (2.0 * hx);
              let v = 1.0 - (f32(j) + 0.5) / f32(K);
              let h = mr_h(u, v, amp, kick);
              let slope = (mr_h(u + e, v, amp, kick) - h) / (e * 2.0 * hx);
              let dy = p.y - h;
              let gy = (au.y - slope * au.x) * s * px;
              let gx = (as_.y - slope * as_.x) * s * px;
              let pd = abs(dy) / max(length(vec2f(gx, gy)), 1e-7);
              let line = smoothstep(th + 0.8, th * 0.3, pd);
              if (line > 0.0 || dy < 0.0) {
                let img = tex_in(vec2f(u, v)).rgb;
                let l = tex_height(vec2f(u, v)).x;
                var c = vec3f(1.0);
                if (mode == 0) { c = img * 1.6 + 0.05; }
                else if (mode == 1) { c = palette(fract(l * 0.8 + v * 0.3 + bt * 0.1)); }
                // a glow runs back through the rows over each beat, and kicks light the peaks
                let f = (f32(j) + 0.5) / f32(K);
                let run = exp(-pow((f - beat) * 8.0, 2.0)) * (0.5 + bass());
                let lit = c * p_glow() * (1.0 + run + kick * smoothstep(0.4, 1.0, l) * 1.5);
                col += T * lit * line;
                T *= 1.0 - line * 0.85;
                if (dy < 0.0) {
                  // the curtain under the line: the picture, dim, darker towards the ground
                  let fc = (img * p_face() + palette(0.12) * 0.03) * clamp(p.y / max(h, 1e-3), 0.0, 1.0);
                  col += T * fc * p_fill();
                  T *= 1.0 - p_fill();
                }
              }
            }
          }
        }
        if (T < 0.02) { break; }
        j += dir;
      }
    }
  }
  // the ground and the sky behind whatever lets light through
  if (rn.y < 0.0) {
    let t = -ro.y / rn.y;
    let g = ro + rn * t;
    let fade = exp(-length(max(abs(g.xz) - vec2f(hx, hz), vec2f(0.0))) * 1.5);
    bg = mix(bg, palette(0.25) * (0.02 + 0.06 * bass()) * fade, 0.85);
  }
  col += T * bg;
  return vec4f(max(col, vec3f(0.0)), 1.0);
}
