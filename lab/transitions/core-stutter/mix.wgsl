// core-stutter: hard cuts (p is 0 or 1).
fn trans(uv: vec2f) -> vec3f {
  let p = T.p;
  var c: vec3f;
  c = select(sa(uv), sb(uv), p > 0.5);
  return c;
}
