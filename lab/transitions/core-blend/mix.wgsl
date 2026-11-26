// core-blend: linear crossfade in HDR.
fn trans(uv: vec2f) -> vec3f {
  let p = T.p;
  var c: vec3f;
  c = mix(sa(uv), sb(uv), p);
  return c;
}
