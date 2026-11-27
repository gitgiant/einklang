// Pixel art: a low-res grid, a retro palette, an ordered dither, hard pixels.

// six fixed palettes of 16 (sRGB); Game Boy uses its first 4
var<private> PAL: array<u32, 96> = array<u32, 96>(
  // PICO-8
  0x000000u, 0x1d2b53u, 0x7e2553u, 0x008751u, 0xab5236u, 0x5f574fu, 0xc2c3c7u, 0xfff1e8u,
  0xff004du, 0xffa300u, 0xffec27u, 0x00e436u, 0x29adffu, 0x83769cu, 0xff77a8u, 0xffccaau,
  // NES (a 16-colour pick of the 2C02)
  0x000000u, 0xfcfcfcu, 0xbcbcbcu, 0x7c7c7cu, 0xa40000u, 0xf83800u, 0xf87858u, 0xfca044u,
  0xf8b800u, 0x00a800u, 0x58d854u, 0x0058f8u, 0x6888fcu, 0x3cbcfcu, 0x940084u, 0xd800ccu,
  // C64 (Pepto)
  0x000000u, 0xffffffu, 0x68372bu, 0x70a4b2u, 0x6f3d86u, 0x588d43u, 0x352879u, 0xb8c76fu,
  0x6f4f25u, 0x433900u, 0x9a6759u, 0x444444u, 0x6c6c6cu, 0x9ad284u, 0x6c5eb5u, 0x959595u,
  // CGA / EGA 16
  0x000000u, 0x0000aau, 0x00aa00u, 0x00aaaau, 0xaa0000u, 0xaa00aau, 0xaa5500u, 0xaaaaaau,
  0x555555u, 0x5555ffu, 0x55ff55u, 0x55ffffu, 0xff5555u, 0xff55ffu, 0xffff55u, 0xffffffu,
  // Game Boy DMG
  0x0f380fu, 0x306230u, 0x8bac0fu, 0x9bbc0fu, 0x0f380fu, 0x306230u, 0x8bac0fu, 0x9bbc0fu,
  0x0f380fu, 0x306230u, 0x8bac0fu, 0x9bbc0fu, 0x0f380fu, 0x306230u, 0x8bac0fu, 0x9bbc0fu,
  // vapor: night purples, hot pink, cyan, mint, cream
  0x0d0221u, 0x241734u, 0x2e2157u, 0x541388u, 0x8b1e9bu, 0xd61c8bu, 0xff2a6du, 0xff71ceu,
  0xffa3d7u, 0xb967ffu, 0x7b5cffu, 0x01cdfeu, 0x05d9e8u, 0x05ffa1u, 0xfffb96u, 0xf5f5ffu
);

fn hexc(c: u32) -> vec3f {
  return vec3f(f32((c >> 16u) & 255u), f32((c >> 8u) & 255u), f32(c & 255u)) / 255.0;
}
fn to_srgb(c: vec3f) -> vec3f { return pow(clamp(c, vec3f(0.0), vec3f(1.0)), vec3f(1.0 / 2.2)); }
fn to_lin(c: vec3f) -> vec3f { return pow(max(c, vec3f(0.0)), vec3f(2.2)); }
fn hash2(a: f32, b: f32) -> f32 { return fract(sin(a * 127.1 + b * 311.7) * 43758.5453); }

// ordered dither threshold of a 2^k x 2^k Bayer matrix, 0..1
fn bayer(x: u32, y: u32, k: u32) -> f32 {
  var v = 0u;
  for (var i = 0u; i < k; i++) {
    let xb = (x >> i) & 1u;
    let yb = (y >> i) & 1u;
    v = v | ((((xb ^ yb) << 1u) | yb) << (2u * (k - 1u - i)));
  }
  return (f32(v) + 0.5) / f32(1u << (2u * k));
}

fn pal_color(p: u32, i: u32) -> vec3f {
  if (p == 6u) {
    if (i == 8u) { return vec3f(0.0); }
    return to_srgb(palette(f32(i) / 7.0));
  }
  return hexc(PAL[p * 16u + i]);
}

fn shade(uv: vec2f) -> vec4f {
  let h = floor(p_pixels());
  let n = vec2f(max(1.0, floor(h * aspect() + 0.5)), h);

  // shake: a whole-pixel jolt, re-rolled 30 times a second
  let st = floor(time() * 30.0);
  let amp = floor(p_shake() * 6.0 + 0.5);
  let off = floor((vec2f(hash2(st, 1.0), hash2(st, 2.0)) * 2.0 - 1.0) * amp + 0.5);
  let cell = floor(uv * n) + off;

  // box-sample the cell (4 taps) so thin details don't shimmer
  var c = vec3f(0.0);
  for (var j = 0; j < 2; j++) {
    for (var i = 0; i < 2; i++) {
      c += tex_in((cell + vec2f(0.25 + 0.5 * f32(i), 0.25 + 0.5 * f32(j))) / n).rgb;
    }
  }
  var s = to_srgb(c * 0.25 * p_gain());

  let k = u32(p_matrix()) + 1u;
  let cx = u32(cell.x + 4096.0);
  let cy = u32(cell.y + 4096.0);
  let t = bayer(cx, cy, k) - 0.5;
  let p = min(u32(p_palette()), 6u);

  var best = vec3f(0.0);
  if (p == 4u) {
    // Game Boy: four shades by brightness
    let l = dot(s, vec3f(0.299, 0.587, 0.114)) + t * 0.25 * p_dither();
    best = hexc(PAL[64u + u32(clamp(floor(l * 4.0), 0.0, 3.0))]);
  } else {
    let cnt = select(16u, 9u, p == 6u);
    s += t * select(0.13, 0.2, p == 6u) * p_dither();
    var bd = 1e9;
    for (var i = 0u; i < cnt; i++) {
      let q = pal_color(p, i);
      let d = s - q;
      let e = dot(d * d, vec3f(0.3, 0.45, 0.25));
      if (e < bd) { bd = e; best = q; }
    }
  }

  // LCD gaps: one screen pixel at the cell's right and bottom edge
  let cellpx = resolution() / n;
  let f = fract(uv * n) * cellpx;
  let gap = select(0.0, 1.0, f.x > cellpx.x - 1.0 || f.y > cellpx.y - 1.0);
  let g = 1.0 - gap * p_grid() * 0.65 * step(3.0, cellpx.y);
  return vec4f(to_lin(best) * g, 1.0);
}
