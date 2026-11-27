// Feedback melt: advect last frame by noise flow + the picture's edge field, sharpen (reaction),
// then let the live picture seep back in (luma-weighted, with a beat snap).
fn mm_hash(p: vec2f) -> f32 {
  let q = fract(p * vec2f(123.34, 456.21));
  let r = q + dot(q, q + 45.32);
  return fract(r.x * r.y);
}
fn mm_noise(p: vec2f) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let u = f * f * (3.0 - 2.0 * f);
  let a = mm_hash(i);
  let b = mm_hash(i + vec2f(1.0, 0.0));
  let c = mm_hash(i + vec2f(0.0, 1.0));
  let d = mm_hash(i + vec2f(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
fn mm_lum(c: vec3f) -> f32 { return dot(c, vec3f(0.2126, 0.7152, 0.0722)); }

fn shade(uv: vec2f) -> vec4f {
  let asp = vec2f(aspect(), 1.0);
  let px = 1.0 / resolution();
  let t = time();
  let kick = pow(1.0 - phase(), 4.0);
  let drive = 1.0 + p_bass() * bass() * 2.0 + onset() * 0.6;

  // noise flow: direction from two octaves of value noise, slowly evolving
  let p = uv * asp * p_scale();
  let n = mm_noise(p + vec2f(t * 0.07, -t * 0.05)) + 0.5 * mm_noise(p * 2.1 - vec2f(t * 0.11, t * 0.04));
  let ang = n * 6.2831853 * 1.6 + t * 0.15;
  var v = vec2f(cos(ang), sin(ang)) * p_flow() * 0.0012 * drive;

  // edge push, turned toward the contours
  let g = tex_edges(uv).xy;
  let s = p_along() * 1.5707963;
  let gd = vec2f(g.x * cos(s) - g.y * sin(s), g.x * sin(s) + g.y * cos(s));
  v += gd * p_edge() * 0.0025 * (drive + kick * p_beat() * 2.0);

  let src = uv - v / asp;
  var c = prev(src).rgb;

  // reaction: unsharp against a wide blur grows worms and spots out of the smears
  let r = 3.0 * px;
  let blur = (prev(src + vec2f(r.x, 0.0)).rgb + prev(src - vec2f(r.x, 0.0)).rgb +
              prev(src + vec2f(0.0, r.y)).rgb + prev(src - vec2f(0.0, r.y)).rgb) * 0.25;
  let k = p_react() * 0.45;
  c = c + (c - blur) * k;
  // keep the sharpened values in a soft range so the reaction saturates instead of exploding
  c = clamp(c, vec3f(0.0), vec3f(3.0));
  c = c / (1.0 + c * 0.04 * p_react());

  // palette bleed: what lingers drifts toward the palette at its own brightness
  let l = mm_lum(c);
  let pal = palette(fract(l * 0.8 + t * 0.02 + n * 0.25)) * (0.3 + l);
  c = mix(c, pal, p_tint() * 0.035);

  // the live picture seeps back, bright parts first, and snaps back on the beat
  let live = tex_in(uv).rgb;
  let key = clamp(tex_luma(uv).r, 0.0, 1.0);
  let seep = p_resurface() * 0.06 * (0.35 + key * 1.3);
  let snap = p_beat() * kick * kick * 0.35 + onset() * 0.08;
  let m = clamp(seep + snap, 0.0, 1.0);
  c = mix(c, live, m);
  // never lose the picture entirely
  c = max(c, live * 0.04);
  return vec4f(c, 1.0);
}
