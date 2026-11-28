// Anime cel shading in two passes.
//  fs_src: the picture through the action-cut camera (a hard punch-in on every kick, toward a
//          point that changes per kick, with a short shake), or, with nothing picked, a drawn
//          anime landscape (sky, sun, cumulus, ridges, a hill with a sakura tree and a power pole).
//  fs_cel: flat tone bands in OKLab lightness (cool shadows, a white shine band), ink lines from a
//          luma Sobel, then the extras: sky gradient and lens flare on the drop, focus lines and
//          sparkles on onsets, falling sakura petals, an inked impact frame on the first kick of some bars.
struct Cel {
  res: vec2f, time: f32, aspect: f32,
  has: f32, bands: f32, soft: f32, light: f32,
  sat: f32, grade: f32, ink: f32, ink_th: f32,
  zoom: f32, cx: f32, cy: f32, ink_amt: f32,
  hit_age: f32, hit_seed: f32, hit_loud: f32, lines: f32,
  petals: f32, sparkle: f32, drop: f32, flare: f32,
  bass: f32, beat: f32, impact: f32, pal_n: f32,
  sx: f32, sy: f32, shadow: f32, shine: f32,
  pal: array<vec4f, 8>,   // linear rgb
};
@group(0) @binding(0) var<uniform> U: Cel;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var src: texture_2d<f32>;

const CA_PI = 3.14159265;
const CA_LUMA = vec3f(0.2126, 0.7152, 0.0722);

fn ca_pal(x: f32) -> vec3f {
  let n = max(i32(U.pal_n), 1);
  let f = clamp(x, 0.0, 1.0) * f32(n - 1);
  let i = min(i32(floor(f)), n - 1);
  let j = min(i + 1, n - 1);
  return mix(U.pal[i].rgb, U.pal[j].rgb, f - f32(i));
}
fn ca_h(a: f32, b: f32) -> f32 { return f32(h32(u32(i32(a) + 65536), u32(i32(b) + 65536)) >> 8u) / 16777216.0; }
fn ca_h2(c: vec2f, s: f32) -> f32 { return f32(h32((u32(i32(c.x) + 32768) * 73856093u) ^ (u32(i32(c.y) + 32768) * 19349663u), u32(s)) >> 8u) / 16777216.0; }
fn ca_noise(p: vec2f) -> f32 {
  let i = floor(p); let f = fract(p); let u = f * f * (3.0 - 2.0 * f);
  return mix(mix(ca_h2(i, 7.0), ca_h2(i + vec2f(1.0, 0.0), 7.0), u.x), mix(ca_h2(i + vec2f(0.0, 1.0), 7.0), ca_h2(i + vec2f(1.0, 1.0), 7.0), u.x), u.y);
}
fn ca_fbm(p: vec2f) -> f32 { return 0.5 * ca_noise(p) + 0.3 * ca_noise(p * 2.03 + 17.0) + 0.2 * ca_noise(p * 4.01 + 41.0); }
fn ca_rot(v: vec2f, a: f32) -> vec2f { let c = cos(a); let s = sin(a); return vec2f(v.x * c - v.y * s, v.x * s + v.y * c); }
fn ca_seg(p: vec2f, a: vec2f, b: vec2f) -> f32 { let pa = p - a; let ba = b - a; let h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0); return length(pa - ba * h); }

fn ca_lab(c: vec3f) -> vec3f {
  let l = pow(max(0.4122214708 * c.r + 0.5363325363 * c.g + 0.0514459929 * c.b, 0.0), 1.0 / 3.0);
  let m = pow(max(0.2119034982 * c.r + 0.6806995451 * c.g + 0.1073969566 * c.b, 0.0), 1.0 / 3.0);
  let s = pow(max(0.0883024619 * c.r + 0.2817188376 * c.g + 0.6299787005 * c.b, 0.0), 1.0 / 3.0);
  return vec3f(0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s);
}
fn ca_lin(c: vec3f) -> vec3f {
  let l = pow(c.x + 0.3963377774 * c.y + 0.2158037573 * c.z, 3.0);
  let m = pow(c.x - 0.1055613458 * c.y - 0.0638541728 * c.z, 3.0);
  let s = pow(c.x - 0.0894841775 * c.y - 1.291485548 * c.z, 3.0);
  return vec3f(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s);
}

// ---------------------------------------------------------------- the drawn subject (nothing picked)

fn ca_ridge(x: f32) -> f32 { return -0.1 + 0.07 * sin(x * 2.7 + 1.0) + 0.035 * sin(x * 7.3 + 0.4) + 0.012 * sin(x * 19.0); }
fn ca_hill(x: f32) -> f32 { return -0.27 + 0.06 * sin(x * 1.9 + 0.6) + 0.018 * sin(x * 5.3); }

fn ca_scene(q: vec2f) -> vec3f {
  let a = U.aspect;
  let p = vec2f((q.x - 0.5) * a, 0.5 - q.y);  // y up, screen heights
  let t = U.time;
  // sky: deep blue overhead, cyan, warm haze at the horizon
  let ht = clamp(p.y * 1.25 + 0.35, 0.0, 1.0);
  var col = mix(srgb2lin(vec3f(1.0, 0.76, 0.6)), srgb2lin(vec3f(0.28, 0.6, 0.92)), smoothstep(0.0, 0.35, ht));
  col = mix(col, srgb2lin(vec3f(0.06, 0.18, 0.58)), smoothstep(0.35, 1.0, ht));
  // sun, upper left, breathing with the bass
  let sp = vec2f(-0.38 * a, 0.25);
  let sd = length(p - sp);
  col += srgb2lin(vec3f(1.0, 0.93, 0.75)) * (exp(-sd * 12.0) * (0.25 + 0.5 * U.bass) + smoothstep(0.062, 0.055, sd) * 2.5);
  // a towering cumulus, right of centre: circles with a flat base, puffed by noise
  let cc = vec2f(0.22 * a + 0.02 * sin(t * 0.05), -0.02);
  var cd = 1e3;
  for (var i = 0; i < 7; i++) {
    let fi = f32(i);
    let o = vec2f((fi - 3.0) * 0.085 + 0.03 * sin(fi * 2.3), 0.02 + 0.16 * (1.0 - abs(fi - 3.2) / 3.5) + 0.02 * cos(fi * 1.7));
    let r = 0.07 + 0.06 * (1.0 - abs(fi - 3.0) / 3.0);
    cd = min(cd, length(p - cc - o) - r);
  }
  cd += (ca_fbm(p * 9.0 + vec2f(t * 0.02, 0.0)) - 0.5) * 0.05;
  cd = max(cd, (cc.y - 0.03) - p.y);
  if (cd < 0.0) {
    // lit from the sun's side, shadowed underneath
    let lit = clamp(0.55 + (p.y - cc.y) * 2.2 - (p.x - cc.x) * 0.9 + (ca_fbm(p * 14.0) - 0.5) * 0.5, 0.0, 1.0);
    col = mix(srgb2lin(vec3f(0.45, 0.5, 0.78)), srgb2lin(vec3f(1.0, 0.98, 0.95)) * 1.05, lit);
  }
  // a drifting strip of small clouds
  let band = smoothstep(0.05, 0.1, p.y) * smoothstep(0.3, 0.2, p.y);
  let small = smoothstep(0.6, 0.63, ca_fbm(vec2f(p.x * 2.2 + t * 0.025, p.y * 6.0)) * band + 0.2 * band);
  if (cd >= 0.0) { col = mix(col, srgb2lin(vec3f(0.9, 0.9, 0.97)), small); }
  // far ridge in haze, near hill in grass
  if (p.y < ca_ridge(p.x)) { col = mix(srgb2lin(vec3f(0.24, 0.3, 0.58)), col, 0.2); }
  let hy = ca_hill(p.x);
  if (p.y < hy) {
    let g = clamp((p.y - hy) * -4.0, 0.0, 1.0);
    col = mix(srgb2lin(vec3f(0.36, 0.64, 0.26)), srgb2lin(vec3f(0.08, 0.26, 0.16)), g);
  }
  // power pole and its wires, right
  let px = 0.36 * a;
  let top = 0.34;
  let pole = max(abs(p.x - px) - 0.007, max(p.y - top, ca_hill(px) - 0.02 - p.y));
  let arm = max(abs(p.x - px) - 0.055, abs(p.y - (top - 0.03)) - 0.005);
  let arm2 = max(abs(p.x - px) - 0.04, abs(p.y - (top - 0.07)) - 0.004);
  let ink = srgb2lin(vec3f(0.16, 0.16, 0.26));
  let pix = 1.0 / U.res.y;
  if (min(pole, min(arm, arm2)) < 0.0) { col = ink; }
  for (var w = 0; w < 3; w++) {
    let fw = f32(w);
    let x0 = px + (fw - 1.0) * 0.05;
    let y0 = top - 0.03 - select(0.0, 0.04, w == 1);
    let dx = p.x - x0;
    let wy = y0 - 0.22 * (dx / a) * (dx / a) * (0.9 + 0.2 * fw) + 0.05 * dx;
    if (p.x < x0 && abs(p.y - wy) < 1.2 * pix) { col = ink; }
  }
  // sakura tree on the left: trunk, two branches, a pink canopy swaying on the beat
  let tx = -0.33 * a;
  let ty = ca_hill(tx);
  let sway = 0.006 * sin(t * 1.3) + 0.01 * U.beat;
  var trunk = ca_seg(p, vec2f(tx, ty - 0.02), vec2f(tx + 0.02, ty + 0.2)) - mix(0.018, 0.01, clamp((p.y - ty) / 0.2, 0.0, 1.0));
  trunk = min(trunk, ca_seg(p, vec2f(tx + 0.015, ty + 0.14), vec2f(tx - 0.1, ty + 0.24)) - 0.007);
  trunk = min(trunk, ca_seg(p, vec2f(tx + 0.018, ty + 0.16), vec2f(tx + 0.12, ty + 0.25)) - 0.006);
  var can = 1e3;
  for (var i = 0; i < 9; i++) {
    let fi = f32(i);
    let o = vec2f(cos(fi * 2.4) * (0.06 + 0.07 * fract(fi * 0.37)) * 1.5, 0.27 + sin(fi * 2.4) * 0.07 + 0.02 * fract(fi * 0.71));
    can = min(can, length(p - vec2f(tx + 0.01 + sway * (o.y - 0.15) * 4.0, ty) - o) - (0.065 + 0.025 * fract(fi * 0.53)));
  }
  can += (ca_fbm(p * 22.0) - 0.5) * 0.03;
  if (trunk < 0.0) { col = srgb2lin(vec3f(0.3, 0.2, 0.22)); }
  if (can < 0.0) {
    let lit = clamp(0.5 + (p.y - ty - 0.27) * 5.0 - (p.x - tx) * 2.0 + (ca_fbm(p * 30.0) - 0.5) * 0.6, 0.0, 1.0);
    col = mix(srgb2lin(vec3f(0.86, 0.5, 0.66)), srgb2lin(vec3f(1.0, 0.86, 0.92)), lit);
  }
  return col;
}

@fragment fn fs_src(in: VOut) -> @location(0) vec4f {
  let c = vec2f(U.cx, U.cy);
  let q = c + (in.uv - c) / U.zoom + vec2f(U.sx, U.sy);
  if (U.has > 0.5) { return vec4f(max(textureSampleLevel(src, samp, q, 0.0).rgb, vec3f(0.0)), 1.0); }
  return vec4f(ca_scene(q), 1.0);
}

// ---------------------------------------------------------------- the cel pass

fn ca_tap(uv: vec2f) -> vec3f { return min(textureSampleLevel(src, samp, uv, 0.0).rgb, vec3f(4.0)); }
fn ca_l(c: vec3f) -> f32 { return sqrt(clamp(dot(c, CA_LUMA), 0.0, 1.0)); }

/** One falling petal layer: rgb, coverage. */
fn ca_petals(uv: vec2f, cs: f32, speed: f32, dens: f32, seed: f32, far: f32) -> vec4f {
  let a = U.aspect;
  let t = U.time;
  let pos = vec2f(uv.x * a, uv.y) - vec2f(-0.45, 1.0) * t * speed;
  let cell = floor(pos / cs);
  let h0 = ca_h2(cell, seed);
  if (h0 > dens) { return vec4f(0.0); }
  let h1 = ca_h2(cell, seed + 1.0);
  let h2 = ca_h2(cell, seed + 2.0);
  var l = fract(pos / cs) - 0.5;
  l -= vec2f((h1 - 0.5) * 0.4 + 0.12 * sin(t * (1.2 + h2) + h1 * 6.3), (h2 - 0.5) * 0.4);
  l = ca_rot(l, t * (0.8 + 1.5 * h1) + h2 * 6.3);
  let flip = cos(t * (1.5 + h2 * 2.0) + h1 * 9.0);
  l.x /= max(abs(flip), 0.25);
  let r = 0.09 + 0.07 * h2;
  // an ellipse with a notch at its tip
  var d = length(l / vec2f(r * 0.62, r)) - 1.0;
  d = max(d, -(length(l - vec2f(0.0, r * 1.05)) / r - 0.28));
  let pxc = 1.6 / (U.res.y * cs);
  let cov = smoothstep(pxc / r, -pxc / r, d) * smoothstep(dens, dens - 0.08, h0);
  if (cov <= 0.0) { return vec4f(0.0); }
  let front = select(srgb2lin(vec3f(0.92, 0.55, 0.7)), srgb2lin(vec3f(1.0, 0.78, 0.86)), flip > 0.0);
  var col = select(front * 0.8, front * 1.15, l.y < 0.0);  // two cel tones
  col = mix(col, srgb2lin(vec3f(0.55, 0.25, 0.38)), smoothstep(-2.5 * pxc / r, -pxc / r, d) * 0.85);  // ink rim
  col = mix(col, vec3f(dot(col, CA_LUMA)) * 0.9 + ca_pal(0.6) * 0.1, far);
  return vec4f(col, cov);
}

@fragment fn fs_cel(in: VOut) -> @location(0) vec4f {
  let uv = in.uv;
  let a = U.aspect;
  let px = 1.0 / U.res;
  let d = px * U.ink;
  // 3x3 at the ink step: a slight blur for flat fills, a Sobel for the lines
  let tl = ca_tap(uv + vec2f(-d.x, -d.y)); let tc = ca_tap(uv + vec2f(0.0, -d.y)); let tr = ca_tap(uv + vec2f(d.x, -d.y));
  let ml = ca_tap(uv + vec2f(-d.x, 0.0)); let mc = ca_tap(uv); let mr = ca_tap(uv + vec2f(d.x, 0.0));
  let bl = ca_tap(uv + vec2f(-d.x, d.y)); let bc = ca_tap(uv + vec2f(0.0, d.y)); let br = ca_tap(uv + vec2f(d.x, d.y));
  let base = (mc * 4.0 + (tc + ml + mr + bc) * 2.0 + tl + tr + bl + br) / 16.0;
  let ltl = ca_l(tl); let ltc = ca_l(tc); let ltr = ca_l(tr); let lml = ca_l(ml); let lmr = ca_l(mr);
  let lbl = ca_l(bl); let lbc = ca_l(bc); let lbr = ca_l(br);
  let gx = (ltr + 2.0 * lmr + lbr) - (ltl + 2.0 * lml + lbl);
  let gy = (lbl + 2.0 * lbc + lbr) - (ltl + 2.0 * ltc + ltr);
  let g = length(vec2f(gx, gy));
  let th = mix(0.75, 0.1, U.ink_th);
  let line = smoothstep(th, th * 1.6, g) * U.ink_amt;

  // tone bands on OKLab lightness
  let lab = ca_lab(base);
  let n = max(U.bands, 1.5);
  let x = clamp(lab.x * U.light, 0.0, 0.9999) * n;
  let qi = floor(x);
  let qq = qi + smoothstep(1.0 - U.soft, 1.0, fract(x));
  let k = clamp(qq / (n - 1.0), 0.0, 1.0);  // 0 = deepest shadow band, 1 = the lit band
  let lq = mix(0.3, 0.86, k);
  let chroma = length(lab.yz);
  let ab = lab.yz * U.sat * (1.0 + 0.4 * (1.0 - k)) / max(1.0, chroma * U.sat * 4.0);  // cap: no neon clipping
  var col = max(ca_lin(vec3f(lq, ab)), vec3f(0.0));
  // anime shadows go cool (lavender), lights warm
  let cool = mix(vec3f(0.62, 0.66, 1.08), ca_pal(0.15) / max(dot(ca_pal(0.15), CA_LUMA), 0.02) * 0.8, 0.3);
  col = mix(col, col * cool, (1.0 - k) * U.shadow);
  col *= mix(vec3f(1.0), vec3f(1.06, 1.02, 0.94), k);
  // palette grade by band
  col = mix(col, ca_pal(0.12 + 0.76 * k) * (0.35 + 0.9 * lq), U.grade);
  // the shine: one flat white band on the brightest parts
  let shine = smoothstep(0.88, 0.9, lab.x * U.light) * U.shine;
  col = mix(col, vec3f(1.25, 1.22, 1.15), shine);

  // drop: an anime sky over the bright top of the frame
  let sky_w = U.drop * smoothstep(0.75, 0.05, uv.y) * smoothstep(0.5, 0.8, lab.x) * (1.0 - shine * 0.5);
  if (sky_w > 0.0) {
    let sy = clamp(uv.y / 0.75, 0.0, 1.0);
    var sky = mix(srgb2lin(vec3f(0.1, 0.3, 0.85)), srgb2lin(vec3f(0.45, 0.82, 1.0)), smoothstep(0.0, 0.7, sy));
    sky = mix(sky, srgb2lin(vec3f(1.0, 0.85, 0.85)), smoothstep(0.6, 1.0, sy));
    sky = mix(sky, ca_pal(0.55 + 0.3 * sy), 0.3);
    col = mix(col, sky * (0.8 + 0.4 * k), sky_w * 0.85);
  }

  // ink
  let inkc = ca_pal(0.0) * 0.12 + vec3f(0.01, 0.008, 0.03);
  col = mix(col, inkc, line);

  // lens flare: a hot source upper right, an anamorphic streak, rays and ghosts through the centre
  let fl = U.flare + U.drop * (0.6 + 0.6 * U.beat);
  if (fl > 0.0) {
    let fs = vec2f(0.8 + 0.04 * sin(U.time * 0.11), 0.16 + 0.03 * cos(U.time * 0.07));
    let v = (uv - fs) * vec2f(a, 1.0);
    let r = length(v);
    let ang = atan2(v.y, v.x);
    var f = exp(-r * r * 900.0) * 5.0 + exp(-r * 9.0) * 0.5;
    f += exp(-abs(v.y) * 220.0) * exp(-abs(v.x) * 2.2) * 1.4;
    f += pow(abs(sin(ang * 4.0 + U.time * 0.15)), 30.0) * exp(-r * 6.0) * 1.2;
    var fc = mix(vec3f(1.0, 0.95, 0.85), ca_pal(0.85), 0.25) * f;
    // a halo ring
    fc += ca_pal(0.7) * smoothstep(0.012, 0.0, abs(r - 0.16)) * 0.35;
    let toc = (vec2f(0.5) - fs) * vec2f(a, 1.0);
    for (var i = 0; i < 4; i++) {
      let fi = f32(i);
      let gp = toc * (0.7 + fi * 0.45 + 0.1 * fi * fi);
      let gr = 0.03 + 0.035 * fract(fi * 0.618 + 0.3);
      let gd = length(v - gp);
      // hexagon ghost
      let hq = abs(ca_rot(v - gp, 0.3));
      let hx = max(hq.x * 0.866 + hq.y * 0.5, hq.y);
      let gh = smoothstep(gr, gr * 0.8, hx) * (0.4 + 0.6 * smoothstep(gr * 0.3, gr, gd));
      fc += ca_pal(0.3 + fi * 0.18) * gh * 0.28;
    }
    col += fc * fl;
  }

  // focus lines from the punch centre on each onset: re-dealt every hit
  let le = U.lines * exp(-U.hit_age * 4.0) * (0.45 + 0.55 * U.hit_loud) + U.lines * U.drop * 0.25;
  if (le > 0.01) {
    let v = (uv - vec2f(U.cx, U.cy)) * vec2f(a, 1.0);
    let r = length(v);
    let s = (atan2(v.y, v.x) / (2.0 * CA_PI) + 0.5) * 240.0;
    let cell = floor(s);
    let h = ca_h(cell, U.hit_seed);
    let h2 = ca_h(cell + 500.0, U.hit_seed);
    let w = 0.08 + 0.35 * h2;
    let dl = abs(fract(s) - 0.5);
    let r0 = 0.25 + 0.35 * h + 0.25 * (1.0 - min(le, 1.0));
    let lw = smoothstep(w, w * 0.4, dl) * smoothstep(r0, r0 + 0.2, r) * step(h, 0.6);
    col = mix(col, vec3f(1.4, 1.38, 1.45), clamp(lw * le, 0.0, 1.0));
  }

  // sparkles on the onset: four-point stars, staggered in
  let se = U.sparkle * (0.5 + 0.5 * U.hit_loud);
  if (se > 0.0 && U.hit_age < 1.2) {
    var sp = vec3f(0.0);
    for (var i = 0; i < 10; i++) {
      let fi = f32(i);
      let age = U.hit_age - fi * 0.025;
      if (age < 0.0) { continue; }
      let pos = vec2f(0.08 + 0.84 * ca_h(fi, U.hit_seed + 3.0), 0.08 + 0.84 * ca_h(fi + 20.0, U.hit_seed + 3.0));
      let sz = (0.025 + 0.04 * ca_h(fi + 40.0, U.hit_seed)) * (1.0 + age * 0.6);
      let e = exp(-age * 3.2) * smoothstep(0.0, 0.03, age);
      var v = (uv - pos) * vec2f(a, 1.0);
      v = ca_rot(v, select(0.0, CA_PI * 0.25, i % 3 == 0) + age * 0.8);
      let av = abs(v);
      let star = exp(-av.x / (sz * 0.05)) * exp(-av.y / sz) + exp(-av.y / (sz * 0.05)) * exp(-av.x / sz) + exp(-length(v) / (sz * 0.12));
      sp += mix(vec3f(1.0), ca_pal(0.8 + 0.2 * ca_h(fi + 60.0, U.hit_seed)), 0.35) * star * e;
    }
    col += sp * se * 1.6;
  }

  // sakura: three layers of falling petals, thicker after a run of onsets
  let pd = U.petals;
  if (pd > 0.0) {
    for (var li = 0; li < 3; li++) {
      let fl2 = f32(li);
      let cs = 0.07 + 0.06 * fl2;
      let pe = ca_petals(uv, cs, 0.05 + 0.04 * fl2, pd * (0.35 + 0.1 * fl2), 11.0 + fl2 * 7.0, 0.4 - fl2 * 0.2);
      col = mix(col, pe.rgb, pe.a);
    }
  }

  // impact frame: ink and paper, a red rim, for a moment
  if (U.impact > 0.0) {
    let lit = step(0.5, lab.x * U.light) * (1.0 - line);
    var ic = mix(vec3f(0.015, 0.01, 0.02), vec3f(1.3, 1.28, 1.25), lit);
    let rim = smoothstep(0.03, 0.12, g) * (1.0 - smoothstep(th, th * 1.6, g));
    ic = mix(ic, mix(vec3f(1.2, 0.08, 0.1), ca_pal(0.9), 0.3), rim * 0.8);
    col = mix(col, ic, U.impact);
  }
  return vec4f(max(col, vec3f(0.0)), 1.0);
}
