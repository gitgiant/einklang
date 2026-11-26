// Transition pass: mixes the outgoing (texA) and incoming (texB) HDR scenes into the scene
// target, before the post chain. `kind` indexes TRANSITIONS in core/protocol.ts; progress and
// every other input come from core/transitions.ts, so this only decides how the mix looks.

struct Trans {
  kind: u32,
  seed: u32,
  roll: u32,      // glitch: band re-roll index (every 1/16 beat)
  _p0: u32,
  p: f32,         // progress 0..1 (curve already applied)
  flash: f32,     // flash intensity 0..1
  aspect: f32,
  _p1: f32,
  center: vec2f,  // iris / zoom / swirl centre, uv
  res: vec2f,     // target size in pixels
  bands: array<vec4f, 4>, // 16 smoothed bands 0..1 (audio mask)
};
@group(0) @binding(0) var<uniform> T: Trans;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var texA: texture_2d<f32>;
@group(0) @binding(3) var texB: texture_2d<f32>;

fn sa(uv: vec2f) -> vec3f { return textureSampleLevel(texA, samp, uv, 0.0).rgb; }
fn sb(uv: vec2f) -> vec3f { return textureSampleLevel(texB, samp, uv, 0.0).rgb; }
fn inside(uv: vec2f) -> f32 { return select(0.0, 1.0, all(uv >= vec2f(0.0)) && all(uv <= vec2f(1.0))); }
fn rnd(a: u32, b: u32) -> f32 { return f32(h32(a, b) >> 8u) / 16777216.0; }
fn bandv(i: u32) -> f32 { return T.bands[i / 4u][i % 4u]; }
fn band(x: f32) -> f32 {
  let f = clamp(x, 0.0, 1.0) * 15.0;
  let i = u32(floor(f));
  return mix(bandv(i), bandv(min(i + 1u, 15u)), fract(f));
}
fn rot(d: vec2f, a: f32) -> vec2f { let c = cos(a); let s = sin(a); return vec2f(d.x * c - d.y * s, d.x * s + d.y * c); }

@fragment fn fs_trans(in: VOut) -> @location(0) vec4f {
  let uv = in.uv;
  let p = T.p;
  let bump = 4.0 * p * (1.0 - p); // 0 at both ends, 1 at the midpoint
  let asp = vec2f(T.aspect, 1.0);
  var c: vec3f;
  switch (T.kind) {
    case 1u: { // blend: linear crossfade in HDR
      c = mix(sa(uv), sb(uv), p);
    }
    case 2u: { // flash: additive blend plus a white flash
      c = sa(uv) * min(1.0, 2.0 * (1.0 - p)) + sb(uv) * min(1.0, 2.0 * p) + vec3f(T.flash * 3.0);
    }
    case 3u: { // wipe: soft line sweeping in a seeded direction
      let dir = rot(vec2f(1.0, 0.0), rnd(T.seed, 1u) * 6.2831853);
      let r = 0.5 * (abs(dir.x) * T.aspect + abs(dir.y));
      let s = (dot((uv - 0.5) * asp, dir) + r) / (2.0 * r);
      let soft = 0.08;
      let e = p * (1.0 + soft);
      c = mix(sa(uv), sb(uv), 1.0 - smoothstep(e - soft, e, s));
    }
    case 4u: { // iris: a circle opening from the centre
      let d = length((uv - T.center) * asp);
      let far = length(max(T.center, 1.0 - T.center) * asp);
      let soft = 0.05;
      let r = p * (far + soft);
      c = mix(sa(uv), sb(uv), 1.0 - smoothstep(r - soft, r, d));
    }
    case 5u: { // dissolve: per-cell noise threshold, seeded grain
      let grain = 2.0 + f32(h32(T.seed, 2u) % 5u);
      let cell = vec2u(floor(uv * T.res / grain));
      c = select(sa(uv), sb(uv), rnd(cell.x * 7919u + cell.y, T.seed) < p);
    }
    case 6u: { // luma: the new scene comes through the old one's brightest areas first
      let a = sa(uv);
      let l = 1.0 - exp(-dot(a, vec3f(0.2126, 0.7152, 0.0722)) * 2.0);
      let e = 1.0 - p * 1.2;
      c = mix(a, sb(uv), smoothstep(e, e + 0.2, l));
    }
    case 7u: { // zoom: the old scene zooms in and fades, the new one grows from small
      let qa = T.center + (uv - T.center) / (1.0 + p * 3.0);
      let qb = T.center + (uv - T.center) / max(p, 0.001);
      c = sa(qa) * (1.0 - p) + sb(qb) * inside(qb) * p;
    }
    case 8u: { // glitch: seeded horizontal bands swap scenes, with an RGB split
      let nb = 6u + h32(T.seed, 3u) % 18u;
      let b = u32(floor(clamp(uv.y, 0.0, 0.9999) * f32(nb)));
      let k = T.seed ^ (T.roll * 2654435761u);
      let off = (rnd(b + 97u, k) - 0.5) * 0.12 * bump;
      let sp = vec2f(0.012 * bump + off, 0.0);
      let o = vec2f(off, 0.0);
      let a = vec3f(sa(uv + sp).r, sa(uv + o).g, sa(uv - sp).b);
      let n = vec3f(sb(uv + sp).r, sb(uv + o).g, sb(uv - sp).b);
      c = select(a, n, rnd(b, k) < p);
    }
    case 9u: { // stutter: hard cuts (p is 0 or 1)
      c = select(sa(uv), sb(uv), p > 0.5);
    }
    case 10u: { // swirl: twist peaking at the midpoint
      let d = (uv - T.center) * asp;
      let w = max(0.0, 1.0 - length(d) / 0.9);
      let q = rot(d, bump * 6.0 * w * w) / asp + T.center;
      c = mix(sa(q), sb(q), p);
    }
    case 11u: { // melt: the old scene drips down in seeded columns (the post trails smear it)
      let drip = (0.5 + 0.5 * rnd(u32(uv.x * 160.0), T.seed)) * p * p * 0.6;
      let qa = uv - vec2f(0.0, drip);
      c = mix(sa(qa) * inside(qa), sb(uv), p);
    }
    case 12u: { // audio mask: the new scene shows where the spectrum (mirrored) and bass are
      let e = mix(band(uv.x), band(0.03), 0.4);
      let h = abs(uv.y - 0.5) * 2.0;
      let score = p + bump * 0.7 * (e * (1.0 - 0.7 * h) - 0.35);
      c = mix(sa(uv), sb(uv), smoothstep(0.45, 0.55, score));
    }
    case 13u: { // pixelate: both go blocky, swap at the coarsest point, then sharpen
      let blocks = mix(T.res.y, 9.0, pow(bump, 0.6));
      let cells = vec2f(blocks * T.aspect, blocks);
      let q = (floor(uv * cells) + 0.5) / cells;
      c = select(sa(q), sb(q), p >= 0.5);
    }
    default: {
      c = select(sa(uv), sb(uv), p >= 0.5);
    }
  }
  return vec4f(c, 1.0);
}
