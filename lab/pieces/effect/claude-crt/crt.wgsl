struct Crt {
  res: vec2f, tick: f32, _p0: f32,
  scan: f32, curve: f32, vignette: f32, chroma: f32,
  tracking: f32, jitter: f32,
  burst: f32,   // envelope of the latest onset's noise burst, 0..1
  at: f32,      // its height on screen, uv
};
@group(0) @binding(0) var<uniform> C: Crt;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var src: texture_2d<f32>;

/** Tape lines and picture lines (independent of the target size). */
const LINES = 270.0;

fn noise(a: u32, b: u32) -> f32 { return f32(h32(a, b) >> 8u) / 16777216.0; }
fn tap(uv: vec2f) -> vec3f { return textureSampleLevel(src, samp, uv, 0.0).rgb; }
fn luma(c: vec3f) -> f32 { return dot(c, vec3f(0.299, 0.587, 0.114)); }

@fragment fn fs_crt(v: VOut) -> @location(0) vec4f {
  // curved glass: push the corners outward, black beyond the tube
  var p = v.uv * 2.0 - 1.0;
  p *= 1.0 + C.curve * vec2f(0.10 * p.y * p.y, 0.16 * p.x * p.x);
  let uv = p * 0.5 + 0.5;
  let edge = smoothstep(vec2f(0.0), vec2f(0.006), uv) * smoothstep(vec2f(0.0), vec2f(0.006), 1.0 - uv);
  let inside = edge.x * edge.y;

  let tick = u32(C.tick);
  let line = u32(clamp(uv.y, 0.0, 1.0) * LINES);
  let ln = noise(line, tick);

  // tape wobble, tracking burst (a band of torn lines) and head switching at the bottom
  var dx = (sin(uv.y * 37.0 + C.tick * 0.21) + ln - 0.5) * 0.0006 * C.chroma;
  let d = (uv.y - C.at) / (0.025 + 0.09 * C.burst);
  let track = exp(-d * d) * C.burst * C.tracking;
  dx += track * (ln - 0.35) * 0.11;
  let head = smoothstep(0.935, 1.0, uv.y);
  dx += head * C.jitter * (0.035 + 0.05 * (noise(tick / 3u, 7u) - 0.5) + 0.018 * (ln - 0.5));
  let q = vec2f(uv.x + dx, uv.y);

  // luma stays sharp, chroma arrives late and smears to the right
  let c0 = tap(q);
  var late = vec3f(0.0);
  var w = 0.0;
  for (var i = 0; i < 6; i++) {
    let k = 1.0 - f32(i) * 0.13;
    late += tap(q - vec2f((0.004 + f32(i) * 0.0045) * (C.chroma + track), 0.0)) * k;
    w += k;
  }
  late /= w;
  let y = luma(c0);
  var col = max(vec3f(0.0), mix(c0, vec3f(y) + (late - vec3f(luma(late))) * 1.25, clamp(C.chroma * 1.4, 0.0, 1.0)));
  // a faint warm ghost of the bright parts trailing the picture
  col += tap(q - vec2f(0.022, 0.0)) * vec3f(0.14, 0.03, 0.02) * C.chroma;

  // snow: streaks along the lines in the burst and the head-switch region
  let cell = u32(clamp(q.x, 0.0, 1.0) * 220.0 + ln * 17.0);
  let sn = noise(cell + line * 911u, tick * 3u + 1u);
  let streak = step(0.82, sn) * (sn - 0.82) * 5.5;
  col += vec3f(0.9, 0.95, 1.0) * streak * (track * 1.3 + head * C.jitter * 0.45);

  // grain, scanlines (rolling slowly), aperture stripes
  let g = noise(u32(v.pos.x) + u32(v.pos.y) * 4099u, tick) - 0.5;
  col = max(vec3f(0.0), col + g * (0.012 + 0.03 * track) + vec3f(0.004, 0.005, 0.007));
  let wave = 0.5 - 0.5 * cos(uv.y * LINES * 6.2831853);
  col *= mix(1.0, wave * 1.45, C.scan * 0.85);
  let tri = u32(v.pos.x) % 3u;
  let stripe = vec3f(f32(tri == 0u), f32(tri == 1u), f32(tri == 2u));
  col *= mix(vec3f(1.0), 0.8 + stripe * 0.6, C.scan * 0.5);
  col *= 1.0 + 0.04 * C.scan * sin((uv.y - C.tick * 0.006) * 9.0);

  let vig = pow(clamp(16.0 * uv.x * uv.y * (1.0 - uv.x) * (1.0 - uv.y), 0.0, 1.0), C.vignette * 0.5);
  return vec4f(col * vig * inside, 1.0);
}
