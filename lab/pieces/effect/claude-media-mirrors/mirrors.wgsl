// A wall of C x R mirror panes on the z = 0 plane, the eye at (0, 0, -F). Each pane turns on its
// centre (yaw, then pitch); a pixel's ray is tested against its own pane and the 8 around it (a turned
// pane can reach into the next cell), the nearest hit wins. The reflected ray reads the picture from a
// plane behind the eye, placed so that flat panes rebuild the picture exactly.
const MM_PI = 3.14159265;
const MM_F = 1.7;

struct MmPane { c: vec3f, u: vec3f, v: vec3f, n: vec3f, h: vec2f, seed: f32 };

fn mm_hash(p: vec2f) -> f32 { return fract(sin(dot(p, vec2f(127.1, 311.7))) * 43758.5453); }
fn mm_dims() -> vec2f {
  let c = round(f32(p_panes()));
  return vec2f(c, max(round(c / aspect()), 2.0));
}
fn mm_kick() -> f32 { return clamp(p_kick(), 0.0, 1.5); }
fn mm_luma(c: vec3f) -> f32 { return dot(c, vec3f(0.2126, 0.7152, 0.0722)); }
// mirrored repeat, so a pane turned far reflects a flipped copy instead of a smeared edge
fn mm_wrap(u: vec2f) -> vec2f { return 1.0 - abs(1.0 - 2.0 * fract(u * 0.5)); }

fn mm_pane(ij: vec2i, d: vec2f) -> MmPane {
  let a = aspect();
  let cell = vec2f(a / d.x, 1.0 / d.y);
  let fi = vec2f(ij);
  // pane position -1..1 (y up)
  let q = vec2f((fi.x + 0.5) / d.x * 2.0 - 1.0, 1.0 - (fi.y + 0.5) / d.y * 2.0);
  let h1 = mm_hash(fi + 0.37);
  let h2 = mm_hash(fi + vec2f(5.1, 1.9));
  // one wave per beat, a different one on each beat of the bar; every pane is flat on the beat
  let beat = i32(floor(bar() + 0.01)) % 4;
  var delay = 0.0;
  var dir = vec2f(0.0);
  if (beat == 0) { delay = (q.x * 0.5 + 0.5) * 0.45; dir = vec2f(1.0, 0.0); }
  else if (beat == 1) { delay = (0.5 - q.x * 0.5) * 0.45; dir = vec2f(1.0, 0.0); }
  else if (beat == 2) { delay = min(length(q) * 0.7071, 1.0) * 0.45; dir = vec2f(sign(q.x), -sign(q.y)) * 0.8; }
  else { delay = (0.5 - q.y * 0.5) * 0.45; dir = vec2f(0.0, 1.0); }
  let s = clamp((fract(phase()) - delay) / 0.5, 0.0, 1.0);
  let w = sin(MM_PI * s) * (1.0 - 0.25 * s);
  let checker = select(1.0, -1.0, ((ij.x + ij.y) & 1) == 1);
  let amp = p_swing() * (0.45 + p_bass() * bass()) * w * mix(1.0, checker, p_alternate());
  let k = mm_kick();
  let t = time();
  let yaw = amp * dir.x + p_drift() * 0.2 * sin(t * 0.31 + h1 * 6.28) + k * p_twist() * (h1 - 0.5);
  let pitch = amp * dir.y + p_drift() * 0.16 * cos(t * 0.27 + h2 * 6.28) + k * p_twist() * (h2 - 0.5);
  let cy = cos(yaw); let sy = sin(yaw); let cp = cos(pitch); let sp = sin(pitch);
  let u = vec3f(cy, 0.0, -sy);
  let v = vec3f(sp * sy, cp, sp * cy);
  let n = vec3f(-cp * sy, sp, -cp * cy);
  let z = -(k * p_push() + bass() * p_bass() * 0.15) * (0.3 + 0.7 * h2) * 0.22;
  let c = vec3f((fi.x + 0.5) * cell.x - a * 0.5, 0.5 - (fi.y + 0.5) * cell.y, z);
  return MmPane(c, u, v, n, cell * 0.5 * (1.0 - p_gap()), h1);
}

fn shade(uv: vec2f) -> vec4f {
  let a = aspect();
  let d = mm_dims();
  let p = vec2f((uv.x - 0.5) * a, 0.5 - uv.y);
  let o = vec3f(0.0, 0.0, -MM_F);
  let rd = normalize(vec3f(p, MM_F));
  let ci = vec2i(floor(uv * d));
  var best = 1e9;
  var bp: MmPane;
  var bl = vec2f(0.0);
  var bij = vec2i(0);
  for (var dy = -1; dy <= 1; dy++) {
    for (var dx = -1; dx <= 1; dx++) {
      let ij = ci + vec2i(dx, dy);
      if (ij.x < 0 || ij.y < 0 || ij.x >= i32(d.x) || ij.y >= i32(d.y)) { continue; }
      let pn = mm_pane(ij, d);
      let den = dot(rd, pn.n);
      if (abs(den) < 1e-4) { continue; }
      let t = dot(pn.c - o, pn.n) / den;
      if (t <= 0.0 || t >= best) { continue; }
      let hp = o + rd * t - pn.c;
      let l = vec2f(dot(hp, pn.u), dot(hp, pn.v));
      if (abs(l.x) > pn.h.x || abs(l.y) > pn.h.y) { continue; }
      best = t; bp = pn; bl = l; bij = ij;
    }
  }
  let k = mm_kick();
  if (best > 1e8) {
    // the wall behind: dark, a faint ghost of the picture, lit a little by the kick
    let ghost = tex_in(uv).rgb;
    return vec4f(palette(0.08) * (0.18 + 0.2 * k) + ghost * 0.07 + palette(0.3) * 0.04 * (1.0 - uv.y), 1.0);
  }
  let hit = o + rd * best;
  let r = reflect(rd, bp.n);
  let zp = MM_F * p_depth();
  let sdist = (hit.z + zp) / max(-r.z, 0.08);
  var pic = (hit + r * sdist).xy / (1.0 + p_depth());
  if (p_flip() > 0.5 && (bij.x & 1) == 1) { pic.x = 2.0 * bp.c.x - pic.x; }
  let puv = mm_wrap(vec2f(pic.x / a + 0.5, 0.5 - pic.y));
  var col = tex_in(puv).rgb;
  // glass: a turned pane is a little darker, and tinted per pane
  let facing = clamp(-dot(rd, bp.n), 0.0, 1.0);
  col *= mix(0.7, 1.0, facing * facing);
  let tc = palette(fract(bp.seed * 0.83 + 0.1));
  col *= mix(vec3f(1.0), clamp(tc / max(mm_luma(tc), 0.06), vec3f(0.0), vec3f(2.5)), p_tint());
  // glint from a light up left, behind the eye
  let L = normalize(vec3f(-0.45, 0.6, -1.0));
  let spec = pow(max(dot(r, L), 0.0), 48.0);
  col += palette(0.92) * spec * p_sheen() * (0.6 + 1.2 * k + bass());
  // bevel: a dark groove and a bright edge
  let e = min(bp.h.x - abs(bl.x), bp.h.y - abs(bl.y));
  let px = 1.0 / resolution().y;
  let edge = 1.0 - smoothstep(0.0, 2.5 * px, e);
  let groove = smoothstep(2.5 * px, 5.0 * px, e);
  col *= mix(0.55, 1.0, groove);
  col += palette(0.78) * edge * p_rim() * (0.5 + 0.8 * k + 0.4 * spec);
  return vec4f(max(col, vec3f(0.0)), 1.0);
}
