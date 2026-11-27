// Render pass for agy-cymatic-sand:
// Pass 1 (vs_grain / fs_grain): additive HDR splat of photo-coloured sparkling sand grains
// Pass 2 (fs_resolve): tone-maps sand ridges over a subtly vibrating embossed media plate

struct Grain {
  pv: vec4f,
  col: vec4f,
};

struct Draw {
  res: vec2f, aspect: f32, size: f32,
  streak: f32, gain: f32, kick: f32, beat: f32,
  bass: f32, mid: f32, hi: f32, rms: f32,
  under: f32, pal_mix: f32, pal_n: f32, shift: f32,
  reform_env: f32, glow: f32, react: f32, mode: f32,
  m1: f32, n1: f32, s1: f32, rot: f32,
  has_luma: f32, has_edges: f32, time: f32, _pad0: f32,
  pal: array<vec4f, 8>,
};

@group(0) @binding(0) var<uniform> dr: Draw;
@group(0) @binding(1) var<storage, read> grains: array<Grain>;
@group(0) @binding(2) var smp: sampler;
@group(0) @binding(3) var tpic: texture_2d<f32>;
@group(0) @binding(4) var tacc: texture_2d<f32>;
@group(0) @binding(5) var tedges: texture_2d<f32>;

const PI: f32 = 3.14159265;

fn lab2lin(c: vec3f) -> vec3f {
  let l_ = c.x + 0.3963377774 * c.y + 0.2158037573 * c.z;
  let m_ = c.x - 0.1055613458 * c.y - 0.0638541728 * c.z;
  let s_ = c.x - 0.0894841775 * c.y - 1.291485548 * c.z;
  let l = l_ * l_ * l_;
  let m = m_ * m_ * m_;
  let s = s_ * s_ * s_;
  return max(vec3f(0.0), vec3f(
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ));
}

fn pal(x: f32) -> vec3f {
  let n = max(i32(dr.pal_n), 1);
  let t = fract(x + dr.shift);
  let f = t * f32(n - 1);
  let i = min(i32(floor(f)), n - 1);
  let j = min(i + 1, n - 1);
  return lab2lin(mix(dr.pal[i].xyz, dr.pal[j].xyz, f - f32(i)));
}

struct GOut {
  @builtin(position) pos: vec4f,
  @location(0) q: vec2f,
  @location(1) col: vec3f,
};

@vertex fn vs_grain(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> GOut {
  let g = grains[ii];
  let corner = array<vec2f, 6>(
    vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(-1.0, 1.0),
    vec2f(-1.0, 1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0)
  )[vi];

  let vel = g.pv.zw;
  let sp = length(vel);
  let dir = select(vec2f(1.0, 0.0), vel / sp, sp > 1e-5);
  let perp = vec2f(-dir.y, dir.x);

  let audio_lvl = clamp(dr.rms * 1.4 + dr.bass + dr.kick, 0.0, 2.2);
  let act = smoothstep(0.025, 0.25, audio_lvl) * dr.react;

  let px = 1.0 / dr.res.y;
  let energy = g.col.w;
  let rad = dr.size * px * (0.85 + 0.45 * dr.kick * act + 0.22 * dr.bass * act + 0.18 * clamp(energy, 0.0, 1.5));
  let len = rad * (1.0 + dr.streak * clamp(sp * 85.0, 0.0, 3.2));

  let off = dir * (corner.x * len) + perp * (corner.y * rad);
  let p = g.pv.xy + vec2f(off.x / max(dr.aspect, 0.5), off.y);

  // Vivid sand colour: lifted media hue + palette metallic/neon highlight on vibrating grains
  var c = max(g.col.rgb, vec3f(0.0));
  let lum = dot(c, vec3f(0.2126, 0.7152, 0.0722));
  // Boost saturation & keep dark regions readable as fine mineral sand
  let sat_c = max(mix(vec3f(lum), c, 1.28), vec3f(0.0));
  let hue_norm = sat_c / max(max(sat_c.r, max(sat_c.g, sat_c.b)), 0.08);
  let sand_pic = hue_norm * (0.24 + 0.78 * sqrt(clamp(lum * 1.55, 0.0, 1.0)));

  let pal_c = pal(fract(lum * 0.65 + energy * 0.35 + f32(ii & 255u) / 256.0 * 0.12));
  let pal_w = clamp(dr.pal_mix * (0.35 + 0.65 * clamp(energy, 0.0, 1.2) + 0.35 * dr.hi * act), 0.0, 0.88);
  var out_col = mix(sand_pic, pal_c * 1.15, pal_w);
  out_col = out_col * (0.85 + 0.55 * clamp(energy, 0.0, 1.4) + 0.45 * dr.kick * act);

  var o: GOut;
  o.pos = vec4f(p.x * 2.0 - 1.0, 1.0 - p.y * 2.0, 0.0, 1.0);
  o.q = corner;
  o.col = out_col * dr.gain;
  return o;
}

@fragment fn fs_grain(in: GOut) -> @location(0) vec4f {
  let r2 = dot(in.q, in.q);
  if (r2 > 1.0) { discard; }
  // Sharp mineral-grain core with soft halo
  let w = exp(-r2 * 3.4) * (1.0 - r2);
  return vec4f(in.col * w, w);
}

fn plate_wave(uv: vec2f) -> f32 {
  let p = vec2f((uv.x - 0.5) * dr.aspect * 0.92, (uv.y - 0.5) * 1.04);
  let mode = i32(dr.mode + 0.5);
  if (mode == 0) {
    let x = p.x * PI;
    let y = p.y * PI;
    return 0.5 * (cos(dr.n1 * x) * cos(dr.m1 * y) + dr.s1 * cos(dr.m1 * x) * cos(dr.n1 * y));
  } else if (mode == 1) {
    let r = length(p);
    let a = atan2(p.y, p.x);
    let kr = (dr.m1 + 1.5) * 1.45;
    let kang = max(2.0, floor(dr.n1 + 1.0));
    return 0.55 * cos(kr * r * PI) * cos(kang * (a + dr.rot))
         + 0.45 * dr.s1 * cos((kr + 1.15) * r * PI) * cos(max(1.0, kang - 1.0) * (a - dr.rot * 0.65));
  } else {
    let ca = cos(dr.rot * 0.7);
    let sa = sin(dr.rot * 0.7);
    let u = p.x * ca - p.y * sa;
    return sin(u * (dr.m1 + 2.2) * 1.65 * PI - dr.time * (0.9 + 0.8 * dr.bass));
  }
}

@fragment fn fs_resolve(@builtin(position) pos: vec4f, @location(0) uv: vec2f) -> @location(0) vec4f {
  let acc = textureSampleLevel(tacc, smp, uv, 0.0);
  let raw_pic = max(textureSampleLevel(tpic, smp, uv, 0.0).rgb, vec3f(0.0));
  let ed = select(vec2f(0.0), textureSampleLevel(tedges, smp, uv, 0.0).rg, dr.has_edges > 0.5);
  let em = clamp(length(ed) * 1.45, 0.0, 1.6);

  let audio_lvl = clamp(dr.rms * 1.4 + dr.bass * 1.1 + dr.hi * 0.8 + dr.kick, 0.0, 2.5);
  let act = smoothstep(0.025, 0.25, audio_lvl) * dr.react;

  // Standing-wave Chladni sheen etched softly on the vibrating plate
  let wv = plate_wave(uv);
  let nodal_line = exp(-abs(wv) * 11.0);
  let antinode_buzz = clamp(abs(wv), 0.0, 1.0);

  // Subtle acoustic vibration UV micro-shimmer on the underlying picture plate when bass hits
  let buzz_uv = uv + vec2f(sin(uv.y * 90.0 + dr.time * 28.0), cos(uv.x * 90.0 - dr.time * 24.0))
                   * (0.0028 * antinode_buzz * (dr.bass + 0.8 * dr.kick) * act * (1.0 - 0.8 * dr.reform_env));
  let pic = max(textureSampleLevel(tpic, smp, clamp(buzz_uv, vec2f(0.001), vec2f(0.999)), 0.0).rgb, vec3f(0.0));

  // Plate underlay: darkens slightly in vibrating antinodes on dense audio so bright sand dunes pop!
  let under_amt = mix(dr.under * (0.95 - 0.35 * antinode_buzz * act), 0.82, dr.reform_env * 0.72);
  let plate_tint = mix(vec3f(0.10, 0.11, 0.14), pal(0.15) * 0.28, dr.pal_mix);
  let plate_col = pic * under_amt + plate_tint * (0.14 + 0.14 * (1.0 - under_amt));

  // Softly compress accumulated sand density so dense nodal ridges are luminous & rich, not clipped
  let density = max(acc.a, 0.0);
  let sand_rgb = acc.rgb / (vec3f(1.0) + acc.rgb * 0.52);
  let ridge_boost = 1.0 + 0.55 * smoothstep(0.4, 2.4, density) * (0.35 + 0.85 * act);

  // Crisp glowing nodal-line & media-edge metallic sheen
  let pal_hi = pal(fract(0.65 + dr.hi * 0.35 + abs(wv) * 0.3));
  let nodal_glint = nodal_line * (0.04 + 0.36 * act * (0.4 + dr.hi + 0.8 * dr.kick)) * (1.0 - 0.6 * dr.reform_env);
  let edge_glint = em * (0.05 + 0.42 * act * (0.5 + dr.bass + 0.8 * dr.kick));

  var col = plate_col
          + sand_rgb * ridge_boost * dr.glow * (0.82 + 0.36 * act * (0.5 + dr.bass + 0.7 * dr.kick))
          + pal_hi * (nodal_glint + edge_glint * 0.55);

  // Phrase re-formation snap: smoothly clarifies the picture between phrase swaps
  col = mix(col, raw_pic * (0.94 + 0.18 * dr.beat), dr.reform_env * 0.48);

  // Safe soft HDR rolloff
  col = max(col, vec3f(0.0));
  col = col / (vec3f(1.0) + col * 0.22);

  return vec4f(col, 1.0);
}
