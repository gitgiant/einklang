// core-cut: the plain hard switch (never drawn as a transition; its mix is the fallback).
fn trans(uv: vec2f) -> vec3f {
  let p = T.p;
  var c: vec3f;
  c = select(sa(uv), sb(uv), p >= 0.5);
  return c;
}
