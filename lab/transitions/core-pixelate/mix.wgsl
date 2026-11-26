// core-pixelate: both go blocky, swap at the coarsest point, then sharpen.
fn trans(uv: vec2f) -> vec3f {
  let p = T.p;
  let bump = 4.0 * p * (1.0 - p); // 0 at both ends, 1 at the midpoint
  var c: vec3f;
  let blocks = mix(T.res.y, 9.0, pow(bump, 0.6));
  let cells = vec2f(blocks * T.aspect, blocks);
  let q = (floor(uv * cells) + 0.5) / cells;
  c = select(sa(q), sb(q), p >= 0.5);
  return c;
}
