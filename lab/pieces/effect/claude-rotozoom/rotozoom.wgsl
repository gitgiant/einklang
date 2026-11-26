// Classic rotozoomer: one affine map from screen to an endless mirrored tiling of the input.

// 0..1 triangle wave: mirrored tiling, so tile edges never show a seam
fn mirror(x: vec2f) -> vec2f { return 1.0 - abs(fract(x * 0.5) * 2.0 - 1.0); }

fn shade(uv: vec2f) -> vec4f {
  let beats = time() * select(120.0, bpm(), bpm() > 0.0) / 60.0;
  // a whole bar adds step * pi/2: the checker and the mirror tiling look the same there, so the wrap is seamless
  let snap = (bar() + smoothstep(0.0, 0.6, phase())) * p_step() * 0.39269908;
  let a = snap + p_swing() * sin((bar() + phase()) * 1.5707963) + time() * p_spin();
  let b = bass();
  let z = p_zoom() * (1.0 + p_bass() * b * b) * (1.0 + p_breathe() * sin(beats * 0.39269908));
  let c = (uv - 0.5) * vec2f(aspect(), 1.0);
  let r = vec2f(c.x * cos(a) - c.y * sin(a), c.x * sin(a) + c.y * cos(a)) * p_tiles() / z;
  let t = time() * p_pan();
  let q = r + vec2f(t * 0.37 + sin(t * 0.43), t * 0.23 + cos(t * 0.31)); // in tile heights
  let top = tex_in(mirror(q / vec2f(aspect(), 1.0) + 0.5)).rgb;

  // anti-aliased checker: product of two smoothed square waves, the edge about one pixel wide
  let s = q * p_squares();
  let px = max(p_squares() * p_tiles() / (z * resolution().y), 0.0001);
  let w = clamp((0.5 - abs(fract(s * 0.5) * 2.0 - 1.0)) / px, vec2f(-0.5), vec2f(0.5)) * 2.0;
  let k = 0.5 + 0.5 * w.x * w.y;
  let hue = 0.5 + 0.5 * sin(length(floor(s)) * 0.35 - beats * 0.8);
  let sq = mix(palette(hue * 0.35) * 0.35, palette(0.4 + hue * 0.45), k);
  let cover = clamp(max(top.r, max(top.g, top.b)) * 1.5, 0.0, 1.0);
  return vec4f(top + sq * p_checker() * (0.75 + 0.5 * rms()) * (1.0 - cover), 1.0);
}
