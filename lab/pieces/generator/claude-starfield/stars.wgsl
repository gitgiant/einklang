fn sf_hash(i: vec2i, s: u32) -> vec3f {
  var h = (bitcast<u32>(i.x) * 0x8da6b343u) ^ (bitcast<u32>(i.y) * 0xd8163841u) ^ (s * 0xcb1ab31fu);
  h = (h ^ (h >> 13u)) * 0x5bd1e995u;
  let a = h ^ (h >> 15u);
  let b = (a ^ (a >> 11u)) * 0x27d4eb2du;
  let c = (b ^ (b >> 15u)) * 0x165667b1u;
  return vec3f(f32(a >> 8u), f32(b >> 8u), f32(c >> 8u)) / 16777216.0;
}

fn shade(uv: vec2f) -> vec4f {
  let a = aspect();
  let px = 1.0 / resolution().y;
  let hi = (band(10) + band(12) + band(14)) / 3.0;
  let st = p_streak() * bass();
  var col = vec3f(0.0);
  for (var l = 0; l < 3; l++) {
    let fl = f32(l);
    let s = 30.0 * (1.0 + fl * 0.6);
    let par = 1.0 / (1.0 + fl * 1.2);
    let p = (uv * vec2f(a, 1.0) + vec2f(time() * p_drift() * par, 0.0)) * s;
    let ci = vec2i(floor(p));
    let f = fract(p);
    let h = sf_hash(ci, u32(l) + 1u);
    if (h.x > p_density() * par * par) { continue; }
    let o = 0.15 + 0.7 * h.yz;
    var d = (f - o) / s / px;
    // bass stretches the stars sideways into warp streaks
    d.x = d.x / (1.0 + st * (2.0 + 6.0 * par));
    let r = max(p_size() * (0.6 + 0.8 * h.y) * resolution().y / 1080.0, 0.9);
    let core = exp(-dot(d, d) / (r * r));
    let tw = 1.0 + p_twinkle() * (sin(time() * (3.0 + 9.0 * h.z) + h.y * 40.0) * 0.5 * hi + hi * 0.6);
    let flash = select(1.0, 1.0 + 2.0 * onset(), h.z > 0.85);
    let c = mix(palette(h.y), vec3f(1.0), 0.45 + 0.3 * h.z);
    col += c * core * tw * flash * par * (0.5 + h.z);
  }
  let fade = 1.0 - smoothstep(p_horizon() - 0.25, p_horizon(), uv.y);
  col *= p_bright() * fade;
  let m = clamp(max(col.r, max(col.g, col.b)), 0.0, 1.0);
  return vec4f(max(col, vec3f(0.0)), m);
}
