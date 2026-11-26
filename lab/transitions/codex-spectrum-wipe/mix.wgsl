fn trans(uv: vec2f) -> vec3f {
  let p = T.p;
  if (p <= 0.0) { return sa(uv); }
  if (p >= 1.0) { return sb(uv); }

  let column = min(uv.x * 16.0, 15.9999);
  let index = u32(column);
  let bandIndex = select(index, 15u - index, (T.seed & 1u) != 0u);
  let level = sqrt(clamp(bandv(bandIndex), 0.0, 1.0));
  let accent = mix(vec3f(0.16, 0.70, 0.95), vec3f(0.94, 0.45, 0.18), rnd(T.seed, 1u));
  let lift = 4.0 * p * (1.0 - p);

  // Recess the outer few pixels of each tip so adjacent bars still read at equal levels.
  let inset = 1.0 - smoothstep(0.02, 0.09, min(fract(column), 1.0 - fract(column)));
  let height = p + lift * (0.40 * level - 0.08 - 0.024 * inset);
  let edge = height - (1.0 - uv.y);
  let px = 1.0 / T.res.y;
  let mask = smoothstep(-px, px, edge);
  let tip = mask * (1.0 - smoothstep(px, 0.012, edge));
  return mix(sa(uv), sb(uv), mask) + accent * (0.32 * lift * tip);
}
