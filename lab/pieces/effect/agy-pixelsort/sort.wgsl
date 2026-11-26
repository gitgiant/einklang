// GPU segmented bitonic pixel sort in 256-pixel strips along rows or columns.
// Finds contiguous runs where normalized luma is in [lo_thresh, hi_thresh],
// subdivides runs to max_run, and sorts pixels within each run by brightness.

struct SortU {
  dims: vec2u,
  axis: u32,         // 0 = rows (x), 1 = columns (y)
  reverse: u32,      // 0 = ascending, 1 = descending
  lo_thresh: f32,
  hi_thresh: f32,
  max_run: u32,
  stagger_seed: u32,
};

@group(0) @binding(0) var<uniform> u: SortU;
@group(0) @binding(1) var tex_in: texture_2d<f32>;
@group(0) @binding(2) var tex_out: texture_storage_2d<rgba16float, write>;

var<workgroup> s_col: array<vec4f, 256>;
var<workgroup> s_rid: array<u32, 256>;
var<workgroup> s_key: array<f32, 256>;

fn hash_u32(x: u32) -> u32 {
  var v = x * 747796405u + 2891336453u;
  v = ((v >> ((v >> 28u) + 4u)) ^ v) * 277803737u;
  return (v >> 22u) ^ v;
}

@compute @workgroup_size(256, 1, 1)
fn cs_sort(
  @builtin(local_invocation_id) lid_v: vec3u,
  @builtin(workgroup_id) wg: vec3u,
) {
  let lid = lid_v.x;
  let line_id = wg.y;
  let line_limit = select(u.dims.y, u.dims.x, u.axis == 1u);
  if (line_id >= line_limit) {
    return;
  }

  let axis_len = select(u.dims.x, u.dims.y, u.axis == 1u);
  // Stagger strip start per row/column to avoid visible 256px boundary seams
  let stagger = hash_u32(line_id ^ u.stagger_seed) & 127u;
  let pos = i32(wg.x * 256u + lid) - i32(stagger);
  let in_bounds = pos >= 0 && pos < i32(axis_len);

  var col = vec4f(0.0, 0.0, 0.0, 1.0);
  var active = false;
  var luma = 0.0;

  if (in_bounds) {
    let coord = select(vec2i(pos, i32(line_id)), vec2i(i32(line_id), pos), u.axis == 1u);
    col = textureLoad(tex_in, coord, 0);
    let safe_rgb = max(col.rgb, vec3f(0.0));
    luma = dot(safe_rgb, vec3f(0.2126, 0.7152, 0.0722));
    let norm_luma = luma / (0.65 + luma);
    active = norm_luma >= u.lo_thresh && norm_luma <= u.hi_thresh;
  }

  s_col[lid] = col;
  s_key[lid] = select(luma, -luma, u.reverse == 1u);
  // Inactive pixels act as barriers with value lid + 1; active pixels start at 0
  s_rid[lid] = select(lid + 1u, 0u, active);
  workgroupBarrier();

  // Hillis-Steele inclusive prefix-max: every active run gets the index+1 of its preceding barrier
  for (var step = 1u; step < 256u; step <<= 1u) {
    var v = s_rid[lid];
    if (lid >= step) {
      v = max(v, s_rid[lid - step]);
    }
    workgroupBarrier();
    s_rid[lid] = v;
    workgroupBarrier();
  }

  // Assign monotonically non-decreasing run_id:
  // - inactive pixels get a unique run_id = (lid + 1) << 9 so they stay pinned in place
  // - active runs are subdivided into sub-runs of length <= max_run
  let run_start = s_rid[lid];
  let max_r = max(u.max_run, 1u);
  var final_rid = run_start << 9u;
  if (active) {
    let sub = (lid - run_start) / max_r;
    final_rid = (run_start << 9u) | (1u + sub);
  }
  s_rid[lid] = final_rid;
  workgroupBarrier();

  // 256-element bitonic sort on lexicographical (run_id, sort_key)
  for (var k = 2u; k <= 256u; k <<= 1u) {
    for (var j = k >> 1u; j > 0u; j >>= 1u) {
      let ixj = lid ^ j;
      if (ixj > lid) {
        let asc = (lid & k) == 0u;
        let ra = s_rid[lid];
        let rb = s_rid[ixj];
        let ka = s_key[lid];
        let kb = s_key[ixj];
        let a_gt_b = (ra > rb) || (ra == rb && ka > kb);
        let a_lt_b = (ra < rb) || (ra == rb && ka < kb);
        if (select(a_lt_b, a_gt_b, asc)) {
          s_rid[lid] = rb;
          s_rid[ixj] = ra;
          s_key[lid] = kb;
          s_key[ixj] = ka;
          let ca = s_col[lid];
          s_col[lid] = s_col[ixj];
          s_col[ixj] = ca;
        }
      }
      workgroupBarrier();
    }
  }

  if (in_bounds) {
    let coord = select(vec2i(pos, i32(line_id)), vec2i(i32(line_id), pos), u.axis == 1u);
    textureStore(tex_out, coord, s_col[lid]);
  }
}
