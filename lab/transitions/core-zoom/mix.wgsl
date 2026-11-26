// core-zoom: the old scene zooms in and fades, the new one grows from small.
fn trans(uv: vec2f) -> vec3f {
  let p = T.p;
  var c: vec3f;
  let qa = T.center + (uv - T.center) / (1.0 + p * 3.0);
  let qb = T.center + (uv - T.center) / max(p, 0.001);
  c = sa(qa) * (1.0 - p) + sb(qb) * inside(qb) * p;
  return c;
}
