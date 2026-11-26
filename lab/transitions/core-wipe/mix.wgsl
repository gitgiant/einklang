// core-wipe: soft line sweeping in a seeded direction.
fn trans(uv: vec2f) -> vec3f {
  let p = T.p;
  let asp = vec2f(T.aspect, 1.0);
  var c: vec3f;
  let dir = rot(vec2f(1.0, 0.0), rnd(T.seed, 1u) * 6.2831853);
  let r = 0.5 * (abs(dir.x) * T.aspect + abs(dir.y));
  let s = (dot((uv - 0.5) * asp, dir) + r) / (2.0 * r);
  let soft = 0.08;
  let e = p * (1.0 + soft);
  c = mix(sa(uv), sb(uv), 1.0 - smoothstep(e - soft, e, s));
  return c;
}
