// core-melt: the old scene drips down in seeded columns (the post trails smear it).
fn trans(uv: vec2f) -> vec3f {
  let p = T.p;
  var c: vec3f;
  let drip = (0.5 + 0.5 * rnd(u32(uv.x * 160.0), T.seed)) * p * p * 0.6;
  let qa = uv - vec2f(0.0, drip);
  c = mix(sa(qa) * inside(qa), sb(uv), p);
  return c;
}
