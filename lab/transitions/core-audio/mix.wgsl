// core-audio: the new scene shows where the spectrum (mirrored) and bass are.
fn trans(uv: vec2f) -> vec3f {
  let p = T.p;
  let bump = 4.0 * p * (1.0 - p); // 0 at both ends, 1 at the midpoint
  var c: vec3f;
  let e = mix(band(uv.x), band(0.03), 0.4);
  let h = abs(uv.y - 0.5) * 2.0;
  let score = p + bump * 0.7 * (e * (1.0 - 0.7 * h) - 0.35);
  c = mix(sa(uv), sb(uv), smoothstep(0.45, 0.55, score));
  return c;
}
