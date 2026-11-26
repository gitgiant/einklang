// One fire step: heat rises one row, averaged from the cells below, minus cooling. The bottom 3 rows are fuel.

struct Step {
  size: vec2u, step_: u32, balls: u32,
  fuel: f32, flare: f32, cool: f32, wind: f32,
  ball: array<vec4f, 4>, // x, y (cells), radius, heat
};
@group(0) @binding(0) var<uniform> s: Step;
@group(0) @binding(1) var<storage, read> src: array<f32>;
@group(0) @binding(2) var<storage, read_write> dst: array<f32>;

fn rnd(x: u32, y: u32, z: u32) -> f32 {
  var h = (x * 0x8da6b343u) ^ (y * 0xd8163841u) ^ (z * 0xcb1ab31fu);
  h = (h ^ (h >> 15u)) * 0x2c1b3c6du;
  h = (h ^ (h >> 12u)) * 0x297a2d39u;
  return f32((h ^ (h >> 15u)) >> 8u) / 16777216.0;
}

fn vnoise(p: vec2f) -> f32 {
  let i = vec2u(vec2i(floor(p)));
  let f = fract(p);
  let u = f * f * (3.0 - 2.0 * f);
  return mix(mix(rnd(i.x, i.y, 7u), rnd(i.x + 1u, i.y, 7u), u.x),
             mix(rnd(i.x, i.y + 1u, 7u), rnd(i.x + 1u, i.y + 1u, 7u), u.x), u.y);
}

fn at(x: i32, y: i32) -> f32 {
  let w = i32(s.size.x);
  return src[u32(min(y, i32(s.size.y) - 1) * w + clamp(x, 0, w - 1))];
}

@compute @workgroup_size(8, 8)
fn cs_step(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= s.size.x || id.y >= s.size.y) { return; }
  let x = i32(id.x);
  let y = i32(id.y);
  var v: f32;
  if (id.y + 3u >= s.size.y) {
    // fuel: drifting hot clumps with per-cell flicker
    let t = f32(s.step_);
    let n = vnoise(vec2f(f32(x) / 11.0, t * 0.045)) * 0.7 + vnoise(vec2f(f32(x) / 4.0 + 50.0, t * 0.11)) * 0.3;
    let thr = 0.6 - 0.22 * clamp(s.fuel - 0.6, 0.0, 1.0) - 0.15 * s.flare;
    let hot = smoothstep(thr - 0.08, thr + 0.12, n);
    v = (0.08 + hot * (0.75 + 0.7 * rnd(id.x, id.y, s.step_))) * s.fuel + s.flare * hot * 0.2;
  } else {
    // wind and flicker: shift the sample sideways by whole cells at random
    let r = rnd(id.x, id.y, s.step_ + 977u);
    let dx = i32(floor(s.wind + r * 1.6 - 0.3));
    let sx = x - dx;
    let avg = (at(sx - 1, y + 1) + at(sx, y + 1) + at(sx + 1, y + 1) + at(sx, y + 2)) * 0.25;
    // cooling map scrolls up with the flames, which tears them into tongues
    let q = vec2f(f32(x), f32(y) + f32(s.step_) * 1.1);
    let n = vnoise(q / 13.0) * 0.65 + vnoise(q / 5.0 + 31.0) * 0.35;
    v = avg - s.cool * (0.15 + 5.0 * n * n * n);
    for (var i = 0u; i < s.balls; i++) {
      let b = s.ball[i];
      let d = length(vec2f(f32(x), f32(y)) - b.xy) / b.z;
      if (d < 1.0) { v = max(v, b.w * (1.0 - d * d) * (0.6 + 0.8 * rnd(id.x, id.y, s.step_ + 3u))); }
    }
  }
  dst[id.y * s.size.x + id.x] = clamp(v, 0.0, 1.7);
}
