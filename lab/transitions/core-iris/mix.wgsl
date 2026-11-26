// core-iris: a circle opening from the centre.
fn trans(uv: vec2f) -> vec3f {
  let p = T.p;
  let asp = vec2f(T.aspect, 1.0);
  var c: vec3f;
  let d = length((uv - T.center) * asp);
  let far = length(max(T.center, 1.0 - T.center) * asp);
  let soft = 0.05;
  let r = p * (far + soft);
  c = mix(sa(uv), sb(uv), 1.0 - smoothstep(r - soft, r, d));
  return c;
}
