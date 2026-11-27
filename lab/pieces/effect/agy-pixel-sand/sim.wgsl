// GPU Margolus 2x2 falling-sand pixel physics driven by input media & audio drops.
// Cell.state = (kind [0=empty, 1=pinned picture, 2=falling sand], age, trail, spark)
// Cell.color = (r, g, b, edgeMag)

struct Cell {
  state: vec4f,
  color: vec4f,
};

struct Sim {
  size: vec2u, floor_mode: u32, hash: u32,
  crumble: f32, erosion: f32, resurface: f32, edge_wall: f32,
  wind: f32, fluidity: f32, quake: f32, time: f32,
  has_luma: f32, has_edges: f32, beat: f32, kick: f32,
  bass: f32, highs: f32, rms: f32, wind_bias: f32,
  max_age: f32, _p0: f32, _p1: f32, _p2: f32,
};

@group(0) @binding(0) var<uniform> sim: Sim;
@group(0) @binding(1) var<storage, read_write> cells: array<Cell>;
@group(0) @binding(2) var smp: sampler;
@group(0) @binding(3) var tpic: texture_2d<f32>;
@group(0) @binding(4) var tluma: texture_2d<f32>;
@group(0) @binding(5) var tedges: texture_2d<f32>;

fn hashf(a: u32, b: u32) -> f32 {
  var x = (a * 0x9e3779b1u) ^ ((b + 0x7f4a7c15u) * 0x85ebca6bu);
  x ^= x >> 15u;
  x *= 0x2c1b3c6du;
  x ^= x >> 12u;
  x *= 0x297a2d39u;
  x ^= x >> 15u;
  return f32(x >> 8u) / 16777216.0;
}

fn vnoise(p: vec2f) -> f32 {
  let i = vec2i(floor(p));
  let f = fract(p);
  let u = f * f * (3.0 - 2.0 * f);
  let a = hashf(u32(i.x + 4096), u32(i.y + 4096));
  let b = hashf(u32(i.x + 4097), u32(i.y + 4096));
  let c = hashf(u32(i.x + 4096), u32(i.y + 4097));
  let d = hashf(u32(i.x + 4097), u32(i.y + 4097));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

fn luma_rgb(c: vec3f) -> f32 {
  return dot(c, vec3f(0.2126, 0.7152, 0.0722));
}

fn sample_luma(uv: vec2f, pic: vec3f) -> f32 {
  if (sim.has_luma > 0.5) {
    return clamp(textureSampleLevel(tluma, smp, uv, 0.0).r, 0.0, 1.5);
  }
  return clamp(luma_rgb(pic), 0.0, 1.5);
}

fn sample_edges(uv: vec2f) -> vec2f {
  if (sim.has_edges > 0.5) {
    return textureSampleLevel(tedges, smp, uv, 0.0).rg;
  }
  let texel = 1.5 / vec2f(sim.size);
  let l0 = luma_rgb(textureSampleLevel(tpic, smp, uv - vec2f(texel.x, 0.0), 0.0).rgb);
  let l1 = luma_rgb(textureSampleLevel(tpic, smp, uv + vec2f(texel.x, 0.0), 0.0).rgb);
  let l2 = luma_rgb(textureSampleLevel(tpic, smp, uv - vec2f(0.0, texel.y), 0.0).rgb);
  let l3 = luma_rgb(textureSampleLevel(tpic, smp, uv + vec2f(0.0, texel.y), 0.0).rgb);
  return vec2f(l1 - l0, l3 - l2) * 3.0;
}

fn idx_of(x: u32, y: u32) -> u32 {
  return y * sim.size.x + x;
}

// Initialize grid with the live picture pinned and ~22% already crumbling along seams so frame 1 moves.
@compute @workgroup_size(16, 16) fn cs_init(@builtin(global_invocation_id) g: vec3u) {
  if (g.x >= sim.size.x || g.y >= sim.size.y) { return; }
  let idx = idx_of(g.x, g.y);
  let uv = (vec2f(g.xy) + 0.5) / vec2f(sim.size);
  let pic = textureSampleLevel(tpic, smp, uv, 0.0).rgb;
  let lum = sample_luma(uv, pic);
  let emag = clamp(length(sample_edges(uv)), 0.0, 2.0);
  let patch = vnoise(uv * vec2f(10.0, 7.0) + vec2f(3.1, 1.7));
  let h = hashf(idx, sim.hash ^ 0x51a7u);
  let loose = (patch > 0.62 && uv.y < 0.78) || (h < 0.12 && lum < 0.55);
  let kind = select(1.0, 2.0, loose);
  cells[idx] = Cell(vec4f(kind, 0.0, 0.0, select(0.0, 0.5, loose)), vec4f(pic, emag));
}

// Per-frame media coupling: fracture pinned chunks on drops/beats, erode edges, drain floor, and resurface cavities.
@compute @workgroup_size(16, 16) fn cs_fracture(@builtin(global_invocation_id) g: vec3u) {
  if (g.x >= sim.size.x || g.y >= sim.size.y) { return; }
  let idx = idx_of(g.x, g.y);
  let uv = (vec2f(g.xy) + 0.5) / vec2f(sim.size);
  let pic = textureSampleLevel(tpic, smp, uv, 0.0).rgb;
  let lum = sample_luma(uv, pic);
  let emag = clamp(length(sample_edges(uv)), 0.0, 2.0);

  var c = cells[idx];
  let kind = c.state.x;
  let h = hashf(idx, sim.hash);
  let h2 = hashf(idx, sim.hash ^ 0x9e37u);

  // Rolling coarse fracture field so recognizable chunks of the image crumble together on drops
  let n1 = vnoise(uv * vec2f(9.0, 6.0) + vec2f(sim.time * 0.45, -sim.time * 0.35));
  let n2 = vnoise(uv * vec2f(22.0, 14.0) + vec2f(-sim.time * 0.8, sim.time * 0.6));
  let crack = n1 * 0.68 + n2 * 0.32;

  // Decay trail & spark
  c.state.z *= 0.88;
  c.state.w *= 0.82;

  if (kind > 0.5 && kind < 1.5) {
    // Pinned picture pixel: tracks live video directly
    c.color = vec4f(pic, emag);
    c.state.y = 0.0;

    // Strong media edges resist crumbling slightly so contours act as shelves catching sand from above
    let ledgeResist = clamp(emag * 0.55 * sim.edge_wall, 0.0, 0.48);
    // Drop/onset crumble wave + steady ambient erosion
    let burstZone = smoothstep(0.68 - sim.crumble * 0.42, 0.92 - sim.crumble * 0.36, crack + (1.0 - lum) * 0.14);
    let burstProb = clamp(burstZone * (0.04 + 0.32 * sim.crumble) * (1.0 - ledgeResist), 0.0, 0.62);
    let ambientProb = clamp(sim.erosion * 0.022 * (0.45 + 0.9 * crack) * (1.0 - ledgeResist * 0.7), 0.0, 0.06);

    if (h < burstProb + ambientProb) {
      // Break loose into a falling sand grain carrying this exact pixel colour!
      c.state = vec4f(2.0, 0.0, 0.35, clamp(0.45 + 0.65 * sim.kick + 0.3 * sim.bass, 0.0, 1.2));
      // Slight saturation lift so falling sand reads distinctly over the static picture
      let l = luma_rgb(pic);
      let grainCol = max(mix(vec3f(l), pic, 1.22), vec3f(0.0));
      c.color = vec4f(grainCol, emag);
    }
  } else if (kind >= 1.5) {
    // Loose falling sand grain
    c.state.y += 1.0;

    // Drain mode: spill off the bottom row cleanly like a pixel waterfall
    if (sim.floor_mode == 1u && g.y >= sim.size.y - 2u) {
      c.state = vec4f(0.0, 0.0, 0.75, 0.0);
    } else {
      // Pile/bounce mode: very bottom row slowly dissolves when old so piles never permanently freeze
      let atFloor = g.y >= sim.size.y - 3u;
      let old = c.state.y > sim.max_age;
      if (atFloor && old && h < 0.08 + 0.18 * sim.beat) {
        c.state = vec4f(0.0, 0.0, 0.4, 0.2);
      } else if (old && h < 0.015 * sim.resurface * (0.4 + 0.8 * sim.beat + 0.6 * lum)) {
        // Re-crystallize aged settled sand back into live video pixel
        c.state = vec4f(1.0, 0.0, 0.0, 0.35);
        c.color = vec4f(pic, emag);
      }
    }
  } else {
    // Empty void where pixels crumbled away: re-crystallize back into live picture, bright & edges first
    c.state.y += 1.0;
    let regrowWait = smoothstep(8.0, 42.0, c.state.y);
    let subjectBias = 0.35 + 0.85 * clamp(lum + emag * 0.75, 0.0, 1.3);
    let regrowProb = clamp(0.018 * sim.resurface * regrowWait * subjectBias * (0.5 + 1.1 * sim.beat), 0.0, 0.38);
    if (h2 < regrowProb && sim.kick < 0.72) {
      c.state = vec4f(1.0, 0.0, 0.0, 0.28 * sim.beat);
      c.color = vec4f(pic, emag);
    }
  }

  cells[idx] = c;
}

fn is_empty(c: Cell) -> bool { return c.state.x < 0.5; }
fn is_pinned(c: Cell) -> bool { return c.state.x >= 0.5 && c.state.x < 1.5; }
fn is_sand(c: Cell) -> bool { return c.state.x >= 1.5; }

// Race-free Margolus 2x2 falling-sand step with offset (ox, oy) in {0,1}x{0,1}.
fn step_margolus(gid: vec2u, ox: u32, oy: u32, upward: bool) {
  let x0 = gid.x * 2u + ox;
  let y0 = gid.y * 2u + oy;
  if (x0 + 1u >= sim.size.x || y0 + 1u >= sim.size.y) { return; }

  let iTL = idx_of(x0, y0);
  let iTR = idx_of(x0 + 1u, y0);
  let iBL = idx_of(x0, y0 + 1u);
  let iBR = idx_of(x0 + 1u, y0 + 1u);

  var tl = cells[iTL];
  var tr = cells[iTR];
  var bl = cells[iBL];
  var br = cells[iBR];

  let uv = (vec2f(f32(x0) + 1.0, f32(y0) + 1.0)) / vec2f(sim.size);
  let evec = sample_edges(uv);
  let h = hashf(iTL, sim.hash ^ (ox * 7919u + oy * 3571u + select(0u, 991u, upward)));

  if (upward) {
    // Bass quake: launch loose sand upward into empty cells above
    if (is_sand(bl) && is_empty(tl) && h < 0.5 + 0.45 * sim.quake) {
      let tmp = tl;
      tl = bl;
      tl.state.w = max(tl.state.w, 0.55);
      bl = Cell(vec4f(0.0, tmp.state.y, max(tmp.state.z, 0.75), 0.0), tl.color);
    }
    if (is_sand(br) && is_empty(tr) && h > 0.15) {
      let tmp = tr;
      tr = br;
      tr.state.w = max(tr.state.w, 0.55);
      br = Cell(vec4f(0.0, tmp.state.y, max(tmp.state.z, 0.75), 0.0), tr.color);
    }
    cells[iTL] = tl; cells[iTR] = tr; cells[iBL] = bl; cells[iBR] = br;
    return;
  }

  var moved = false;

  // 1. Straight downward gravity fall (leaving a glowing trail in the vacated cell)
  if (is_sand(tl) && is_empty(bl)) {
    let oldEmpty = bl;
    bl = tl;
    tl = Cell(vec4f(0.0, oldEmpty.state.y, max(oldEmpty.state.z, 0.85), 0.0), bl.color);
    moved = true;
  }
  if (is_sand(tr) && is_empty(br)) {
    let oldEmpty = br;
    br = tr;
    tr = Cell(vec4f(0.0, oldEmpty.state.y, max(oldEmpty.state.z, 0.85), 0.0), br.color);
    moved = true;
  }

  // 2. Diagonal 45-degree avalanche slide into dunes when blocked below
  if (!moved) {
    let canLeft = is_sand(tr) && !is_empty(br) && is_empty(bl) && !is_pinned(tl);
    let canRight = is_sand(tl) && !is_empty(bl) && is_empty(br) && !is_pinned(tr);
    if (canLeft && canRight) {
      if (h < 0.5) {
        let oldEmpty = bl;
        bl = tr;
        tr = Cell(vec4f(0.0, oldEmpty.state.y, max(oldEmpty.state.z, 0.75), 0.0), bl.color);
      } else {
        let oldEmpty = br;
        br = tl;
        tl = Cell(vec4f(0.0, oldEmpty.state.y, max(oldEmpty.state.z, 0.75), 0.0), br.color);
      }
      moved = true;
    } else if (canLeft) {
      let oldEmpty = bl;
      bl = tr;
      tr = Cell(vec4f(0.0, oldEmpty.state.y, max(oldEmpty.state.z, 0.75), 0.0), bl.color);
      moved = true;
    } else if (canRight) {
      let oldEmpty = br;
      br = tl;
      tl = Cell(vec4f(0.0, oldEmpty.state.y, max(oldEmpty.state.z, 0.75), 0.0), br.color);
      moved = true;
    }
  }

  // 3. Lateral edge-wind & granular fluidity spread
  let windForce = clamp(evec.x * sim.wind + sim.wind_bias * sim.wind * 0.45, -1.5, 1.5);
  let spreadProb = clamp(sim.fluidity * 0.55 + abs(windForce) * 0.35, 0.0, 0.85);
  if (h < spreadProb) {
    let goRight = select(h < spreadProb * 0.5, windForce > 0.0, abs(windForce) > 0.12);
    if (goRight && is_sand(bl) && is_empty(br)) {
      let oldEmpty = br;
      br = bl;
      bl = Cell(vec4f(0.0, oldEmpty.state.y, max(oldEmpty.state.z, 0.55), 0.0), br.color);
    } else if (!goRight && is_sand(br) && is_empty(bl)) {
      let oldEmpty = bl;
      bl = br;
      br = Cell(vec4f(0.0, oldEmpty.state.y, max(oldEmpty.state.z, 0.55), 0.0), bl.color);
    }
  }

  cells[iTL] = tl;
  cells[iTR] = tr;
  cells[iBL] = bl;
  cells[iBR] = br;
}

@compute @workgroup_size(16, 16) fn cs_fall_0(@builtin(global_invocation_id) g: vec3u) { step_margolus(g.xy, 0u, 0u, false); }
@compute @workgroup_size(16, 16) fn cs_fall_1(@builtin(global_invocation_id) g: vec3u) { step_margolus(g.xy, 1u, 0u, false); }
@compute @workgroup_size(16, 16) fn cs_fall_2(@builtin(global_invocation_id) g: vec3u) { step_margolus(g.xy, 0u, 1u, false); }
@compute @workgroup_size(16, 16) fn cs_fall_3(@builtin(global_invocation_id) g: vec3u) { step_margolus(g.xy, 1u, 1u, false); }

@compute @workgroup_size(16, 16) fn cs_quake_0(@builtin(global_invocation_id) g: vec3u) { step_margolus(g.xy, 0u, 0u, true); }
@compute @workgroup_size(16, 16) fn cs_quake_1(@builtin(global_invocation_id) g: vec3u) { step_margolus(g.xy, 1u, 1u, true); }
