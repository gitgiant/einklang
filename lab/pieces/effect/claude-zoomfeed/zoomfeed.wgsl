fn shade(uv: vec2f) -> vec4f {
  let asp = vec2f(aspect(), 1.0);
  let kick = pow(1.0 - phase(), 3.0);
  let z = p_zoom() + p_bass() * bass() * bass() + p_pulse() * kick;
  let a = p_rotate() + p_swing() * sin((bar() + phase()) * 1.5707963);
  let c = (uv - 0.5) * asp;
  let r = vec2f(c.x * cos(a) - c.y * sin(a), c.x * sin(a) + c.y * cos(a)) * (1.0 - z);
  let from_uv = r / asp + 0.5;
  let inside = f32(all(from_uv >= vec2f(0.0)) && all(from_uv <= vec2f(1.0)));
  var old = prev(from_uv).rgb * inside;
  // rotate the echo's colour around the grey axis
  let k = vec3f(0.57735027);
  let h = p_hue();
  old = max(vec3f(0.0), old * cos(h) + cross(k, old) * sin(h) + k * dot(k, old) * (1.0 - cos(h)));
  // a small subtraction lets faint residue reach black
  old = max(vec3f(0.0), old * p_decay() - 0.002);
  let top = tex_in(uv).rgb;
  let cover = clamp(max(top.r, max(top.g, top.b)), 0.0, 1.0);
  return vec4f(top + old * (1.0 - cover), 1.0);
}
