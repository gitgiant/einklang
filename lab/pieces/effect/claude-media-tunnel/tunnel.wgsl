// A tube around the z axis (radius 1), its wall pushed in by the luma; the camera flies along z.
const MT_PI = 3.14159265;
fn mt_mirror(x: f32) -> f32 { let f = fract(x * 0.5) * 2.0; return 1.0 - abs(1.0 - f); }
// wall radius at angle a (polygon apothem 1)
fn mt_shape(a: f32) -> f32 {
  let n = f32(p_sides());
  if (n < 2.5) { return 1.0; }
  let w = 2.0 * MT_PI / n;
  let m = a - w * floor(a / w) - 0.5 * w;
  return 1.0 / cos(m);
}
fn mt_tile() -> f32 { return 2.0 * MT_PI / (2.0 * f32(p_repeat())) / aspect(); }
// image uv at wall angle a (twisted) and depth z
fn mt_uv(a: f32, z: f32) -> vec2f {
  let u = (a / (2.0 * MT_PI) + 0.5) * 2.0 * f32(p_repeat());
  return vec2f(mt_mirror(u), mt_mirror(z / mt_tile()));
}
fn mt_relief() -> f32 { return p_relief() * (1.0 + p_bass() * bass() * 1.8); }

fn shade(uv: vec2f) -> vec4f {
  let beat = fract(phase());
  let lurch = (1.0 - pow(1.0 - beat, 3.0)) - beat;
  let bl = 60.0 / max(bpm(), 40.0);
  let zc = time() * p_speed() + p_surge() * lurch * bl * max(p_speed(), 0.6) * 1.5;
  let bt = (bar() + beat) / 4.0;   // 0..1 over the bar
  let rollA = p_roll() * 0.6 * sin(2.0 * MT_PI * bt) + time() * 0.05;
  var q = (uv - 0.5) * vec2f(aspect(), -1.0);
  // the camera sways off-axis a little
  let off = vec2f(sin(time() * 0.37), cos(time() * 0.29)) * 0.18;
  let cr = cos(rollA); let sr = sin(rollA);
  q = vec2f(cr * q.x - sr * q.y, sr * q.x + cr * q.y);
  let rd = normalize(vec3f(q, 0.9));
  let rr = max(length(rd.xy), 1e-4);
  let ang0 = atan2(rd.y, rd.x);
  let amp = mt_relief();

  // fixed-point solve for the wall distance s along the ray (the wall moves in by the relief)
  // approximation: the ray leaves from the axis; the sway only shifts the picture slightly
  var s = mt_shape(ang0) / rr;
  var a = ang0; var z = zc;
  var h = 0.0;
  for (var i = 0; i < 5; i++) {
    z = zc + s * rd.z;
    a = ang0 + z * p_twist() * 2.0 * MT_PI + off.x * 0.3;
    h = tex_height(mt_uv(a, z)).x;
    let r = mt_shape(ang0) * (1.0 - amp * h * 0.85);
    s = mix(s, r / rr, 0.75);
  }
  s = min(s, 80.0);
  z = zc + s * rd.z;

  // normal from the relief gradient (in wall coordinates)
  let ea = 0.02; let ez = 0.04;
  let ha = tex_height(mt_uv(a + ea, z)).x - tex_height(mt_uv(a - ea, z)).x;
  let hz = tex_height(mt_uv(a, z + ez)).x - tex_height(mt_uv(a, z - ez)).x;
  let radial = -vec3f(cos(ang0), sin(ang0), 0.0);              // into the tunnel
  let tang = vec3f(-sin(ang0), cos(ang0), 0.0);
  let n = normalize(radial + (tang * ha / (2.0 * ea) + vec3f(0.0, 0.0, 1.0) * hz / (2.0 * ez)) * amp * 0.5);
  let L = normalize(-rd + vec3f(off, 0.0));
  let dif = max(dot(n, L), 0.0);

  let img = tex_in(mt_uv(a, z)).rgb;
  let mode = i32(p_colour());
  var alb = img * 1.4 + 0.02;
  if (mode == 1) { alb = palette(fract(h * 0.8 + z * 0.02)); }
  else if (mode == 2) { alb = mix(img * 1.4, palette(h), 0.4); }
  let dist = s * rr + s * abs(rd.z);
  var col = alb * (0.2 + 1.0 * dif) * (1.0 + 0.6 * h * amp);

  // rings: fixed in the world every 2 radii, lit on the beat, the next ones brighter
  let rz = z / 2.0;
  let rd1 = abs(fract(rz) - 0.5) * 2.0;
  let ring = smoothstep(0.92, 1.0, rd1);
  let fire = exp(-beat * 3.0) * (0.4 + 1.2 * bass()) + 0.12;
  col += palette(fract(floor(rz) * 0.13)) * ring * p_rings() * fire * 2.0;
  // a pulse runs away from the camera over the beat
  let wave = exp(-pow((s * abs(rd.z) - beat * 14.0) * 0.6, 2.0));
  col += palette(0.8) * wave * p_rings() * 0.5 * (0.3 + bass()) * (0.5 + h);
  // onsets flash the bright relief
  col += palette(0.95) * pow(h, 3.0) * onset() * 0.8;

  // fog into a glowing far end
  let core = palette(0.5) * (0.5 + 1.5 * bass() + 0.6 * onset());
  let fog = 1.0 - exp(-dist * p_fog());
  col = mix(col, core * 0.4, clamp(fog, 0.0, 1.0));
  col += core * 0.25 * exp(-rr * 12.0);
  return vec4f(max(col, vec3f(0.0)), 1.0);
}
