// core-dissolve: per-cell noise threshold, seeded grain.
fn trans(uv: vec2f) -> vec3f {
  let p = T.p;
  var c: vec3f;
  let grain = 2.0 + f32(h32(T.seed, 2u) % 5u);
  let cell = vec2u(floor(uv * T.res / grain));
  c = select(sa(uv), sb(uv), rnd(cell.x * 7919u + cell.y, T.seed) < p);
  return c;
}
