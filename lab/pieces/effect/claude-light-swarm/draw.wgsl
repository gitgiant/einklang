// Two passes. Motes: one soft streak per particle, stretched along its velocity, added into an
// accumulation target (rgb = colour * weight, a = weight). Resolve: the motes' mean colour lit by
// their density, over a dim copy of the picture; onsets flash the dense places in the palette.

struct Draw {
  aspect: f32, size: f32, streak: f32, gain: f32,
  bg: f32, flash: f32, shift: f32, pal_n: f32,
  sat: f32, glow: f32, _a: f32, _b: f32,
  pal: array<vec4f, 8>, // OKLab stops
};
struct P { pv: vec4f, col: vec4f };
@group(0) @binding(0) var<uniform> dr: Draw;
@group(0) @binding(1) var<storage, read> ps: array<P>;
@group(0) @binding(2) var smp: sampler;
@group(0) @binding(3) var accum: texture_2d<f32>;
@group(0) @binding(4) var media: texture_2d<f32>;

const LW: vec3f = vec3f(0.2126, 0.7152, 0.0722);

struct MOut { @builtin(position) pos: vec4f, @location(0) q: vec2f, @location(1) col: vec3f };

@vertex fn vs_mote(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> MOut {
  let p = ps[ii];
  let corner = array<vec2f, 6>(vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0), vec2f(-1.0, -1.0), vec2f(1.0, 1.0), vec2f(-1.0, 1.0));
  let c = corner[vi];
  let v = p.pv.zw;
  let sp = length(v);
  let dir = select(vec2f(1.0, 0.0), v / max(sp, 1e-5), sp > 1e-4);
  let along = dr.size * (1.0 + dr.streak * sp);
  let off = dir * c.x * along + vec2f(-dir.y, dir.x) * c.y * dr.size;
  let w = p.pv.xy + off;
  var o: MOut;
  o.pos = vec4f(w.x / dr.aspect * 2.0 - 1.0, 1.0 - w.y * 2.0, 0.0, 1.0);
  o.q = c;
  // fade in and out over the mote's life
  let life = p.col.w;
  o.col = p.col.rgb * smoothstep(0.0, 0.15, life) * smoothstep(1.0, 0.85, life);
  return o;
}

@fragment fn fs_mote(m: MOut) -> @location(0) vec4f {
  let w = exp(-dot(m.q, m.q) * 3.0);
  return vec4f(m.col * w, w);
}

fn lab2lin(c: vec3f) -> vec3f {
  let l_ = c.x + 0.3963377774 * c.y + 0.2158037573 * c.z;
  let m_ = c.x - 0.1055613458 * c.y - 0.0638541728 * c.z;
  let s_ = c.x - 0.0894841775 * c.y - 1.291485548 * c.z;
  let l = l_ * l_ * l_;
  let m = m_ * m_ * m_;
  let s = s_ * s_ * s_;
  return max(vec3f(0.0), vec3f(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s));
}

fn pal(x: f32) -> vec3f {
  let n = max(i32(dr.pal_n), 1);
  let f = fract(x) * f32(n - 1);
  let i = min(i32(floor(f)), n - 1);
  let j = min(i + 1, n - 1);
  return lab2lin(mix(dr.pal[i].xyz, dr.pal[j].xyz, f - f32(i)));
}

@fragment fn fs_resolve(v: VOut) -> @location(0) vec4f {
  let a = textureSampleLevel(accum, smp, v.uv, 0.0);
  let c = max(textureSampleLevel(media, smp, v.uv, 0.0).rgb, vec3f(0.0));
  let mean = a.rgb / max(a.a, 1e-3);
  let lum = dot(mean, LW);
  // lift the motes' colour toward full saturation, keep a floor so dark motes still read
  let vivid = mix(vec3f(lum), mean, 1.0 + 0.6 * dr.sat) + 0.06;
  let dens = 1.0 - exp(-a.a * dr.gain);
  var col = c * dr.bg + max(vivid, vec3f(0.0)) * dens * 1.5;
  col += pal(dr.shift + 0.6 * dens) * dens * dens * (0.15 * dr.glow + dr.flash);
  return vec4f(col, 1.0);
}
