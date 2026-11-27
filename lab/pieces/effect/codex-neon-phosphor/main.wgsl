fn shade(uv: vec2f) -> vec4f {
  let image = max(tex_in(uv).rgb, vec3f(0.0));
  let p = (uv - vec2f(0.5, p_origin())) * vec2f(aspect(), 1.0);
  let kick = smoothstep(0.07, 0.68, bass());
  let energy = smoothstep(0.11, 0.62, rms());
  let beat = phase();
  let strike = max(onset(), kick * exp(-5.0 * beat));
  let drift = vec2f(sin(time() * 0.83) * 0.08, cos(time() * 0.57) * 0.06);
  let q = (p - drift) * vec2f(1.0, 1.52);
  let spread = exp(-dot(q, q) * (4.5 - 2.3 * kick));
  let ring = exp(-abs(length(q) - 0.16 - beat * 0.89) * 39.0);
  let neutral = p_cool() * (0.09 + 0.22 * spread);
  let light = mix(p_cool(), p_warm(), 0.46 + strike * 0.24);
  let glow = light * (spread * (0.43 * energy + 0.34 * kick) + ring * strike * 0.27);
  let headroom = 1.0 / (1.0 + max(image.r, max(image.g, image.b)));
  return vec4f(image + (neutral + glow * p_drive()) * headroom, 1.0);
}
