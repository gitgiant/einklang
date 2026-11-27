fn shade(uv: vec2f) -> vec4f {
  let p = (uv - 0.5) * vec2f(aspect(), 1.0);
  let t = time();
  let beat = pow(1.0 - phase(), 3.5);
  let energy = clamp(bass() * 1.48 + rms() * 0.68 + onset() * 0.12, 0.0, 1.0);

  // A bass wave bends the source and offsets the height levels, so a still image has travelling folds.
  let wave = sin(p.x * 7.7 - t * 1.44 + p.y * 3.1);
  let cross_wave = cos(p.y * 9.5 + t * 1.17 + p.x * 2.3);
  let warp = vec2f(cross_wave, wave) * (0.015 + 0.094 * energy + beat * bass() * 0.024);
  let q = uv + warp;
  let height = tex_height(q).r;
  let gradient = tex_gradient(q).xy;
  let photo = tex_picture(q).rgb;
  let edge = length(gradient);
  let field = height * 13.0 + p.y * 4.8 + wave * (0.16 + energy * 0.93) + cross_wave * 0.22;
  let level = abs(fract(field + 0.5) - 0.5);
  let width = clamp(fwidth(field) * 0.7, 0.016, 0.25);
  let thread = (1.0 - smoothstep(0.043, 0.043 + width, level)) * (1.0 - smoothstep(0.11, 0.34, width));
  let halo = exp(-level * 10.0);
  let etched = smoothstep(0.014, 0.125, edge);
  let sweep = pow(0.5 + 0.5 * cos(field * 0.57 - t * 2.3), 4.0);

  let cold = vec3f(0.028, 0.47, 0.67);
  let purple = vec3f(0.52, 0.11, 0.84);
  let hot = vec3f(1.00, 0.28, 0.058);
  let color_phase = 0.5 + 0.5 * sin(height * 6.0 + p.x * 1.8 + t * 0.28);
  let tint = mix(mix(purple, cold, color_phase), hot, smoothstep(0.10, 0.9, energy) * (0.59 + 0.39 * sweep));
  let illumination = 0.49 + energy * 1.8;
  let vignette = 1.0 - 0.43 * smoothstep(0.25, 1.03, length(p));
  let layers = 0.05 + 0.028 * cos(floor(field) * 1.12);
  let base = vec3f(0.009, 0.012, 0.028) + tint * (layers + 0.19 * height) * illumination
    + photo * (0.023 + height * 0.12);
  let traces = tint * (thread * (0.52 + sweep * 0.27) + halo * 0.19) * illumination;
  let engraving = mix(tint, vec3f(0.62, 0.86, 1.0), 0.52) * etched * (0.07 + thread * 0.48);
  return vec4f((base + traces + engraving) * vignette, 1.0);
}
