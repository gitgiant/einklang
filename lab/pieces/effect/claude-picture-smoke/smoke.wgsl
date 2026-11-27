// Picture smoke: stable fluids (Stam) whose dye is the picture. Fragment passes on rgba16f
// textures, y down (uv 0,0 = top-left). Velocity in sim cells per second, the grid is square cells.
// Per step: fs_curl, fs_vel (advect + vorticity confinement + luma buoyancy + the swirls + the
// onset burst), fs_div, fs_jacobi x N (pressure), fs_grad, fs_dye (advect the colours, then relax
// them back toward the picture). fs_draw tone-maps the dye and lets fast swirls glow in the palette.

struct U {
  size: vec2f, dsize: vec2f,
  dt: f32, vdiss: f32, vort: f32, buoy: f32,
  restore: f32, fade: f32, has_luma: f32, init: f32,
  splat: vec4f,   // onset: x, y (uv), radius (screen heights), radial push (cells/s)
  splat2: vec4f,  // onset: swirl (cells/s), _, _, _
  emit: array<vec4f, 4>,  // x, y (uv), radius (screen heights), swirl (cells/s^2, signed)
  emitb: array<vec4f, 4>, // outward push (cells/s^2), _, _, _
  look: vec4f,    // exposure, flash, sheen, saturation
  look2: vec4f,   // palette stops, palette shift, aspect, swirl count
  pal: array<vec4f, 8>,
};
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var smp: sampler;
@group(0) @binding(2) var ta: texture_2d<f32>;
@group(0) @binding(3) var tb: texture_2d<f32>;
@group(0) @binding(4) var tm: texture_2d<f32>;
@group(0) @binding(5) var tl: texture_2d<f32>;

fn ld(t: texture_2d<f32>, p: vec2i) -> vec4f {
  let s = vec2i(textureDimensions(t));
  return textureLoad(t, clamp(p, vec2i(0), s - 1), 0);
}

fn cellOf(pos: vec4f) -> vec2i { return vec2i(floor(pos.xy)); }

fn luma_at(uv: vec2f) -> f32 {
  if (u.has_luma > 0.5) { return textureSampleLevel(tl, smp, uv, 0.0).r; }
  let c = textureSampleLevel(tm, smp, uv, 0.0).rgb;
  return dot(min(c, vec3f(4.0)), vec3f(0.2126, 0.7152, 0.0722));
}

@fragment fn fs_curl(v: VOut) -> @location(0) vec4f {
  let c = cellOf(v.pos);
  let l = ld(ta, c + vec2i(-1, 0)).xy;
  let r = ld(ta, c + vec2i(1, 0)).xy;
  let t = ld(ta, c + vec2i(0, -1)).xy;
  let b = ld(ta, c + vec2i(0, 1)).xy;
  return vec4f(0.5 * ((r.y - l.y) - (b.x - t.x)), 0.0, 0.0, 1.0);
}

// a swirl around c: tangential, gaussian falloff; d in screen heights
fn swirl(uv: vec2f, c: vec2f, r: f32) -> vec3f {
  let d = (uv - c) * vec2f(u.look2.z, 1.0);
  let g = exp(-dot(d, d) / max(r * r, 1e-6));
  return vec3f(vec2f(-d.y, d.x) / max(length(d), 1e-4), g);
}

@fragment fn fs_vel(v: VOut) -> @location(0) vec4f {
  let c = cellOf(v.pos);
  let uv = v.uv;
  let v0 = ld(ta, c).xy;
  // semi-Lagrangian: where did this cell's fluid come from
  var vel = textureSampleLevel(ta, smp, uv - u.dt * v0 / u.size, 0.0).xy * u.vdiss;
  // vorticity confinement
  let wl = abs(ld(tb, c + vec2i(-1, 0)).x);
  let wr = abs(ld(tb, c + vec2i(1, 0)).x);
  let wt = abs(ld(tb, c + vec2i(0, -1)).x);
  let wb = abs(ld(tb, c + vec2i(0, 1)).x);
  let w = ld(tb, c).x;
  var n = 0.5 * vec2f(wr - wl, wb - wt);
  n = n / (length(n) + 1e-4);
  // confinement, capped so strong settings sharpen eddies instead of going unstable
  var f = u.vort * vec2f(n.y * w, -n.x * w);
  let fl = length(f);
  let cap = 4.0 * u.size.y;
  if (fl > cap) { f *= cap / fl; }
  // bright parts of the picture rise like hot smoke, dark parts sink a little
  f.y -= u.buoy * (luma_at(uv) - 0.35);
  // the swirls (bass) and their outward breath (beat)
  for (var k = 0; k < i32(u.look2.w); k++) {
    let e = u.emit[k];
    let s = swirl(uv, e.xy, e.z);
    let d = (uv - e.xy) * vec2f(u.look2.z, 1.0);
    f += s.z * (s.xy * e.w + d / max(length(d), 1e-4) * u.emitb[k].x);
  }
  vel += f * u.dt;
  // onset: a burst pushing the picture out of a spot, with a twist
  if (u.splat.w != 0.0 || u.splat2.x != 0.0) {
    let s = swirl(uv, u.splat.xy, u.splat.z);
    let d = (uv - u.splat.xy) * vec2f(u.look2.z, 1.0);
    vel += s.z * (d / max(length(d), 1e-4) * u.splat.w + s.xy * u.splat2.x);
  }
  // soft walls: the edges slow the flow so colours don't pile up there
  let edge = min(min(uv.x, 1.0 - uv.x) * u.look2.z, min(uv.y, 1.0 - uv.y));
  vel *= smoothstep(0.0, 0.03, edge);
  // at most ~2.5 screen heights per second
  let vl = length(vel);
  let vmax = 2.5 * u.size.y;
  if (vl > vmax) { vel *= vmax / vl; }
  return vec4f(vel, 0.0, 1.0);
}

@fragment fn fs_div(v: VOut) -> @location(0) vec4f {
  let c = cellOf(v.pos);
  let s = vec2i(u.size);
  // walls: the velocity across the border is mirrored, so nothing flows out
  var l = ld(ta, c + vec2i(-1, 0)).x;
  var r = ld(ta, c + vec2i(1, 0)).x;
  var t = ld(ta, c + vec2i(0, -1)).y;
  var b = ld(ta, c + vec2i(0, 1)).y;
  let me = ld(ta, c).xy;
  if (c.x == 0) { l = -me.x; }
  if (c.x == s.x - 1) { r = -me.x; }
  if (c.y == 0) { t = -me.y; }
  if (c.y == s.y - 1) { b = -me.y; }
  return vec4f(0.5 * ((r - l) + (b - t)), 0.0, 0.0, 1.0);
}

@fragment fn fs_jacobi(v: VOut) -> @location(0) vec4f {
  let c = cellOf(v.pos);
  let p = ld(ta, c + vec2i(-1, 0)).x + ld(ta, c + vec2i(1, 0)).x + ld(ta, c + vec2i(0, -1)).x + ld(ta, c + vec2i(0, 1)).x;
  return vec4f((p - ld(tb, c).x) * 0.25, 0.0, 0.0, 1.0);
}

@fragment fn fs_grad(v: VOut) -> @location(0) vec4f {
  let c = cellOf(v.pos);
  let g = 0.5 * vec2f(ld(tb, c + vec2i(1, 0)).x - ld(tb, c + vec2i(-1, 0)).x, ld(tb, c + vec2i(0, 1)).x - ld(tb, c + vec2i(0, -1)).x);
  return vec4f(ld(ta, c).xy - g, 0.0, 1.0);
}

@fragment fn fs_dye(v: VOut) -> @location(0) vec4f {
  let uv = v.uv;
  let pic = textureSampleLevel(tm, smp, uv, 0.0).rgb;
  if (u.init > 0.5) { return vec4f(pic, 1.0); }
  let vel = textureSampleLevel(tb, smp, uv, 0.0).xy;
  var d = textureSampleLevel(ta, smp, uv - u.dt * vel / u.size, 0.0).rgb * u.fade;
  // relax toward the picture: it re-forms (fast on the beat) wherever the flow lets it
  d = mix(d, pic, u.restore);
  return vec4f(max(d, vec3f(0.0)), 1.0);
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
  let n = max(i32(u.look2.x), 1);
  let f = clamp(x, 0.0, 1.0) * f32(n - 1);
  let i = min(i32(floor(f)), n - 1);
  let j = min(i + 1, n - 1);
  return lab2lin(mix(u.pal[i].xyz, u.pal[j].xyz, f - f32(i)));
}

@fragment fn fs_draw(v: VOut) -> @location(0) vec4f {
  let uv = v.uv;
  var col = textureSampleLevel(ta, smp, uv, 0.0).rgb;
  let lum = dot(col, vec3f(0.2126, 0.7152, 0.0722));
  col = max(mix(vec3f(lum), col, u.look.w), vec3f(0.0));
  // fast swirls catch the light in the palette: speed in screen heights per second
  let vel = textureSampleLevel(tb, smp, uv, 0.0).xy / u.size.y;
  let sp = length(vel);
  let x = fract(clamp(sp * 0.9, 0.0, 1.0) * 0.6 + 0.3 + u.look2.y);
  let tri = 1.0 - abs(x * 2.0 - 1.0);
  col += pal(0.35 + 0.65 * tri) * smoothstep(0.15, 1.4, sp) * u.look.z;
  col *= u.look.x * (1.0 + u.look.y);
  return vec4f(col, 1.0);
}
