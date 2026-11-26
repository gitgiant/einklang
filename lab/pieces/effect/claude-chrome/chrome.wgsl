fn shade(uv: vec2f) -> vec4f {
  let a0 = tex_in(uv).a;
  // outline: max alpha in a ring of 8 taps
  let r = p_outline() * (1.0 + 0.8 * bass());
  var ring = 0.0;
  for (var i = 0; i < 8; i++) {
    let an = f32(i) * 0.785398;
    let o = vec2f(cos(an) / aspect(), sin(an)) * r;
    ring = max(ring, tex_in(clamp(uv + o, vec2f(0.0), vec2f(1.0))).a);
  }
  let edge = clamp(ring - a0, 0.0, 1.0);

  // chrome ramp across the lettering band: sky -> white | dark horizon -> orange -> pale
  let v = clamp((uv.y - (p_y() - p_height() * 0.5)) / p_height(), 0.0, 1.0);
  let top = mix(vec3f(0.03, 0.06, 0.32), vec3f(0.85, 0.92, 1.0), pow(clamp(v / 0.5, 1e-4, 1.0), 1.6));
  let bot = mix(vec3f(0.12, 0.03, 0.06), vec3f(1.0, 0.45, 0.12), pow(clamp((v - 0.5) / 0.5, 1e-4, 1.0), 0.7));
  var c = select(bot, top, v < 0.5);
  c = mix(c, vec3f(1.0, 0.9, 0.75), smoothstep(0.85, 1.0, v) * 0.6);
  // a diagonal highlight sweeping across on the beat
  let sx = fract(p_beats() * p_sweep());
  let diag = uv.x * aspect() * 0.5 + uv.y * 0.35;
  let hl = exp(-abs(diag - (sx * 1.6 - 0.3)) * 30.0);
  c = c * p_bright() + vec3f(1.0) * hl * 1.5;

  let neon = palette(p_tint()) * p_neon() * (0.8 + 0.8 * bass() + 0.5 * onset());
  let rgb = c * a0 + neon * edge;
  let al = clamp(a0 + edge, 0.0, 1.0);
  return vec4f(max(rgb, vec3f(0.0)), al);
}
