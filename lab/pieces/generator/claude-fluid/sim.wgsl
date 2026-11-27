// Stable fluids (Stam) on a cell grid, y down (row 0 = top). Velocity in cells per second.
// Dye: vec2f(density, density * tag): the tag (palette position) is carried mass-weighted.
// Per step: cs_curl, cs_force (vorticity confinement, buoyancy, the nozzles), cs_advect
// (semi-Lagrangian, velocity and dye), cs_div, cs_jacobi x N (pressure), cs_grad, cs_copy.
// cs_puff adds an onset puff in place. Walls on the sides and the bottom; the top is open
// (pressure 0 above it), so the smoke can leave.

struct Sim {
  size: vec2u, nsrc: u32, _u: u32,
  dt: f32, vdiss: f32, ddiss: f32, buoy: f32,
  vort: f32, puff_r: f32, puff_f: f32, puff_d: f32,
  puff_c: vec2f, puff_tag: f32, swirl: f32,
  src: array<vec4f, 4>, // x, y (cells), radius (cells), dye per second
  dir: array<vec4f, 4>, // force x, y (cells/s^2), tag, _
};
@group(0) @binding(0) var<uniform> sim: Sim;
@group(0) @binding(1) var<storage, read> vin: array<vec2f>;
@group(0) @binding(2) var<storage, read_write> vout: array<vec2f>;
@group(0) @binding(3) var<storage, read> din: array<vec2f>;
@group(0) @binding(4) var<storage, read_write> dout: array<vec2f>;
@group(0) @binding(5) var<storage, read> pin: array<f32>;
@group(0) @binding(6) var<storage, read_write> pout: array<f32>;
@group(0) @binding(7) var<storage, read_write> aux: array<vec2f>; // divergence, curl

fn ix(x: i32, y: i32) -> u32 {
  let w = i32(sim.size.x);
  let h = i32(sim.size.y);
  return u32(clamp(y, 0, h - 1) * w + clamp(x, 0, w - 1));
}

fn inside(g: vec3u) -> bool { return g.x < sim.size.x && g.y < sim.size.y; }

fn samp_v(q: vec2f) -> vec2f {
  let p = clamp(q - 0.5, vec2f(0.0), vec2f(sim.size) - 1.0);
  let i = vec2i(floor(p));
  let f = p - floor(p);
  return mix(mix(vin[ix(i.x, i.y)], vin[ix(i.x + 1, i.y)], f.x), mix(vin[ix(i.x, i.y + 1)], vin[ix(i.x + 1, i.y + 1)], f.x), f.y);
}

fn samp_d(q: vec2f) -> vec2f {
  let p = clamp(q - 0.5, vec2f(0.0), vec2f(sim.size) - 1.0);
  let i = vec2i(floor(p));
  let f = p - floor(p);
  return mix(mix(din[ix(i.x, i.y)], din[ix(i.x + 1, i.y)], f.x), mix(din[ix(i.x, i.y + 1)], din[ix(i.x + 1, i.y + 1)], f.x), f.y);
}

// pressure with the boundary rules: Neumann on walls (mirror the cell), Dirichlet 0 above the top
fn pr(x: i32, y: i32, self_p: f32) -> f32 {
  if (y < 0) { return 0.0; }
  if (x < 0 || x >= i32(sim.size.x) || y >= i32(sim.size.y)) { return self_p; }
  return pin[ix(x, y)];
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
  // vorticity confinement: push along the curl gradient, keeps the small eddies alive
  let c = aux[i].y;
  let gr = 0.5 * vec2f(abs(aux[ix(x + 1, y)].y) - abs(aux[ix(x - 1, y)].y), abs(aux[ix(x, y + 1)].y) - abs(aux[ix(x, y - 1)].y));
  let gl = length(gr);
  var f = vec2f(0.0);
  if (gl > 1e-5) {
    let n = gr / gl;
    f += sim.vort * vec2f(n.y * c, -n.x * c);
  }
  // buoyancy: thick smoke rises (row 0 is the top)
  f.y -= sim.buoy * min(d.x, 3.0);
  for (var k = 0u; k < sim.nsrc; k++) {
    let s = sim.src[k];
    let q = (p - s.xy) / max(s.z, 0.5);
    let w = exp(-dot(q, q));
    f += sim.dir[k].xy * w;
    let a = s.w * w * sim.dt;
    d += vec2f(a, a * sim.dir[k].z);
  }
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
    // outward shove that peaks on the ring at puff_r, plus a twist
    let ring = l / max(sim.puff_r, 1.0) * w;
    vout[i] += (dir + vec2f(-dir.y, dir.x) * sim.swirl) * sim.puff_f * ring;
  }
  let a = sim.puff_d * w;
  dout[i] += vec2f(a, a * sim.puff_tag);
}

@compute @workgroup_size(16, 16) fn cs_advect(@builtin(global_invocation_id) g: vec3u) {
  if (!inside(g)) { return; }
  let x = i32(g.x);
  let y = i32(g.y);
  let i = ix(x, y);
  let p = vec2f(f32(x), f32(y)) + 0.5;
  let back = p - sim.dt * vin[i];
  var v = samp_v(back) * sim.vdiss;
  // walls: no flow through the sides or the floor
  if (x == 0 || x == i32(sim.size.x) - 1) { v.x = 0.0; }
  if (y == i32(sim.size.y) - 1) { v.y = min(v.y, 0.0); }
  // keep it finite whatever happens upstream
  let sp = length(v);
  let cap = f32(sim.size.y) * 3.0;
  if (sp > cap) { v *= cap / sp; }
  vout[i] = v;
  // dye thins out toward the top edge, where it leaves the frame
  let top = smoothstep(0.0, 0.06, p.y / f32(sim.size.y));
  dout[i] = samp_d(back) * sim.ddiss * mix(0.97, 1.0, top);
}

@compute @workgroup_size(16, 16) fn cs_div(@builtin(global_invocation_id) g: vec3u) {
  if (!inside(g)) { return; }
  let x = i32(g.x);
  let y = i32(g.y);
  let w = i32(sim.size.x);
  let h = i32(sim.size.y);
  // walls reflect the normal component
  var l = vin[ix(x - 1, y)].x;
  var r = vin[ix(x + 1, y)].x;
  var b = vin[ix(x, y + 1)].y;
  let t = vin[ix(x, y - 1)].y;
  let c = vin[ix(x, y)];
  if (x == 0) { l = -c.x; }
  if (x == w - 1) { r = -c.x; }
  if (y == h - 1) { b = -c.y; }
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
