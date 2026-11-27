fn hash2(c: vec2i) -> vec2f {
  let h = h32(bitcast<u32>(c.x) * 0x27d4eb2du, bitcast<u32>(c.y) + 0x165667b1u);
  return vec2f(f32(h & 0xffffu), f32(h >> 16u)) / 65535.0;
}

fn shade(uv: vec2f) -> vec4f {
  let res = resolution();
  let cell = p_cell() * res.y / 1080.0;
  let center = res * 0.5;
  // burst: the whole dot field scales out from the centre
  let kick = pow(1.0 - phase(), 4.0) * (0.3 + bass()) + onset();
  let k = 1.0 + p_burst() * 0.12 * kick;
  let px = center + (uv * res - center) / k;
  let base = vec2i(floor(px / cell));
  var col = tex_in(uv).rgb * p_under();
  let t = time();
  for (var y = -1; y <= 1; y++) {
    for (var x = -1; x <= 1; x++) {
      let c = base + vec2i(x, y);
      let h = hash2(c);
      let home = (vec2f(c) + 0.5 + (h - 0.5) * p_jitter()) * cell;
      let w = vec2f(sin(t * (0.6 + h.x) + h.y * 6.28), cos(t * (0.5 + h.y) + h.x * 6.28)) * p_wander() * cell * 0.5;
      let src = clamp((center + (home - center) * k) / res, vec2f(0.0), vec2f(1.0));
      let c3 = tex_in(src).rgb;
      let l = sqrt(clamp(dot(c3, vec3f(0.2126, 0.7152, 0.0722)), 0.0, 1.0));
      let r = cell * 0.5 * p_size() * (0.25 + 0.75 * l) * (1.0 + 0.35 * bass());
      let d = length(px - home - w);
      let a = smoothstep(r, r - 1.5, d);
      col = mix(col, c3 * p_glow() * (1.0 + 0.4 * kick), a);
    }
  }
  return vec4f(col, 1.0);
}
