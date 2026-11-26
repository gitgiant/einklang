fn trans(uv: vec2f) -> vec3f {
  let p = T.p;
  if (p <= 0.0) { return sa(uv); }
  if (p >= 1.0) { return sb(uv); }

  // Each quarter beat has four roll slots. Give B progressively earlier slots.
  let slot = T.roll % 4u;
  let threshold = 3u - u32(clamp(floor(p * 3.0 + rnd(T.seed, 1u) - 0.5), 0.0, 2.0));
  var scene: vec3f;
  if (slot >= threshold) {
    scene = sb(uv);
  } else {
    scene = sa(uv);
  }

  let tint = mix(vec3f(0.75, 0.88, 1.0), vec3f(1.0, 0.84, 0.68), rnd(T.seed, 2u));
  // One sixteenth of a beat, with a restrained peak so the underlying scene stays visible.
  let flash = select(0.0, 0.20 + 0.10 * rnd(T.seed, 3u), slot == 0u);
  return mix(scene, tint, flash);
}
