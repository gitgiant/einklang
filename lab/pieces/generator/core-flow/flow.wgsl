// Fixed-point curl-noise flow field. Mirrors core/scenes/flow.ts exactly: i32/u32 only, every
// add/multiply wraps, every >> on i32 is arithmetic, so all GPUs produce identical particles.

struct Step { tick: i32, seed: i32, speedK: i32, push: i32, cx: i32, cy: i32, n: u32, _p: u32 };
@group(0) @binding(0) var<uniform> u: Step;
@group(0) @binding(1) var<storage, read_write> P: array<vec4i>;
@group(0) @binding(2) var<storage, read_write> hashOut: atomic<u32>;

const FX: u32 = 16u;
const WF: i32 = 1280 << 16u;
const HF: i32 = 720 << 16u;
const H_OFF: i32 = 8 << 16u;
const VMAX: i32 = 24 << 16u;

fn fade(t: i32) -> i32 { return (t * t * (768 - 2 * t)) >> 16u; }
fn lerpi(a: i32, b: i32, t: i32) -> i32 { return a + (((b - a) * t) >> 8u); }
fn lat(ix: i32, iy: i32, layer: i32) -> i32 {
  let k = (bitcast<u32>(ix) * 73856093u) ^ (bitcast<u32>(iy) * 19349663u);
  return i32(h32(k, bitcast<u32>(layer)) & 0xffffu) - 32768;
}
fn pot(x: i32, y: i32, layer: i32) -> i32 {
  let ix = x >> 23u;
  let iy = y >> 23u;
  let sx = fade((x >> 15u) & 255);
  let sy = fade((y >> 15u) & 255);
  let a = lerpi(lat(ix, iy, layer), lat(ix + 1, iy, layer), sx);
  let b = lerpi(lat(ix, iy + 1, layer), lat(ix + 1, iy + 1, layer), sx);
  return lerpi(a, b, sy);
}
fn psi(x: i32, y: i32) -> i32 {
  let layer = (u.tick >> 8u) + u.seed;
  return lerpi(pot(x, y, layer), pot(x, y, layer + 1), fade(u.tick & 255));
}

@compute @workgroup_size(256) fn cs_step(@builtin(global_invocation_id) id: vec3u) {
  let i = id.x;
  if (i >= u.n) { return; }
  var q = P[i];
  let dy = psi(q.x, q.y + H_OFF) - psi(q.x, q.y - H_OFF);
  let dx = psi(q.x + H_OFF, q.y) - psi(q.x - H_OFF, q.y);
  q.z += (dy * u.speedK - q.z) >> 3u;
  q.w += (-dx * u.speedK - q.w) >> 3u;
  if (u.push > 0) {
    q.z -= ((q.y >> FX) - u.cy) * u.push * 4; // onset swirl
    q.w += ((q.x >> FX) - u.cx) * u.push * 4;
  }
  q.z = clamp(q.z, -VMAX, VMAX);
  q.w = clamp(q.w, -VMAX, VMAX);
  q.x += q.z;
  q.y += q.w;
  if (q.x < 0) { q.x += WF; } else if (q.x >= WF) { q.x -= WF; }
  if (q.y < 0) { q.y += HF; } else if (q.y >= HF) { q.y -= HF; }
  P[i] = q;
}

@compute @workgroup_size(256) fn cs_seed(@builtin(global_invocation_id) id: vec3u) {
  let i = id.x;
  if (i >= u.n) { return; }
  let s = bitcast<u32>(u.seed);
  P[i] = vec4i(i32(h32(s, i * 2u) % u32(WF)), i32(h32(s, i * 2u + 1u) % u32(HF)), 0, 0);
}

@compute @workgroup_size(256) fn cs_hash(@builtin(global_invocation_id) id: vec3u) {
  let i = id.x;
  if (i >= u.n) { return; }
  let q = P[i];
  let h = h32(h32(bitcast<u32>(i32(i) ^ q.x), bitcast<u32>(q.y)), bitcast<u32>(q.z ^ (q.w * 31)));
  atomicAdd(&hashOut, h);
}
