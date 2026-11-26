// core-glitch: seeded horizontal bands swap scenes, with an RGB split.
fn trans(uv: vec2f) -> vec3f {
  let p = T.p;
  let bump = 4.0 * p * (1.0 - p); // 0 at both ends, 1 at the midpoint
  var c: vec3f;
  let nb = 6u + h32(T.seed, 3u) % 18u;
  let b = u32(floor(clamp(uv.y, 0.0, 0.9999) * f32(nb)));
  let k = T.seed ^ (T.roll * 2654435761u);
  let off = (rnd(b + 97u, k) - 0.5) * 0.12 * bump;
  let sp = vec2f(0.012 * bump + off, 0.0);
  let o = vec2f(off, 0.0);
  let a = vec3f(sa(uv + sp).r, sa(uv + o).g, sa(uv - sp).b);
  let n = vec3f(sb(uv + sp).r, sb(uv + o).g, sb(uv - sp).b);
  c = select(a, n, rnd(b, k) < p);
  return c;
}
