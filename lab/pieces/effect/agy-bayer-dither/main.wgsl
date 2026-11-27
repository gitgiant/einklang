// Pixel-art vaporwave crossover effect: integer pixel grid + 4x4 Bayer dithering
// + palette quantization + bass/onset pixel-snapped chromatic pop.

fn bayer4(p: vec2i) -> f32 {
  let x = ((p.x % 4) + 4) % 4;
  let y = ((p.y % 4) + 4) % 4;
  let m = array<f32, 16>(
     0.0,  8.0,  2.0, 10.0,
    12.0,  4.0, 14.0,  6.0,
     3.0, 11.0,  1.0,  9.0,
    15.0,  7.0, 13.0,  5.0
  );
  return (m[y * 4 + x] + 0.5) / 16.0;
}

fn shade(uv: vec2f) -> vec4f {
  let orig = tex_in(uv);
  let b = bass();
  let on = onset();
  let r = rms();

  // Slightly coarsen pixel grid on heavy onsets for a retro crunch
  let cells = max(32.0, floor(p_cells() * (1.0 - on * 0.14)));
  let grid = vec2f(floor(cells * aspect()), cells);
  let pix = floor(uv * grid);
  let puv = (pix + 0.5) / grid;

  // Pixel-snapped horizontal chroma offset driven by bass & onset
  let shift_px = floor((0.5 + b * 1.8 + on * 2.8) * p_chroma());
  let dx = vec2f(shift_px / grid.x, 0.0);

  let sr = tex_in(clamp(puv + dx, vec2f(0.001), vec2f(0.999))).r;
  let sg = tex_in(puv).g;
  let sb = tex_in(clamp(puv - dx, vec2f(0.001), vec2f(0.999))).b;
  let src = max(vec3f(sr, sg, sb), vec3f(0.0));

  let dval = (bayer4(vec2i(pix)) - 0.5) * p_dither();
  let lv = max(2.0, floor(p_levels()));

  // Quantized RGB with Bayer dithering
  let tone = src / (1.0 + src); // gentle HDR compress before quantize
  let q_rgb = floor(clamp(tone + vec3f(dval / lv), vec3f(0.0), vec3f(0.999)) * lv) / (lv - 1.0);
  let hdr_rgb = q_rgb * (1.0 + max(src.r, max(src.g, src.b)) * 0.45);

  // Vaporwave palette mapping via dithered luminance
  let luma = dot(tone, vec3f(0.2126, 0.7152, 0.0722));
  let q_luma = floor(clamp(luma + dval / lv, 0.0, 0.999) * lv) / (lv - 1.0);
  let pal_col = palette(clamp(q_luma + on * 0.08, 0.0, 1.0)) * (0.22 + q_luma * (1.25 + b * 0.55 + on * 0.45));

  var out_col = mix(hdr_rgb, pal_col, p_pal_mix());

  // Subtle retro pixel scanline modulation
  let scan = 0.92 + 0.08 * select(1.0, -1.0, (i32(pix.y) & 1) == 0);
  out_col *= scan * (0.95 + r * 0.25 + on * 0.2);

  return vec4f(mix(orig.rgb, out_col, p_mix()), 1.0);
}
