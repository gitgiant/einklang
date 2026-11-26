// core-flash: additive blend plus a white flash.
fn trans(uv: vec2f) -> vec3f {
  let p = T.p;
  var c: vec3f;
  c = sa(uv) * min(1.0, 2.0 * (1.0 - p)) + sb(uv) * min(1.0, 2.0 * p) + vec3f(T.flash * 3.0);
  return c;
}
