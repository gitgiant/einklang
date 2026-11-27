// beat index: time * bpm / 60 lands on an integer as the phase wraps
fn beat_id() -> u32 { return u32(max(round(time() * bpm() / 60.0 - phase()), 0.0)); }

fn jump(b: u32, strip: f32, axis: u32) -> vec2f {
  let r = h32(b * 2u + axis, u32(strip) + 7u);
  return vec2f(f32(r & 0xffffu) / 65535.0 - 0.5, f32(r >> 24u) / 255.0);
}

fn shade(uv: vec2f) -> vec4f {
  let n = max(p_count(), 2.0);
  let env = pow(1.0 - phase(), mix(1.0, 6.0, p_settle())) * (0.45 + 0.8 * bass() + 0.6 * onset());
  let b = beat_id();
  var p = uv;
  var split = 0.0;
  let mode = i32(p_dir());
  if (mode != 1) {
    let j = jump(b, floor(uv.y * n), 0u);
    p.x += j.x * 2.0 * p_shift() * env;
    split = max(split, select(0.0, 1.0, j.y < p_glitch()));
  }
  if (mode != 0) {
    let j = jump(b, floor(uv.x * n), 1u);
    p.y += j.x * 2.0 * p_shift() * env;
    split = max(split, select(0.0, 1.0, j.y < p_glitch()));
  }
  p = fract(p);
  let o = vec2f(0.012 * split * env, 0.0);
  return vec4f(tex_in(fract(p - o)).r, tex_in(p).g, tex_in(fract(p + o)).b, 1.0);
}
