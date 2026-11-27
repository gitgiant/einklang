// Media dye: stable fluids (semi-Lagrangian advection, vorticity confinement, Jacobi pressure
// projection) on a small velocity grid, advecting the picture itself as dye at a finer resolution.
// Velocity is in grid cells per tick; every pass is a fullscreen fragment pass into its own texture.
// Group 0: uniforms, sampler and two of the piece's own textures (which ones depends on the pass);
// group 1: the media inputs (picture, luma, edges).

struct U {
  grid: vec2f, dsize: vec2f,
  stir0: vec4f, stir1: vec4f, stir2: vec4f, stir3: vec4f, // x, y (uv), radius (screen heights), strength (signed)
  kick: vec4f,                                           // x, y, radius, impulse (cells/tick)
  edge: f32, along: f32, buoy: f32, vort: f32,
  damp: f32, relax: f32, tint: f32, gloss: f32,
  flash: f32, rms: f32, shift: f32, pal_n: f32,
  aspect: f32, wander: f32, t: f32, glow: f32,
  pal: array<vec4f, 8>,
};
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var ta: texture_2d<f32>;
@group(0) @binding(3) var tb: texture_2d<f32>;
@group(1) @binding(0) var pic: texture_2d<f32>;
@group(1) @binding(1) var lum: texture_2d<f32>;
@group(1) @binding(2) var edg: texture_2d<f32>;

fn la(c: vec2i) -> vec4f { return textureLoad(ta, clamp(c, vec2i(0), vec2i(u.grid) - 1), 0); }
fn lb(c: vec2i) -> vec4f { return textureLoad(tb, clamp(c, vec2i(0), vec2i(u.grid) - 1), 0); }
fn curl(c: vec2i) -> f32 {
  return 0.5 * (la(c + vec2i(1, 0)).y - la(c - vec2i(1, 0)).y - la(c + vec2i(0, 1)).x + la(c - vec2i(0, 1)).x);
}

fn swirl(q: vec2f, s: vec4f) -> vec2f {
  let d = q - vec2f(s.x * u.aspect, s.y);
  let f = exp(-dot(d, d) / (s.z * s.z));
  return vec2f(-d.y, d.x) / s.z * f * s.w;
}

// ---- velocity: advect itself, confine vorticity, add the forces
@fragment fn fs_vel(v: VOut) -> @location(0) vec4f {
  let c = vec2i(v.pos.xy);
  let g = vec2i(u.grid);
  if (c.x <= 0 || c.y <= 0 || c.x >= g.x - 1 || c.y >= g.y - 1) { return vec4f(0.0, 0.0, 0.0, 1.0); }
  let v0 = la(c).xy;
  var vel = textureSampleLevel(ta, samp, (v.pos.xy - v0) / u.grid, 0.0).xy * u.damp;
  let w = curl(c);
  let gw = vec2f(abs(curl(c + vec2i(1, 0))) - abs(curl(c - vec2i(1, 0))), abs(curl(c + vec2i(0, 1))) - abs(curl(c - vec2i(0, 1))));
  let n = gw / (length(gw) + 1e-5);
  vel += u.vort * vec2f(n.y, -n.x) * w;

  let uv = v.uv;
  let q = vec2f(uv.x * u.aspect, uv.y);
  vel += swirl(q, u.stir0) + swirl(q, u.stir1) + swirl(q, u.stir2) + swirl(q, u.stir3);
  let kd = q - vec2f(u.kick.x * u.aspect, u.kick.y);
  vel += kd / (length(kd) + 1e-3) * exp(-dot(kd, kd) / (u.kick.z * u.kick.z)) * u.kick.w;
  // the picture's contours: push along (or across) its luma gradient
  let e = textureSampleLevel(edg, samp, uv, 0.0).xy;
  let el = length(e);
  let ed = e / (el + 1e-4) * min(el, 1.5);
  vel += u.edge * (vec2f(-ed.y, ed.x) * u.along + ed * (1.0 - abs(u.along)));
  // bright areas rise, dark sink a little
  let l = textureSampleLevel(lum, samp, uv, 0.0).x;
  vel.y -= u.buoy * (l - 0.45);
  // a slow wander so nothing settles on quiet music
  vel += u.wander * vec2f(sin(q.y * 5.0 + u.t * 0.7 + sin(q.x * 3.0)), cos(q.x * 4.0 - u.t * 0.55 + cos(q.y * 2.5)));
  let sp = length(vel);
  vel *= min(1.0, 4.0 / max(sp, 1e-5));
  return vec4f(vel, 0.0, 1.0);
}

// ---- divergence of ta (the advected velocity)
@fragment fn fs_div(v: VOut) -> @location(0) vec4f {
  let c = vec2i(v.pos.xy);
  let d = 0.5 * (la(c + vec2i(1, 0)).x - la(c - vec2i(1, 0)).x + la(c + vec2i(0, 1)).y - la(c - vec2i(0, 1)).y);
  return vec4f(d, 0.0, 0.0, 1.0);
}

// ---- one Jacobi step: ta = pressure, tb = divergence
@fragment fn fs_jacobi(v: VOut) -> @location(0) vec4f {
  let c = vec2i(v.pos.xy);
  let p = (la(c + vec2i(1, 0)).x + la(c - vec2i(1, 0)).x + la(c + vec2i(0, 1)).x + la(c - vec2i(0, 1)).x - lb(c).x) * 0.25;
  return vec4f(p, 0.0, 0.0, 1.0);
}

// ---- projection: ta = velocity, tb = pressure
@fragment fn fs_project(v: VOut) -> @location(0) vec4f {
  let c = vec2i(v.pos.xy);
  let gp = 0.5 * vec2f(lb(c + vec2i(1, 0)).x - lb(c - vec2i(1, 0)).x, lb(c + vec2i(0, 1)).x - lb(c - vec2i(0, 1)).x);
  return vec4f(la(c).xy - gp, 0.0, 1.0);
}

// ---- dye: ta = dye, tb = velocity; advect, then the live picture seeps back in (bright areas first)
@fragment fn fs_dye(v: VOut) -> @location(0) vec4f {
  let uv = v.uv;
  let vel = textureSampleLevel(tb, samp, uv, 0.0).xy;
  var d = textureSampleLevel(ta, samp, uv - vel / u.grid, 0.0);
  let live = textureSampleLevel(pic, samp, uv, 0.0);
  let l = textureSampleLevel(lum, samp, uv, 0.0).x;
  let k = clamp(u.relax * (0.35 + 0.9 * l), 0.0, 1.0);
  return vec4f(max(mix(d.rgb, live.rgb, k), vec3f(0.0)), 1.0);
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

// ---- draw: ta = dye, tb = velocity; glossy liquid light from the dye's own luma, palette tint where it runs fast
@fragment fn fs_draw(v: VOut) -> @location(0) vec4f {
  let uv = v.uv;
  let px = 1.5 / u.dsize;
  let d = textureSampleLevel(ta, samp, uv, 0.0).rgb;
  let gx = luma(textureSampleLevel(ta, samp, uv + vec2f(px.x, 0.0), 0.0).rgb) - luma(textureSampleLevel(ta, samp, uv - vec2f(px.x, 0.0), 0.0).rgb);
  let gy = luma(textureSampleLevel(ta, samp, uv + vec2f(0.0, px.y), 0.0).rgb) - luma(textureSampleLevel(ta, samp, uv - vec2f(0.0, px.y), 0.0).rgb);
  let n = normalize(vec3f(-gx * 6.0 * u.gloss, -gy * 6.0 * u.gloss, 1.0));
  let spec = pow(max(dot(n, normalize(vec3f(-0.35, -0.45, 1.0))), 0.0), 28.0);
  let vel = textureSampleLevel(tb, samp, uv, 0.0).xy;
  let sp = length(vel);
  let run = smoothstep(0.15, 1.6, sp);
  let shade = 0.82 + 0.3 * n.z * n.z + 0.25 * (n.x * -0.35 + n.y * -0.45);
  var col = d * shade * (1.0 + 0.35 * u.flash + 0.15 * u.rms);
  col = mix(col, pal(u.shift + sp * 0.25 + luma(d) * 0.5) * (0.35 + 1.2 * luma(d)) * 1.4, run * u.tint);
  col += pal(u.shift + 0.8) * spec * u.gloss * (0.25 + 0.6 * u.flash) * 0.6;
  return vec4f(col * u.glow, 1.0);
}
