fn crt_uv(uv: vec2f, k: f32) -> vec2f {
  let c = uv * 2.0 - 1.0;
  let r2 = dot(c, c);
  return (c * (1.0 + k * r2)) * 0.5 + 0.5;
}

fn shade(uv: vec2f) -> vec4f {
  let uvc = crt_uv(uv, p_curve());
  if (uvc.x < 0.0 || uvc.x > 1.0 || uvc.y < 0.0 || uvc.y > 1.0) {
    return vec4f(0.0, 0.0, 0.0, 1.0);
  }

  let dir = uvc - 0.5;
  let ca = p_aberration() * (0.35 + 0.85 * bass()) * 0.004;
  let cur_r = tex_in(uvc + dir * ca).r;
  let cur_g = tex_in(uvc).g;
  let cur_b = tex_in(uvc - dir * ca).b;
  let cur = vec3f(cur_r, cur_g, cur_b);

  // Soft glass halation (5-tap phosphor scatter)
  let px = vec2f(1.0 / resolution().x, 1.0 / resolution().y);
  let h_off = px * vec2f(4.5, 3.0);
  let scatter = (
    tex_in(uvc + vec2f(h_off.x, 0.0)).rgb +
    tex_in(uvc - vec2f(h_off.x, 0.0)).rgb +
    tex_in(uvc + vec2f(0.0, h_off.y)).rgb +
    tex_in(uvc - vec2f(0.0, h_off.y)).rgb
  ) * 0.25;
  let fresh = cur + scatter * (p_halation() * 0.35);

  // Dual-stage phosphor persistence (bounded strictly < 1 loop gain)
  let prev_uv = (uv - 0.5) * 0.9985 + 0.5;
  let old = min(prev(prev_uv).rgb, vec3f(4.0));
  let luma = dot(old, vec3f(0.2126, 0.7152, 0.0722));
  let tint_col = max(p_tint(), vec3f(0.08));
  let decay = p_persistence() * 0.95;
  // Bright beam core cools toward phosphor tint as it decays
  let afterglow = mix(old, tint_col * luma * 1.12, 0.14) * decay;

  var col = max(fresh, afterglow);

  // Subtle CRT scanlines + fine aperture grille (centered near 1.0 so brightness is preserved)
  let py = uv.y * resolution().y;
  let scan = 1.0 - p_grille() * 0.22 * (0.5 - 0.5 * cos(py * 3.14159265));
  let vig = clamp(1.0 - dot(dir, dir) * 0.55, 0.45, 1.0);
  col *= scan * vig;

  return vec4f(max(col, vec3f(0.0)), 1.0);
}
