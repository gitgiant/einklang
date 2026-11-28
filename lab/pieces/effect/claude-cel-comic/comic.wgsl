struct Cc {
  res: vec2f, time: f32, aspect: f32,
  bands: f32, ink: f32, dot: f32, shade: f32,      // tone steps, ink width px, halftone cell px, dot reach
  sat: f32, tint: f32, benday: f32, blacks: f32,
  gutter: f32, border: f32, seed: f32, n_burst: f32, // gutter / border share of height, layout index, bursts
  hit: f32, bass: f32, wobble: f32, page_t: f32,     // latest hit (x punch), bass 0..1, line wobble, 0..1 through the layout
  detail: f32, lines: f32, life: f32, pal_n: f32,
  paper: vec4f, ink_c: vec4f,
  pal: array<vec4f, 8>,     // linear rgb, dark to light
  cut: array<vec4f, 7>,     // heap of cuts: axis (-1 none, 0 x, 1 y), pos, slant, _
  burst: array<vec4f, 8>,   // two per burst: (x, y uv, age s, size), (rot, spikes, seed, loud)
};
@group(0) @binding(0) var<uniform> U: Cc;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var src: texture_2d<f32>;

const CC_TAU = 6.2831853;

fn cc_tap(uv: vec2f) -> vec3f { return max(textureSampleLevel(src, samp, uv, 0.0).rgb, vec3f(0.0)); }
fn cc_luma(c: vec3f) -> f32 { return dot(c, vec3f(0.2126, 0.7152, 0.0722)); }
fn cc_h(a: u32, b: u32) -> f32 { return f32(h32(a, b) >> 8u) / 16777216.0; }
fn cc_pal(x: f32) -> vec3f {
  let n = max(i32(U.pal_n), 1);
  let f = clamp(x, 0.0, 1.0) * f32(n - 1);
  let i = min(i32(floor(f)), n - 1);
  let j = min(i + 1, n - 1);
  return mix(U.pal[i].rgb, U.pal[j].rgb, f - f32(i));
}
fn cc_cbrt(x: f32) -> f32 { return sign(x) * pow(abs(x), 1.0 / 3.0); }
fn cc_lab(c: vec3f) -> vec3f {
  let l = cc_cbrt(0.4122214708 * c.r + 0.5363325363 * c.g + 0.0514459929 * c.b);
  let m = cc_cbrt(0.2119034982 * c.r + 0.6806995451 * c.g + 0.1073969566 * c.b);
  let s = cc_cbrt(0.0883024619 * c.r + 0.2817188376 * c.g + 0.6299787005 * c.b);
  return vec3f(0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
               1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
               0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s);
}
fn cc_rgb(c: vec3f) -> vec3f {
  let l = c.x + 0.3963377774 * c.y + 0.2158037573 * c.z;
  let m = c.x - 0.1055613458 * c.y - 0.0638541728 * c.z;
  let s = c.x - 0.0894841775 * c.y - 1.2914855480 * c.z;
  let l3 = l * l * l; let m3 = m * m * m; let s3 = s * s * s;
  return max(vec3f(4.0767416621 * l3 - 3.3077115913 * m3 + 0.2309699292 * s3,
                   -1.2684380046 * l3 + 2.6097574011 * m3 - 0.3413193965 * s3,
                   -0.0041960863 * l3 - 0.7034186147 * m3 + 1.7076147010 * s3), vec3f(0.0));
}
fn cc_rot(p: vec2f, a: f32) -> vec2f { let c = cos(a); let s = sin(a); return vec2f(c * p.x - s * p.y, s * p.x + c * p.y); }

/** Halftone coverage 0..1 of a dot grid at pixel p (cell px, angle) for a dot of area share `amt`. */
fn cc_dots(p: vec2f, cell: f32, ang: f32, amt: f32) -> f32 {
  let q = cc_rot(p, ang) / cell;
  let d = length(fract(q) - 0.5);
  let r = sqrt(clamp(amt, 0.0, 1.0)) * 0.6;
  let aa = 0.7 / cell;
  return smoothstep(r + aa, r - aa, d) * step(0.02, amt);
}

/** Radius of a spiky burst at angle a (tips jittered per spike), share of its size. */
fn cc_star(a: f32, spikes: f32, seed: u32, inner: f32) -> f32 {
  let f = a / CC_TAU * spikes;
  let k = floor(f);
  let tri = 1.0 - abs(fract(f) - 0.5) * 2.0;
  let j = cc_h(seed, u32(i32(k) + 64));
  return inner + (1.0 - inner + 0.35 * j) * tri;
}

struct Panel { leaf: u32, edge: f32, lo: vec2f, hi: vec2f };

/** Which panel uv is in, and its distance (height units) to the nearest cut or page edge. */
fn cc_panel(uv: vec2f) -> Panel {
  var o: Panel;
  o.lo = vec2f(0.0); o.hi = vec2f(1.0);
  var n = 0u;
  var e = min(min(uv.x, 1.0 - uv.x) * U.aspect, min(uv.y, 1.0 - uv.y)) - U.gutter * 0.5;
  for (var d = 0; d < 3; d++) {
    if (n >= 7u) { break; }
    let c = U.cut[n];
    if (c.x < 0.0) { break; }
    let sz = o.hi - o.lo;
    let rel = (uv - o.lo) / max(sz, vec2f(1e-4));
    if (c.x < 0.5) {
      let at = c.y + c.z * (rel.y - 0.5);
      let xc = o.lo.x + sz.x * at;
      e = min(e, abs(uv.x - xc) * U.aspect / sqrt(1.0 + pow(c.z * sz.x * U.aspect / max(sz.y, 1e-4), 2.0)));
      let xm = o.lo.x + sz.x * c.y;
      if (uv.x < xc) { o.hi.x = xm; n = 2u * n + 1u; } else { o.lo.x = xm; n = 2u * n + 2u; }
    } else {
      let at = c.y + c.z * (rel.x - 0.5);
      let yc = o.lo.y + sz.y * at;
      e = min(e, abs(uv.y - yc) / sqrt(1.0 + pow(c.z * sz.y / max(sz.x * U.aspect, 1e-4), 2.0)));
      let ym = o.lo.y + sz.y * c.y;
      if (uv.y < yc) { o.hi.y = ym; n = 2u * n + 1u; } else { o.lo.y = ym; n = 2u * n + 2u; }
    }
  }
  o.leaf = n;
  o.edge = e - U.gutter * 0.5;
  return o;
}

/** The bursts over the page: rgb, alpha. */
fn cc_bursts(uv: vec2f) -> vec4f {
  var col = vec3f(0.0);
  var a = 0.0;
  let nb = i32(U.n_burst);
  for (var i = nb - 1; i >= 0; i--) { // oldest first, the newest on top
    let b0 = U.burst[2 * i];
    let b1 = U.burst[2 * i + 1];
    let age = b0.z;
    if (age > U.life || b0.w <= 0.0) { continue; }
    // pop in with an overshoot, hold, shrink away
    let t = clamp(age / 0.11, 0.0, 1.0);
    let pop = 1.0 + 2.2 * pow(t - 1.0, 3.0) + 1.2 * pow(t - 1.0, 2.0);
    let fade = 1.0 - smoothstep(U.life * 0.7, U.life, age);
    let sc = b0.w * pop * fade;
    if (sc <= 0.001) { continue; }
    let seed = u32(b1.z);
    var p = (uv - b0.xy) * vec2f(U.aspect, 1.0);
    p = cc_rot(p, b1.x + 0.25 * sin(age * 9.0));
    let r = length(p) / sc;
    let ang = atan2(p.y, p.x) + 3.14159265;
    let spikes = b1.y;
    let outer = cc_star(ang, spikes, seed, 0.62);
    let inner = 0.62 * cc_star(ang + 0.3, spikes - 2.0, seed + 7u, 0.6);
    let lw = 0.07;
    // a drop shadow, the black outline, the yellow star, the red one, ink exclamation marks
    let ps = p - vec2f(0.035, 0.045) * sc;
    let rs = length(ps) / sc;
    let as_ = atan2(ps.y, ps.x) + 3.14159265;
    let shadow = step(rs, cc_star(as_, spikes, seed, 0.62) + lw);
    var c = col;
    var al = max(a, shadow * 0.85);
    c = mix(c, U.ink_c.rgb, shadow);
    let fill_o = step(r, outer);
    let line_o = step(r, outer + lw);
    let fill_i = step(r, inner);
    let line_i = step(abs(r - inner), lw * 0.6);
    let hot = cc_pal(0.92) * 1.25 + vec3f(0.25, 0.2, 0.0);
    let warm = mix(vec3f(0.85, 0.06, 0.04), cc_pal(0.55), 0.35) * 1.15;
    c = mix(c, U.ink_c.rgb, line_o);
    c = mix(c, hot, fill_o);
    c = mix(c, warm, fill_i);
    c = mix(c, U.ink_c.rgb, line_i * fill_o);
    al = max(al, line_o);
    // one to three slanted exclamation marks inside, unscaled by the rotation jitter
    let nm = 1 + i32(cc_h(seed, 3u) * 2.99);
    let q = p / sc;
    for (var m = 0; m < 3; m++) {
      if (m >= nm) { break; }
      let x = (f32(m) - f32(nm - 1) * 0.5) * 0.26;
      var e = q - vec2f(x, 0.0);
      e.x -= e.y * 0.18;
      let bar = vec2f(abs(e.x) - 0.055 + e.y * 0.03, abs(e.y + 0.07) - 0.2);
      let db = length(max(bar, vec2f(0.0))) + min(max(bar.x, bar.y), 0.0);
      let dd = length(e - vec2f(0.0, 0.25)) - 0.065;
      let dm = min(db, dd);
      c = mix(c, U.ink_c.rgb, step(dm, 0.0) * fill_i);
    }
    col = c;
    a = al;
  }
  return vec4f(col, a);
}

@fragment fn fs_comic(v: VOut) -> @location(0) vec4f {
  let uv = v.uv;
  let px = uv * U.res;
  let pg = cc_panel(uv);
  let paper = U.paper.rgb * (0.95 + 0.05 * cc_h(u32(px.x * 0.5), u32(px.y * 0.5)));
  var col = paper;

  if (pg.edge > 0.0) {
    // this panel's shot of the picture: smaller panels are closer shots, all push in through the layout
    let sz = pg.hi - pg.lo;
    let ctr = (pg.lo + pg.hi) * 0.5;
    let hs = h32(pg.leaf + 11u, u32(U.seed));
    let r1 = f32(hs & 1023u) / 1023.0;
    let r2 = f32((hs >> 10u) & 1023u) / 1023.0;
    let r3 = f32((hs >> 20u) & 1023u) / 1023.0;
    let close = mix(0.55 + 0.35 * r1, 1.0, sz.x * sz.y);
    let k = close * (1.0 - 0.07 * U.page_t) * (1.0 - 0.1 * U.hit);
    let hw = 0.5 * sz * k;
    let aim = mix(ctr, vec2f(0.3 + 0.4 * r2, 0.3 + 0.4 * r3), 0.6);
    let sc = clamp(aim, hw, vec2f(1.0) - hw);
    let suv = sc + (uv - ctr) * k;
    let ang = 0.785 + (r1 - 0.5) * 0.5;

    // ink: Sobel on luma, taps a line width apart, wobbled like a brush
    let wob = U.wobble * vec2f(sin(uv.y * 41.0 + U.time * 1.3 + r2 * 9.0), cos(uv.x * 37.0 - U.time * 1.1)) * 1.5;
    let o = (max(U.ink, 0.6) + wob) / U.res * k;
    let c00 = cc_tap(suv + vec2f(-o.x, -o.y)); let c10 = cc_tap(suv + vec2f(0.0, -o.y)); let c20 = cc_tap(suv + vec2f(o.x, -o.y));
    let c01 = cc_tap(suv + vec2f(-o.x, 0.0));                                           let c21 = cc_tap(suv + vec2f(o.x, 0.0));
    let c02 = cc_tap(suv + vec2f(-o.x, o.y));  let c12 = cc_tap(suv + vec2f(0.0, o.y));  let c22 = cc_tap(suv + vec2f(o.x, o.y));
    let l00 = sqrt(cc_luma(c00)); let l10 = sqrt(cc_luma(c10)); let l20 = sqrt(cc_luma(c20));
    let l01 = sqrt(cc_luma(c01)); let l21 = sqrt(cc_luma(c21));
    let l02 = sqrt(cc_luma(c02)); let l12 = sqrt(cc_luma(c12)); let l22 = sqrt(cc_luma(c22));
    let gx = (l20 + 2.0 * l21 + l22) - (l00 + 2.0 * l01 + l02);
    let gy = (l02 + 2.0 * l12 + l22) - (l00 + 2.0 * l10 + l20);
    let g = length(vec2f(gx, gy)) * 0.25;
    let inked = smoothstep(U.detail, U.detail * 1.6, g) * step(0.01, U.ink);

    // the colour plate, knocked out of register on a hit
    let mis = vec2f(cos(r3 * 6.28), sin(r3 * 6.28)) * U.hit * 9.0 / U.res;
    let cen = cc_tap(suv + mis);
    let flatc = (c00 + c10 + c20 + c01 + c21 + c02 + c12 + c22 + 2.0 * cen) * 0.1; // flatter cels
    let lab = cc_lab(cen);
    let labf = cc_lab(flatc);
    let L = clamp(lab.x, 0.0, 1.0);
    // cel bands
    let n = max(U.bands, 2.0);
    let f = L * n;
    let i = min(floor(f), n - 1.0);
    let t = clamp((i + smoothstep(0.92, 1.0, f - i)) / (n - 1.0), 0.0, 1.0);
    let chroma = labf.yz * U.sat * (0.7 + 0.5 * (1.0 - abs(t - 0.55)));
    var tone = cc_rgb(vec3f(mix(0.22, 0.95, t), chroma));
    tone = mix(tone, cc_pal(0.12 + 0.8 * t), U.tint);
    tone = mix(tone, paper, smoothstep(0.93, 1.0, t) * 0.7);

    // Ben-Day dots in the light tones: the colour as dots on the paper
    let bd = U.benday * smoothstep(0.42, 0.62, t) * (1.0 - smoothstep(0.88, 1.0, t));
    let bdot = cc_dots(px, U.dot * 0.8, ang - 0.52, 0.5);
    tone = mix(tone, mix(paper, tone * 1.08, bdot), bd);
    // halftone in the shadows: ink dots growing as it darkens (continuous lightness, so they grade)
    let sh = clamp((U.shade * 0.85 - L) / max(U.shade * 0.85, 1e-3), 0.0, 1.0);
    let hdot = cc_dots(px, U.dot, ang, sh * 0.95);
    tone = mix(tone, tone * 0.18 + U.ink_c.rgb * 0.6, hdot * 0.92);
    // solid blacks
    tone = mix(tone, U.ink_c.rgb, smoothstep(U.blacks + 0.03, U.blacks - 0.03, L));
    col = mix(tone, U.ink_c.rgb, inked);

    // speed lines from the freshest burst
    if (U.n_burst > 0.5 && U.lines > 0.0) {
      let b0 = U.burst[0];
      let fresh = U.lines * (1.0 - smoothstep(0.0, 0.45, b0.z));
      if (fresh > 0.01) {
        let d = (uv - b0.xy) * vec2f(U.aspect, 1.0);
        let a = atan2(d.y, d.x) / CC_TAU + 0.5;
        let seg = floor(a * 140.0);
        let hl = cc_h(u32(seg), u32(U.burst[1].z));
        let wedge = 1.0 - abs(fract(a * 140.0) - 0.5) * 2.0;
        let rr = length(d);
        let on = step(0.55, hl) * smoothstep(0.5 + 0.4 * hl, 0.9, wedge + rr * 0.15) * smoothstep(b0.w * 0.9, b0.w * 2.2, rr);
        col = mix(col, U.ink_c.rgb, on * fresh);
      }
    }
    // the panel border
    col = mix(U.ink_c.rgb, col, smoothstep(U.border, U.border + 1.5 / U.res.y, pg.edge));
  }

  let b = cc_bursts(uv);
  col = mix(col, b.rgb, b.a);
  return vec4f(col, 1.0);
}
