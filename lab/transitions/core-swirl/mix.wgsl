// core-swirl: twist peaking at the midpoint.
fn trans(uv: vec2f) -> vec3f {
  let p = T.p;
  let bump = 4.0 * p * (1.0 - p); // 0 at both ends, 1 at the midpoint
  let asp = vec2f(T.aspect, 1.0);
  var c: vec3f;
  let d = (uv - T.center) * asp;
  let w = max(0.0, 1.0 - length(d) / 0.9);
  let q = rot(d, bump * 6.0 * w * w) / asp + T.center;
  c = mix(sa(q), sb(q), p);
  return c;
}
