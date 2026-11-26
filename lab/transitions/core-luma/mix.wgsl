// core-luma: the new scene comes through the old one's brightest areas first.
fn trans(uv: vec2f) -> vec3f {
  let p = T.p;
  var c: vec3f;
  let a = sa(uv);
  let l = 1.0 - exp(-dot(a, vec3f(0.2126, 0.7152, 0.0722)) * 2.0);
  let e = 1.0 - p * 1.2;
  c = mix(a, sb(uv), smoothstep(e, e + 0.2, l));
  return c;
}
