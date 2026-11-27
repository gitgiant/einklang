// Media erosion: hydraulic erosion on the picture's luma (virtual-pipe shallow water, Mei et al. 2007).
// The ground is the picture's luma times `relief` plus a carved offset the water cuts into it; water
// falls as rain and onset floods, the bass tips the whole picture so it runs, the flow picks up
// sediment where it is fast and steep and drops it where it slows. A pigment layer (the picture's
// colours, or ink on paper in the wet-paper look) is advected by the same flow.
// Heights and depths are in grid cells, flux is volume per step across a cell face.
// Group 0: uniforms (one block per substep, dynamic offset), sampler, two unfilterable state
// textures (rgba32f) and two filterable ones; group 1: the media (picture, luma, edges).

struct U {
  grid: vec2f, psize: vec2f,
  tilt: vec2f, rain: f32, relief: f32,
  flood: vec4f,                         // x, y (uv), radius (screen heights), depth added this step
  kflux: f32, fdamp: f32, evap: f32, cap: f32,
  ks: f32, kd: f32, relax: f32, slump: f32,
  look: f32, gloss: f32, tint: f32, glow: f32,
  flash: f32, rms: f32, shift: f32, pal_n: f32,
  aspect: f32, t: f32, prelax: f32, seed: f32,
  steps: f32, ink: f32, drops: f32, water: f32,
  drop: vec4f,                          // wet paper: x ink dropped at the flood spot this tick, yzw its colour (linear)
  pal: array<vec4f, 8>,
};
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var sa: texture_2d<f32>;
@group(0) @binding(3) var sb: texture_2d<f32>;
@group(0) @binding(4) var fa: texture_2d<f32>;
@group(0) @binding(5) var fb: texture_2d<f32>;
@group(1) @binding(0) var pic: texture_2d<f32>;
@group(1) @binding(1) var lum: texture_2d<f32>;
@group(1) @binding(2) var edg: texture_2d<f32>;

fn gsz() -> vec2i { return vec2i(u.grid); }
fn inb(c: vec2i) -> bool { return all(c >= vec2i(0)) && all(c < gsz()); }
fn la(c: vec2i) -> vec4f { return textureLoad(sa, clamp(c, vec2i(0), gsz() - 1), 0); }
fn lb(c: vec2i) -> vec4f { return textureLoad(sb, clamp(c, vec2i(0), gsz() - 1), 0); }
fn rnd(c: vec2i, s: u32) -> f32 { return f32(h32(bitcast<u32>(c.x) * 4099u + bitcast<u32>(c.y), s) >> 8u) / 16777216.0; }

// state: x = carved offset, y = water depth, z = suspended sediment, w = ground from the picture
fn surf(c: vec2i, s: vec4f) -> f32 { return s.w + s.x + s.y - dot(u.tilt, vec2f(c)); }
fn ground(s: vec4f) -> f32 { return s.w + s.x; }

fn pipe(c: vec2i, n: vec2i, h: f32, g: f32, f: f32) -> f32 {
  var hn = g - dot(u.tilt, vec2f(n)) - 0.15; // past the border: dry ground a little lower, so water drains off
  if (inb(n)) { hn = surf(n, la(n)); }
  return max(0.0, f * u.fdamp + u.kflux * (h - hn));
}

// ---- 1. outflow through the four pipes (sa = state, sb = flux: x left, y right, z up, w down)
@fragment fn fs_flux(v: VOut) -> @location(0) vec4f {
  let c = vec2i(v.pos.xy);
  let s = la(c);
  let h = surf(c, s);
  let g = ground(s);
  let f = lb(c);
  var o = vec4f(pipe(c, c + vec2i(-1, 0), h, g, f.x), pipe(c, c + vec2i(1, 0), h, g, f.y),
                pipe(c, c + vec2i(0, -1), h, g, f.z), pipe(c, c + vec2i(0, 1), h, g, f.w));
  let tot = o.x + o.y + o.z + o.w;
  return o * min(1.0, s.y / max(tot, 1e-6));
}

// ---- 2. water balance, velocity, erosion / deposition, rain (sa = state, sb = new flux)
struct O2 { @location(0) s: vec4f, @location(1) v: vec4f };
@fragment fn fs_update(v: VOut) -> O2 {
  let c = vec2i(v.pos.xy);
  let g = gsz();
  var s = la(c);
  let f = lb(c);
  let fl = select(vec4f(0.0), lb(c - vec2i(1, 0)), c.x > 0);
  let fr = select(vec4f(0.0), lb(c + vec2i(1, 0)), c.x < g.x - 1);
  let fu = select(vec4f(0.0), lb(c - vec2i(0, 1)), c.y > 0);
  let fd = select(vec4f(0.0), lb(c + vec2i(0, 1)), c.y < g.y - 1);
  let d0 = s.y;
  var d = max(0.0, d0 + (fl.y + fr.x + fu.w + fd.z) - (f.x + f.y + f.z + f.w));
  let w = vec2f(0.5 * (fl.y - f.x + f.y - fr.x), 0.5 * (fu.w - f.z + f.w - fd.z));
  var vel = w / max(0.5 * (d0 + d), 0.03);
  let sp = length(vel);
  if (sp > 1.0) { vel *= 1.0 / sp; }

  // the water carves where it runs fast down a slope, and drops its load where it slows
  let gx = 0.5 * (ground(la(c + vec2i(1, 0))) - ground(la(c - vec2i(1, 0))));
  let gy = 0.5 * (ground(la(c + vec2i(0, 1))) - ground(la(c - vec2i(0, 1))));
  let cap = u.cap * (min(length(vec2f(gx, gy)), 2.0) + 0.2) * min(length(vel), 1.5) * smoothstep(0.0, 0.04, d);
  if (s.z < cap) {
    let e = min(u.ks * (cap - s.z), 0.04);
    s.x -= e; s.z += e;
  } else {
    let e = u.kd * (s.z - cap);
    s.x += e; s.z -= e;
  }
  s.x = clamp(s.x, -0.8 * u.relief - 0.5, 0.4 * u.relief + 0.3);

  // rain: a fine drizzle plus scattered drops; the onset flood
  let seed = u32(u.seed);
  d += u.rain * (0.3 + 0.7 * rnd(c / 6, seed ^ 0x51u));
  if (rnd(c, seed) < u.drops) { d += 0.35 + 0.5 * rnd(c, seed ^ 0x77u); }
  let uv = (vec2f(c) + 0.5) / u.grid;
  let q = vec2f((uv.x - u.flood.x) * u.aspect, uv.y - u.flood.y);
  d += u.flood.w * exp(-dot(q, q) / (u.flood.z * u.flood.z));
  d = min(d * (1.0 - u.evap), 4.0);
  s.y = d;
  return O2(s, vec4f(vel, length(vel), smoothstep(0.02, 0.25, d)));
}

// ---- 3. sediment rides the flow, the cuts slump a little, the ground follows the (live) picture
// (sa = state after 2, fa = velocity)
struct O3 { @location(0) s: vec4f, @location(1) view: vec4f };
@fragment fn fs_move(v: VOut) -> O3 {
  let c = vec2i(v.pos.xy);
  var s = la(c);
  let vel = textureLoad(fa, c, 0).xy;
  let p = vec2f(c) - vel;
  let i = vec2i(floor(p));
  let t = p - floor(p);
  s.z = mix(mix(la(i).z, la(i + vec2i(1, 0)).z, t.x), mix(la(i + vec2i(0, 1)).z, la(i + vec2i(1, 1)).z, t.x), t.y);
  let avg = 0.25 * (la(c + vec2i(1, 0)).x + la(c - vec2i(1, 0)).x + la(c + vec2i(0, 1)).x + la(c - vec2i(0, 1)).x);
  s.x += u.slump * (avg - s.x);
  s.x *= 1.0 - u.relax;
  s.z *= 1.0 - u.relax;
  s.y *= 1.0 - 0.5 * u.relax;
  let uv = (vec2f(c) + 0.5) / u.grid;
  let hp = 0.3 / u.grid;
  let l = 0.25 * (textureSampleLevel(lum, samp, uv + vec2f(-hp.x, -hp.y), 0.0).x + textureSampleLevel(lum, samp, uv + vec2f(hp.x, -hp.y), 0.0).x
                + textureSampleLevel(lum, samp, uv + vec2f(-hp.x, hp.y), 0.0).x + textureSampleLevel(lum, samp, uv + vec2f(hp.x, hp.y), 0.0).x);
  s.w = clamp(l, 0.0, 1.5) * u.relief;
  return O3(s, vec4f(s.x, s.y, s.z, length(vel)));
}

// ---- 4. pigment, once per tick: advected by the flow, bleeding where wet, the live picture seeping
// back where dry (fa = pigment, fb = velocity)
@fragment fn fs_pig(v: VOut) -> @location(0) vec4f {
  let uv = v.uv;
  let vv = textureSampleLevel(fb, samp, uv, 0.0);
  // only running water (not the drizzle film) carries the pigment, at half its speed
  let back = uv - vv.xy * vv.w * u.steps * 0.5 / u.grid;
  let px = 1.0 / u.psize;
  var p = textureSampleLevel(fa, samp, back, 0.0).rgb;
  let nb = 0.25 * (textureSampleLevel(fa, samp, back + vec2f(px.x, 0.0), 0.0).rgb + textureSampleLevel(fa, samp, back - vec2f(px.x, 0.0), 0.0).rgb
                 + textureSampleLevel(fa, samp, back + vec2f(0.0, px.y), 0.0).rgb + textureSampleLevel(fa, samp, back - vec2f(0.0, px.y), 0.0).rgb);
  let wet = vv.w;
  p = mix(p, nb, wet * select(0.15, 0.5, u.look > 0.5));
  let live = max(textureSampleLevel(pic, samp, uv, 0.0).rgb, vec3f(0.0));
  var goal = live;
  if (u.look > 0.5) {
    // ink density: the picture's darks, and its contours drawn in heavier ink
    let e = length(textureSampleLevel(edg, samp, uv, 0.0).xy);
    goal = (1.0 - sqrt(min(live, vec3f(1.0)))) * 0.75 + vec3f(smoothstep(0.06, 0.5, e) * u.ink);
  }
  let k = clamp(u.prelax * (1.0 - 0.75 * wet), 0.0, 1.0);
  p = mix(p, goal, k);
  if (u.look > 0.5 && u.drop.x > 0.0) {
    // an onset drops coloured ink with its water: it blooms out with the flood
    let q = vec2f((uv.x - u.flood.x) * u.aspect, uv.y - u.flood.y);
    let a = u.drop.x * exp(-dot(q, q) / (0.5 * u.flood.z * u.flood.z));
    p = mix(p, (1.0 - sqrt(min(u.drop.yzw, vec3f(1.0)))) * 1.4, clamp(a, 0.0, 1.0));
  }
  return vec4f(p, 1.0);
}

fn lab2lin(c: vec3f) -> vec3f {
  let l_ = c.x + 0.3963377774 * c.y + 0.2158037573 * c.z;
  let m_ = c.x - 0.1055613458 * c.y - 0.0638541728 * c.z;
  let s_ = c.x - 0.0894841775 * c.y - 1.291485548 * c.z;
  return max(vec3f(0.0), vec3f(4.0767416621 * l_ * l_ * l_ - 3.3077115913 * m_ * m_ * m_ + 0.2309699292 * s_ * s_ * s_,
    -1.2684380046 * l_ * l_ * l_ + 2.6097574011 * m_ * m_ * m_ - 0.3413193965 * s_ * s_ * s_,
    -0.0041960863 * l_ * l_ * l_ - 0.7034186147 * m_ * m_ * m_ + 1.707614701 * s_ * s_ * s_));
}
fn pal(x: f32) -> vec3f {
  let n = max(i32(u.pal_n), 1);
  let f = (1.0 - abs(fract(x * 0.5) * 2.0 - 1.0)) * f32(n - 1);
  let i = min(i32(floor(f)), n - 1);
  let j = min(i + 1, n - 1);
  return lab2lin(mix(u.pal[i].xyz, u.pal[j].xyz, f - f32(i)));
}
fn luma(c: vec3f) -> f32 { return dot(c, vec3f(0.2126, 0.7152, 0.0722)); }
fn vnoise(p: vec2f) -> f32 {
  let i = floor(p);
  let f = p - i;
  let w = f * f * (3.0 - 2.0 * f);
  let a = rnd(vec2i(i), 9u);
  let b = rnd(vec2i(i) + vec2i(1, 0), 9u);
  let c = rnd(vec2i(i) + vec2i(0, 1), 9u);
  let d = rnd(vec2i(i) + vec2i(1, 1), 9u);
  return mix(mix(a, b, w.x), mix(c, d, w.x), w.y);
}

// ground (picture luma + carved offset) and water at a uv: x ground, y water, z speed, w sediment
fn at(uv: vec2f) -> vec4f {
  let w = textureSampleLevel(fa, samp, uv, 0.0);
  let l = textureSampleLevel(lum, samp, uv, 0.0).x;
  return vec4f(clamp(l, 0.0, 1.5) * u.relief + w.x, w.y, w.w, w.z);
}

// ---- draw (fa = view: offset, water, sediment, speed; fb = pigment)
@fragment fn fs_draw(v: VOut) -> @location(0) vec4f {
  let uv = v.uv;
  let px = 1.0 / u.grid;
  let c0 = at(uv);
  let w0 = textureSampleLevel(fa, samp, uv, 0.0);
  let hl = at(uv - vec2f(px.x, 0.0));
  let hr = at(uv + vec2f(px.x, 0.0));
  let hu = at(uv - vec2f(0.0, px.y));
  let hd = at(uv + vec2f(0.0, px.y));
  let ng = normalize(vec3f(-(hr.x - hl.x) * 0.9 * u.gloss, -(hd.x - hu.x) * 0.9 * u.gloss, 1.0));
  let ws = vec2f((hr.x + hr.y) - (hl.x + hl.y), (hd.x + hd.y) - (hu.x + hu.y));
  let nw = normalize(vec3f(-ws * 2.5 * u.gloss, 1.0));
  let ldir = normalize(vec3f(-0.45, -0.55, 0.7));
  let depth = c0.y;
  let sp = c0.z;
  let pg = textureSampleLevel(fb, samp, uv, 0.0).rgb;
  let hv = normalize(ldir + vec3f(0.0, 0.0, 1.0));
  let spec = pow(max(dot(nw, hv), 0.0), 60.0);
  let tide = smoothstep(0.03, 0.2, length(vec2f(hr.y - hl.y, hd.y - hu.y)));
  var col: vec3f;
  if (u.look < 0.5) {
    // ---- eroded picture: lit relief, cuts show palette strata, deposits sandy, water glossy on top
    let light = clamp(0.62 + 0.6 * dot(ng, ldir), 0.15, 1.45);
    col = pg * light;
    let carve = smoothstep(0.02, 0.15 * u.relief + 0.1, -w0.x);
    let dep = smoothstep(0.02, 0.1 * u.relief + 0.05, w0.x);
    let band = 0.75 + 0.25 * sin(c0.x * 6.0);
    let strata = pal(u.shift + c0.x * 0.35) * (0.3 + 0.55 * light) * band;
    col = mix(col, strata + pg * 0.15, carve * 0.8);
    col = mix(col, (pg * 0.5 + pal(u.shift + 0.6) * 0.35 + vec3f(0.12, 0.1, 0.07)) * light, dep * 0.5);
    let a = (1.0 - exp(-depth * 5.0 * u.water)) * 0.85;
    let deep = pal(u.shift + 0.3) * (0.4 + 0.15 * u.rms) + pg * 0.3;
    let foam = smoothstep(0.15, 0.7, sp) * smoothstep(0.03, 0.2, depth);
    col = mix(col, col * 0.3 + deep, a);
    col += pal(u.shift + 0.85) * spec * a * u.gloss * (0.5 + 0.9 * u.flash);
    col += mix(vec3f(0.9), pal(u.shift + 0.7), 0.5) * foam * u.tint * (0.6 + 0.8 * u.flash + 0.5 * u.rms);
    col += pal(u.shift + 0.4) * tide * a * 0.25 * u.water;
  } else {
    // ---- wet paper: ink densities on a fibrous sheet, darker and glossy where wet, tide lines at the edges
    let fib = vnoise(uv * vec2f(u.aspect, 1.0) * 420.0) * 0.6 + vnoise(uv * vec2f(u.aspect * 90.0, 160.0)) * 0.4;
    let paper = mix(vec3f(0.95, 0.92, 0.86), pal(u.shift + 0.95) * 1.2 + 0.4, 0.12) * (0.9 + 0.1 * fib);
    let wet = smoothstep(0.01, 0.25, depth);
    let gran = 1.0 + 0.35 * (fib - 0.5) * (1.0 - wet);
    col = paper * exp(-pg * 2.0 * gran);
    col *= 1.0 - 0.4 * wet * u.water;
    let tint = pal(u.shift + 0.3 + 0.4 * luma(pg));
    col = mix(col, col * tint * 1.6, clamp(wet * u.tint * 0.8, 0.0, 1.0));
    col *= 1.0 - tide * 0.55 * u.water;
    col += vec3f(1.0) * spec * wet * u.gloss * (0.25 + 0.7 * u.flash);
    col += pal(u.shift + 0.7) * smoothstep(0.4, 1.2, sp) * wet * u.tint * (0.3 + 0.6 * u.flash);
  }
  return vec4f(max(col, vec3f(0.0)) * u.glow, 1.0);
}
