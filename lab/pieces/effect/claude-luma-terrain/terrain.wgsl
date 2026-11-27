// Heightfield raymarch over the mirrored-tiled luma. World: x right, y up, z forward.
fn lt_mirror(x: f32) -> f32 { let f = fract(x * 0.5) * 2.0; return 1.0 - abs(1.0 - f); }
fn lt_uv(p: vec2f) -> vec2f {
  let s = p_scale();
  return vec2f(lt_mirror(p.x / (s * aspect()) + 0.5), lt_mirror(-p.y / s));
}
fn lt_amp() -> f32 { return p_height() * (1.0 + p_bass() * bass() * 1.6); }
fn lt_h(p: vec2f) -> f32 {
  let l = tex_height(lt_uv(p)).x;
  return smoothstep(0.0, 1.0, l) * lt_amp();
}
fn lt_path(z: f32) -> f32 { return p_bank() * (sin(z * 0.11) * 2.2 + sin(z * 0.047 + 1.3) * 1.6); }

fn shade(uv: vec2f) -> vec4f {
  let beat = fract(phase());
  // closed-form flight: steady speed, plus a lurch early in each beat that cancels by its end
  let lurch = (1.0 - pow(1.0 - beat, 3.0)) - beat;
  let bl = 60.0 / max(bpm(), 40.0);
  let z0 = time() * p_speed() + p_surge() * lurch * bl * max(p_speed(), 0.6) * 1.5;
  let x0 = lt_path(z0);
  let dx = lt_path(z0 + 1.0) - x0;
  let gh = lt_h(vec2f(x0, z0 + 1.5));
  let y0 = 1.3 + max(gh - 0.9, 0.0) * 0.8 + 0.25 * max(lt_amp() - 1.0, 0.0);
  let ro = vec3f(x0, y0, z0);
  let fwd = normalize(vec3f(dx, -p_pitch(), 1.0));
  let roll = -dx * 0.35 * p_bank();
  let side = normalize(cross(vec3f(sin(roll), cos(roll), 0.0), fwd));
  let up = cross(fwd, side);
  let q = (uv - 0.5) * vec2f(aspect(), -1.0);
  let rd = normalize(fwd * 1.15 + side * q.x + up * q.y);

  // march
  let tmax = 60.0;
  var t = 0.05;
  var hit = false;
  var tp = t;
  for (var i = 0; i < 110; i++) {
    let p = ro + rd * t;
    let d = p.y - lt_h(p.xz);
    if (d < 0.002 * t) { hit = true; break; }
    tp = t;
    t += max(d * 0.45, 0.01 + t * 0.004);
    if (t > tmax) { break; }
  }
  if (hit) { // refine between the last two samples
    var a = tp; var b = t;
    for (var k = 0; k < 5; k++) {
      let m = 0.5 * (a + b);
      let p = ro + rd * m;
      if (p.y - lt_h(p.xz) < 0.0) { b = m; } else { a = m; }
    }
    t = b;
  }

  let sky = mix(palette(0.85) * 0.35, palette(0.15) * 0.08, clamp(rd.y * 2.5 + 0.3, 0.0, 1.0));
  // sun glow on the horizon, pulsing with the beat
  let sun = pow(max(dot(rd, normalize(vec3f(0.0, 0.12, 1.0))), 0.0), 40.0) * (0.8 + 1.5 * bass());
  var col = sky + palette(0.6) * sun;
  if (hit) {
    let p = ro + rd * t;
    let e = 0.03 + t * 0.002;
    let hx = lt_h(p.xz + vec2f(e, 0.0)) - lt_h(p.xz - vec2f(e, 0.0));
    let hz = lt_h(p.xz + vec2f(0.0, e)) - lt_h(p.xz - vec2f(0.0, e));
    let n = normalize(vec3f(-hx, 2.0 * e, -hz));
    let L = normalize(vec3f(0.4, 0.7, 0.6));
    let dif = max(dot(n, L), 0.0);
    let amp = max(lt_amp(), 0.001);
    let hr = clamp(p.y / amp, 0.0, 1.0);
    let img = tex_in(lt_uv(p.xz)).rgb;
    let mode = i32(p_colour());
    var alb = img * 1.3 + 0.02;
    if (mode == 1) { alb = palette(hr * 0.85 + 0.05) * 0.9; }
    else if (mode == 2) { alb = mix(img * 1.3, palette(hr), 0.45); }
    col = alb * (0.25 + 0.95 * dif) + alb * 0.25 * hr;
    // pixel footprint in world units (no derivatives: this branch is not uniform)
    let px = t * 1.6 / resolution().y;
    // contours: steady lines, and one swept from the valleys to the peaks each beat
    let cd = abs(fract(hr * 6.0) - 0.5) * 2.0;          // 1 on a line, 0 between
    let slope = length(vec2f(hx, hz)) / (2.0 * e) + 0.05;
    let lw = clamp(px * slope / amp * 6.0 * 1.5, 0.02, 0.5);
    let lines = smoothstep(1.0 - lw, 1.0, cd);
    let sweep = exp(-pow((hr - beat) * 14.0, 2.0)) * (0.5 + 1.5 * bass());
    col += palette(fract(hr + 0.3)) * p_contour() * (lines * 0.3 + sweep * 0.9) * (0.4 + hr);
    // ridges flash on onsets
    col += palette(0.95) * pow(hr, 4.0) * onset() * 1.2;
    // neon grid (1 world unit), lines a couple of pixels wide
    let gd = 0.5 - abs(fract(p.xz) - 0.5);
    let gw = vec2f(0.01 + px * 1.5);
    let gl = 1.0 - smoothstep(gw * 0.5, gw, gd);
    col += palette(0.7) * p_grid() * max(gl.x, gl.y) * (0.6 + bass()) * exp(-t * 0.04);
    let fog = 1.0 - exp(-t * p_fog());
    col = mix(col, sky + palette(0.6) * sun * 0.5, clamp(fog, 0.0, 1.0));
  }
  return vec4f(max(col, vec3f(0.0)), 1.0);
}
