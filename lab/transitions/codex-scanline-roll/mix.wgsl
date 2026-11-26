fn trans(uv: vec2f) -> vec3f {
  let p = T.p;
  if (p <= 0.0) { return sa(uv); }
  if (p >= 1.0) { return sb(uv); }

  let direction = select(-1.0, 1.0, (T.seed & 1u) != 0u);
  let row = select(1.0 - uv.y, uv.y, direction > 0.0);
  let distance = p - row;
  let envelope = 4.0 * p * (1.0 - p);
  let width = mix(0.026, 0.061, rnd(T.seed, 1u));
  let tracking = 1.0 - smoothstep(0.0, width, abs(distance));
  let jitter = (rnd(T.seed, T.roll + 2u) - 0.5) * 0.036 * tracking * envelope;
  let uvX = uv.x + jitter;
  let px = 1.0 / T.res.y;
  let mask = smoothstep(-px, px, distance);

  // The two images form a vertical loop at the moving seam.
  let a = sa(vec2f(uvX, uv.y - direction * p));
  let b = sb(vec2f(uvX, uv.y + direction * (1.0 - p)));
  let raster = 0.5 + 0.5 * cos(uv.y * T.res.y * 2.0943951);
  let trim = mix(vec3f(0.32, 0.75, 0.58), vec3f(0.46, 0.59, 0.92), rnd(T.seed, 2u));
  return mix(a, b, mask) * (1.0 - 0.22 * raster * tracking * envelope)
       + trim * (0.47 * tracking * tracking * envelope);
}
