// Droste: the picture R (aspect units, centred) holds a copy of itself, F(R), where
// F(w) = c + s * rot(w - c, th). The view at zoom z in 0..1 is F^z (c + s^z rot(z th)); stepping
// into the child (G = F^-1) while the point stays inside the inner frame finds the level k. A level's
// on-screen depth d = k - z is continuous across the bar wrap (z 1 -> 0 is the same view as one level
// in), so everything graded by d never jumps.
const MD_PI = 3.14159265;

fn md_rot(v: vec2f, a: f32) -> vec2f { let c = cos(a); let s = sin(a); return vec2f(v.x * c - v.y * s, v.x * s + v.y * c); }
fn md_luma(c: vec3f) -> f32 { return dot(c, vec3f(0.2126, 0.7152, 0.0722)); }
fn md_tri(x: f32) -> f32 { return 1.0 - abs(1.0 - 2.0 * fract(x)); }
fn md_inside(w: vec2f, hb: vec2f) -> bool { return abs(w.x) <= hb.x && abs(w.y) <= hb.y; }

fn shade(uv: vec2f) -> vec4f {
  let a = aspect();
  let hb = vec2f(a * 0.5, 0.5);
  let s = p_ratio();
  let k = clamp(p_kick(), 0.0, 1.5);
  let th = p_twist() + p_bass() * bass() * 0.5;
  let c = vec2f((p_cx() - 0.5) * a, p_cy() - 0.5);
  // one level per bar, pushed forward on each beat
  let x = fract(phase());
  let z = (floor(bar() + 0.01) + x + p_lurch() * sin(2.0 * MD_PI * x) / (2.0 * MD_PI)) * 0.25;
  var p = vec2f((uv.x - 0.5) * a, uv.y - 0.5);
  p = c + (p - c) * (1.0 - p_punch() * k);
  var w = c + pow(s, z) * md_rot(p - c, z * th);
  var lv = 0.0;
  // a turned level can poke out past the outer picture at the corners: step out to its parent
  for (var i = 0; i < 2; i++) {
    if (md_inside(w, hb)) { break; }
    w = c + s * md_rot(w - c, th);
    lv -= 1.0;
  }
  var deep = true;
  for (var i = 0; i < 14; i++) {
    let q = c + md_rot(w - c, -th) / s;
    if (!md_inside(q, hb)) { deep = false; break; }
    w = q; lv += 1.0;
  }
  let d = lv - z;
  let scr = pow(s, d);  // level units -> screen heights
  let px = 1.0 / resolution().y;
  if (deep || scr < px) { return vec4f(palette(0.04) * 0.3, 1.0); }

  var col = tex_in(vec2f(w.x / a + 0.5, w.y + 0.5)).rgb;
  let l = md_luma(col);
  // the grade: deeper levels into the palette, its hue walking with the depth
  let pc = palette(md_tri(l * 0.85 + d * 0.19 + 0.04)) * (0.25 + 1.4 * l);
  let m = i32(p_mode());
  var g = clamp(d * 0.55, 0.0, 1.0);
  if (m == 1) { g = 0.5 - 0.5 * cos(MD_PI * d); }
  else if (m == 2) { g = 0.3 * clamp(d, 0.0, 1.0); }
  col = mix(col, pc, g * p_grade());
  col *= pow(0.9, max(d, 0.0));

  // the frame around the child and its shadow on this level
  let q = c + md_rot(w - c, -th) / s;
  let dq = length(max(abs(q) - hb, vec2f(0.0)));
  let ds = dq * s * scr;  // screen heights from the child's edge
  let fw = max(p_frame() * 4.0 * px, 0.0);
  let beat = pow(1.0 - x, 3.0);
  if (fw > 0.0 && ds < fw) {
    let t = ds / fw;
    let lit = palette(0.86) * (0.35 + p_glow() * (0.35 + 1.3 * k + 0.25 * beat));
    let fc = mix(palette(0.12) * 0.4, lit, sin(MD_PI * t) * 0.8 + 0.2);
    return vec4f(fc, 1.0);
  }
  col *= 1.0 - p_shadow() * 0.75 * exp(-(ds - fw) / max(fw * 2.5 + 4.0 * px, 1e-4));
  // a dark hairline just inside this level's own edge
  if (lv >= 1.0) {
    let din = min(hb.x - abs(w.x), hb.y - abs(w.y)) * scr;
    col *= mix(0.45, 1.0, smoothstep(0.0, 1.5 * px, din));
  }
  return vec4f(max(col, vec3f(0.0)), 1.0);
}
