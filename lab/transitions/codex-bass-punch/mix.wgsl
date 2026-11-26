fn trans(uv: vec2f) -> vec3f {
  let p = T.p;
  if (p <= 0.0) { return sa(uv); }
  if (p >= 1.0) { return sb(uv); }

  let offset = vec2f(rnd(T.seed, 1u) - 0.5, rnd(T.seed, 2u) - 0.5) * 0.16;
  let pivot = clamp(T.center + offset, vec2f(0.15), vec2f(0.85));
  let ray = uv - pivot;
  let bass = sqrt(clamp(0.7 * bandv(0u) + 0.3 * bandv(1u), 0.0, 1.0));
  let force = 0.44 + bass * 0.62;
  let landing = smoothstep(0.27, 0.60, p);

  // An onset jumps p, advancing both the outbound smear and the incoming impact.
  let burst = p * force;
  let outgoing = 0.52 * sa(pivot + ray / (1.0 + burst * 3.6))
               + 0.30 * sa(pivot + ray / (1.0 + burst * 2.8))
               + 0.18 * sa(pivot + ray / (1.0 + burst * 1.8));
  let settle = 1.0 - smoothstep(0.40, 0.92, p);
  let incoming = sb(pivot + ray / (1.0 + 0.57 * force * settle));
  return mix(outgoing, incoming, landing);
}
