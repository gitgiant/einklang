// Stable fluids (Stam) whose dye is the picture: rgb = the media's colour carried by the flow,
// w = smear (how much the paint here has been moved; 0 = the picture as it is). Grid y down.
// Velocity in cells per second. Closed box (walls on all four sides).
// Forces: vorticity confinement, a flow along the picture's luma contours (rot90 of the luma
// gradient: divergence-free, it circles round bright shapes), buoyancy of bright paint, a few
// orbiting stirrers. Every step the dye relaxes back toward the picture at `restore`, so the
// image re-forms when the music lets go. Per step: cs_curl, cs_force, cs_advect, cs_div,
// cs_jacobi x N, cs_grad, cs_copy. cs_puff: an onset puff in place. cs_init: dye = picture.

struct Sim {
  size: vec2u, has_luma: u32, nstir: u32,
  dt: f32, vdiss: f32, restore: f32, smear: f32,
  vort: f32, swirl: f32, buoy: f32, _a: f32,
  puff_c: vec2f, puff_r: f32, puff_f: f32,
  puff_col: vec3f, puff_twist: f32,
  puff_d: f32, _b: f32, _c: f32, _d: f32,
  stir: array<vec4f, 4>, // x, y (cells), radius (cells), tangential force (cells/s^2, signed)
};
@group(0) @binding(0) var<uniform> sim: Sim;
@group(0) @binding(1) var<storage, read> vin: array<vec2f>;
@group(0) @binding(2) var<storage, read_write> vout: array<vec2f>;
@group(0) @binding(3) var<storage, read> din: array<vec4f>;
@group(0) @binding(4) var<storage, read_write> dout: array<vec4f>;
@group(0) @binding(5) var<storage, read> pin: array<f32>;
@group(0) @binding(6) var<storage, read_write> pout: array<f32>;
@group(0) @binding(7) var<storage, read_write> aux: array<vec2f>; // divergence, curl
@group(0) @binding(8) var smp: sampler;
@group(0) @binding(9) var media: texture_2d<f32>;
@group(0) @binding(10) var lumat: texture_2d<f32>;

const LW: vec3f = vec3f(0.2126, 0.7152, 0.0722);

fn ix(x: i32, y: i32) -> u32 {
  let w = i32(sim.size.x);
  let h = i32(sim.size.y);
  return u32(clamp(y, 0, h - 1) * w + clamp(x, 0, w - 1));
}

fn inside(g: vec3u) -> bool { return g.x < sim.size.x && g.y < sim.size.y; }

fn uv_of(p: vec2f) -> vec2f { return p / vec2f(sim.size); }

fn pic(uv: vec2f) -> vec3f { return max(textureSampleLevel(media, smp, uv, 0.0).rgb, vec3f(0.0)); }

fn luma(uv: vec2f) -> f32 {
  if (sim.has_luma == 1u) { return textureSampleLevel(lumat, smp, uv, 0.0).r; }
  return dot(pic(uv), LW);
}

fn samp_v(q: vec2f) -> vec2f {
  let p = clamp(q - 0.5, vec2f(0.0), vec2f(sim.size) - 1.0);
  let i = vec2i(floor(p));
  let f = p - floor(p);
  return mix(mix(vin[ix(i.x, i.y)], vin[ix(i.x + 1, i.y)], f.x), mix(vin[ix(i.x, i.y + 1)], vin[ix(i.x + 1, i.y + 1)], f.x), f.y);
}

fn samp_d(q: vec2f) -> vec4f {
  let p = clamp(q - 0.5, vec2f(0.0), vec2f(sim.size) - 1.0);
  let i = vec2i(floor(p));
  let f = p - floor(p);
  return mix(mix(din[ix(i.x, i.y)], din[ix(i.x + 1, i.y)], f.x), mix(din[ix(i.x, i.y + 1)], din[ix(i.x + 1, i.y + 1)], f.x), f.y);
}

// Neumann pressure on every wall: mirror the cell
fn pr(x: i32, y: i32, self_p: f32) -> f32 {
  if (x < 0 || y < 0 || x >= i32(sim.size.x) || y >= i32(sim.size.y)) { return self_p; }
  return pin[ix(x, y)];
}

@compute @workgroup_size(16, 16) fn cs_init(@builtin(global_invocation_id) g: vec3u) {
  if (!inside(g)) { return; }
  dout[ix(i32(g.x), i32(g.y))] = vec4f(pic(uv_of(vec2f(g.xy) + 0.5)), 0.0);
}

@compute @workgroup_size(16, 16) fn cs_curl(@builtin(global_invocation_id) g: vec3u) {
  if (!inside(g)) { return; }
  let x = i32(g.x);
  let y = i32(g.y);
  let c = 0.5 * ((vin[ix(x + 1, y)].y - vin[ix(x - 1, y)].y) - (vin[ix(x, y + 1)].x - vin[ix(x, y - 1)].x));
  let i = ix(x, y);
  aux[i] = vec2f(aux[i].x, c);
}

@compute @workgroup_size(16, 16) fn cs_force(@builtin(global_invocation_id) g: vec3u) {
  if (!inside(g)) { return; }
  let x = i32(g.x);
  let y = i32(g.y);
  let i = ix(x, y);
  var v = vin[i];
  var d = din[i];
  let p = vec2f(f32(x), f32(y)) + 0.5;
  let uv = uv_of(p);
  var f = vec2f(0.0);
  // vorticity confinement keeps the small eddies alive
  let c = aux[i].y;
  let gr = 0.5 * vec2f(abs(aux[ix(x + 1, y)].y) - abs(aux[ix(x - 1, y)].y), abs(aux[ix(x, y + 1)].y) - abs(aux[ix(x, y - 1)].y));
  let gl = length(gr);
  if (gl > 1e-5) {
    let n = gr / gl;
    f += sim.vort * vec2f(n.y * c, -n.x * c);
  }
  // luma gradient over two cells, per uv unit: the paint circles along the picture's contours
  let e = 2.0 / vec2f(sim.size);
  let lg = vec2f(luma(uv + vec2f(e.x, 0.0)) - luma(uv - vec2f(e.x, 0.0)), luma(uv + vec2f(0.0, e.y)) - luma(uv - vec2f(0.0, e.y))) / (2.0 * e);
  f += sim.swirl * vec2f(-lg.y, lg.x) / (1.0 + 0.15 * length(lg));
  // bright paint rises (row 0 is the top)
  f.y -= sim.buoy * (dot(d.rgb, LW) - 0.3);
  for (var k = 0u; k < sim.nstir; k++) {
    let s = sim.stir[k];
    let r = p - s.xy;
    let q = r / max(s.z, 1.0);
    f += s.w * vec2f(-q.y, q.x) * exp(-dot(q, q));
  }
  // the picture pulls the paint back home; the smear marker relaxes with it
  let back = clamp(sim.restore * sim.dt, 0.0, 1.0);
  let home = pic(uv);
  d = vec4f(mix(d.rgb, home, back), d.w * (1.0 - back));
  vout[i] = v + f * sim.dt;
  dout[i] = d;
}

@compute @workgroup_size(16, 16) fn cs_puff(@builtin(global_invocation_id) g: vec3u) {
  if (!inside(g)) { return; }
  let i = ix(i32(g.x), i32(g.y));
  let p = vec2f(g.xy) + 0.5;
  let r = p - sim.puff_c;
  let q = r / max(sim.puff_r, 1.0);
  let w = exp(-dot(q, q));
  let l = length(r);
  if (l > 1e-4) {
    let dir = r / l;
    let ring = l / max(sim.puff_r, 1.0) * w;
    vout[i] += (dir + vec2f(-dir.y, dir.x) * sim.puff_twist) * sim.puff_f * ring;
  }
  // in place (run with the group whose outputs are the live grids)
  let d = dout[i];
  dout[i] = vec4f(d.rgb + sim.puff_col * sim.puff_d * w, max(d.w, w));
}

@compute @workgroup_size(16, 16) fn cs_advect(@builtin(global_invocation_id) g: vec3u) {
  if (!inside(g)) { return; }
  let x = i32(g.x);
  let y = i32(g.y);
  let i = ix(x, y);
  let p = vec2f(f32(x), f32(y)) + 0.5;
  let back = p - sim.dt * vin[i];
  var v = samp_v(back) * sim.vdiss;
  if (x == 0 || x == i32(sim.size.x) - 1) { v.x = 0.0; }
  if (y == 0 || y == i32(sim.size.y) - 1) { v.y = 0.0; }
  let sp = length(v);
  let cap = f32(sim.size.y) * 2.0;
  if (sp > cap) { v *= cap / sp; }
  vout[i] = v;
  var d = samp_d(back);
  // moved paint is marked as smeared, in proportion to how far it travelled this step
  d.w = clamp(d.w + sp * sim.dt * sim.smear / f32(sim.size.y), 0.0, 1.0);
  dout[i] = vec4f(min(d.rgb, vec3f(8.0)), d.w);
}

@compute @workgroup_size(16, 16) fn cs_div(@builtin(global_invocation_id) g: vec3u) {
  if (!inside(g)) { return; }
  let x = i32(g.x);
  let y = i32(g.y);
  let w = i32(sim.size.x);
  let h = i32(sim.size.y);
  let c = vin[ix(x, y)];
  var l = vin[ix(x - 1, y)].x;
  var r = vin[ix(x + 1, y)].x;
  var b = vin[ix(x, y + 1)].y;
  var t = vin[ix(x, y - 1)].y;
  if (x == 0) { l = -c.x; }
  if (x == w - 1) { r = -c.x; }
  if (y == h - 1) { b = -c.y; }
  if (y == 0) { t = -c.y; }
  let i = ix(x, y);
  aux[i] = vec2f(0.5 * ((r - l) + (b - t)), aux[i].y);
}

@compute @workgroup_size(16, 16) fn cs_jacobi(@builtin(global_invocation_id) g: vec3u) {
  if (!inside(g)) { return; }
  let x = i32(g.x);
  let y = i32(g.y);
  let i = ix(x, y);
  let pc = pin[i];
  pout[i] = 0.25 * (pr(x - 1, y, pc) + pr(x + 1, y, pc) + pr(x, y - 1, pc) + pr(x, y + 1, pc) - aux[i].x);
}

@compute @workgroup_size(16, 16) fn cs_grad(@builtin(global_invocation_id) g: vec3u) {
  if (!inside(g)) { return; }
  let x = i32(g.x);
  let y = i32(g.y);
  let i = ix(x, y);
  let pc = pin[i];
  let gp = 0.5 * vec2f(pr(x + 1, y, pc) - pr(x - 1, y, pc), pr(x, y + 1, pc) - pr(x, y - 1, pc));
  vout[i] = vin[i] - gp;
}

@compute @workgroup_size(16, 16) fn cs_copy(@builtin(global_invocation_id) g: vec3u) {
  if (!inside(g)) { return; }
  let i = ix(i32(g.x), i32(g.y));
  vout[i] = vin[i];
}
