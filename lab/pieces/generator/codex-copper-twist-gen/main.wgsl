// Five-bit scan rows for the letters in COPPER LINE.
const GLYPHS = array<array<u32, 7>, 8>(
  array<u32, 7>(15, 24, 16, 16, 16, 24, 15), // C
  array<u32, 7>(14, 27, 17, 17, 17, 27, 14), // O
  array<u32, 7>(30, 19, 19, 30, 16, 16, 16), // P
  array<u32, 7>(31, 16, 16, 30, 16, 16, 31), // E
  array<u32, 7>(30, 19, 19, 30, 22, 19, 17), // R
  array<u32, 7>(16, 16, 16, 16, 16, 16, 31), // L
  array<u32, 7>(31, 4, 4, 4, 4, 4, 31),      // I
  array<u32, 7>(17, 25, 29, 23, 19, 17, 17)  // N
);
const MESSAGE = array<u32, 13>(0, 1, 2, 2, 3, 4, 8, 5, 6, 7, 3, 8, 8);

fn glyph(x: f32, y: f32) -> f32 {
  let character = MESSAGE[u32(floor(x / 7.0)) % 13u];
  let col = u32(floor(x)) % 7u;
  if (character == 8u || col > 4u || y < 0.0 || y >= 7.0) {
    return 0.0;
  }
  return f32((GLYPHS[character][u32(y)] >> (4u - col)) & 1u);
}

fn shade(uv: vec2f) -> vec4f {
  let pixel = 1.0 / 300.0;
  let p = (floor((uv - 0.5) * vec2f(aspect(), 1.0) / pixel) + 0.5) * pixel;
  let t = time();
  let drive = mix(p_drive(), bass(), 0.45);
  let beat = pow(1.0 - phase(), 3.0);
  let lineShade = mix(0.8, 1.0, step(0.26, fract(uv.y * 300.0)));

  // Copper bands are full scanlines with stepped highlights and dark edges.
  let bandY = p.y + 0.092 * sin(t * 2.4) + 0.03 * cos(t * 3.1 + p.y * 11.0);
  let lane = bandY * 7.0 + 3.0;
  let bandDist = abs(fract(lane) - 0.5);
  let bandMask = (1.0 - step(0.28 + 0.08 * drive, bandDist))
    * (1.0 - smoothstep(0.25, 0.36, abs(p.y + 0.12)));
  let stripe = floor(clamp(1.0 - bandDist * 2.7, 0.0, 0.99) * 6.0) / 5.0;
  let copperIndex = 1.0 + 3.0 * fract(floor(lane) * 0.42);
  var color = palette(0.0) + palette(1.0 / 6.0) * 0.085;
  color += palette(copperIndex / 6.0) * (0.12 + 0.68 * stripe) * bandMask;

  // Orthographic projection of a square cross-section. Pick the nearest face at each scanline.
  let twist = p.y * 13.0 + t * 3.0 + 0.43 * sin(p.y * 8.0 - t * 2.2);
  let center = 0.12 * sin(p.y * 7.3 + t * 2.0);
  let radius = (0.196 + 0.061 * drive + 0.012 * beat) * (1.0 - 0.43 * abs(p.y + 0.1));
  let faceX = (p.x - center) / radius;
  let a = vec4f(cos(twist), -sin(twist), -cos(twist), sin(twist));
  let z = vec4f(sin(twist), cos(twist), -sin(twist), -cos(twist));
  var depth = -2.0;
  var ribbon = vec3f(0.0);
  for (var i = 0u; i < 4u; i++) {
    let next = (i + 1u) % 4u;
    let span = a[next] - a[i];
    if (abs(span) > 0.0001) {
      let u = (faceX - a[i]) / span;
      let faceDepth = mix(z[i], z[next], u);
      if (u >= 0.0 && u <= 1.0 && faceDepth > depth) {
        depth = faceDepth;
        let edge = step(min(u, 1.0 - u), 0.055);
        let bevel = floor(clamp(1.0 - abs(u - 0.38) * 1.5, 0.0, 0.99) * 8.0) / 7.0;
        let base = palette(f32(i + 2u) / 6.0);
        ribbon = base * (0.35 + 0.72 * bevel) + palette(1.0) * (0.54 * edge + 0.12 * beat);
      }
    }
  }
  let ribbonMask = step(-1.05, depth) * step(-0.44, p.y) * (1.0 - step(0.205, p.y));
  color = mix(color, ribbon, ribbonMask);

  // The lettering has its own plane and a one-pixel drop shadow.
  if (p.y > 0.21) {
    let wave = (0.021 + 0.047 * drive) * sin(p.x * 10.5 - t * 5.4);
    let x = (p.x + 5.0) * 61.0 + t * 36.0;
    let y = (p.y - 0.35 - wave) * 61.0 + 3.5;
    let beam = 1.0 - smoothstep(0.01, 0.096, abs(p.y - 0.35));
    color = palette(0.0) + palette(1.0 / 6.0) * (0.08 + 0.4 * beam);
    let divider = 1.0 - step(0.003, abs(p.y - 0.218));
    color += palette(4.0 / 6.0) * divider * 0.72;
    color = mix(color, palette(2.0 / 6.0) * 0.55, glyph(x - 0.8, y - 0.85));
    let ink = mix(palette(4.0 / 6.0), palette(1.0), step(y, 2.6));
    color = mix(color, ink * (0.9 + 0.22 * onset()), glyph(x, y));
  }

  return vec4f(color * lineShade, 1.0);
}
