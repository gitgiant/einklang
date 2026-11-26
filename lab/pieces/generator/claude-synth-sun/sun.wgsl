fn shade(uv: vec2f) -> vec4f {
  let hz = p_horizon();
  let a = aspect();
  let px = 1.0 / resolution().y;
  let r = p_size() * (1.0 + p_pulse() * bass());
  let c = vec2f(p_x(), hz - r * p_rise());
  let d = (uv - c) * vec2f(a, 1.0);
  let dist = length(vec2f(d.x, uv.y - c.y));

  // sky: zenith (stop 0) -> horizon (stop 0.35), a haze line at the horizon
  let above = step(uv.y, hz);
  let sy = clamp((hz - uv.y) / max(hz, 0.01), 0.0, 1.0);
  var col = mix(palette(0.38), palette(0.0), pow(max(sy, 1e-4), 0.55)) * p_sky();
  col += palette(0.62) * exp(-abs(uv.y - hz) * 22.0) * 0.5 * p_sky();
  col *= mix(0.35, 1.0, above);

  // sun body graded top (stop 1) -> bottom (stop 0.5)
  let v = clamp((uv.y - (c.y - r)) / (2.0 * r), 0.0, 1.0);
  let body = palette(mix(1.0, 0.48, v)) * p_bright() * (0.85 + 0.3 * rms());
  let disc = clamp((r - dist) / (1.5 * px) + 0.5, 0.0, 1.0);

  // slats: gaps widen toward the bottom and scroll down with the beat
  let s = (uv.y - c.y) / r;
  let k = p_slats();
  let q = s * k * 0.5 - p_beats() * p_scroll();
  let gapw = clamp((s + 0.35) * 0.5, 0.0, 0.7) * step(0.5, k);
  let fq = fract(q);
  let gw = 1.2 * px * k * 0.5 / r;
  let gap = clamp((gapw - fq) / gw + 0.5, 0.0, 1.0) * step(0.001, gapw);
  let sun = disc * (1.0 - gap) * above;

  // halo: exponential falloff outside the disc, shimmering with the highs
  let hi = (band(11) + band(13) + band(15)) / 3.0;
  let halo = exp(-max(dist - r, 0.0) / (r * 0.35)) * p_glow() * (0.5 + 0.4 * hi + 0.4 * rms());
  col = col * (1.0 - sun) + body * sun + palette(0.7) * halo * 0.35 * above;
  return vec4f(max(col, vec3f(0.0)), 1.0);
}
