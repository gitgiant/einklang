// Media-driven cellular automata (Life & Lenia) with inherited video colour per cell.
// Cell = { state: vec4f(alive, age, afterglow, flash), color: vec4f(r, g, b, edge) }.

struct Cell {
  state: vec4f,
  color: vec4f,
};

struct Sim {
  size: vec2u, nseed: u32, taps: u32,
  birth: u32, survive: u32, hash: u32, switched: u32,
  mu: f32, sigma: f32, dt: f32, decay: f32,
  edge_seed: f32, luma_seed: f32, media_pull: f32, lenia: f32,
  want: f32, feedback: f32, has_luma: f32, has_edges: f32,
  zoom: f32, edge_flow: f32, beat: f32, kick: f32,
  color_track: f32, highs: f32, _p0: f32, _p1: f32,
  seeds: array<vec4f, 8>,
};

@group(0) @binding(0) var<uniform> sim: Sim;
@group(0) @binding(1) var<storage, read> src: array<Cell>;
@group(0) @binding(2) var<storage, read_write> dst: array<Cell>;
@group(0) @binding(3) var<storage, read> kern: array<vec4f>;
@group(0) @binding(4) var<storage, read_write> mass: array<atomic<u32>, 4>;
@group(0) @binding(5) var smp: sampler;
@group(0) @binding(6) var tpic: texture_2d<f32>;
@group(0) @binding(7) var tluma: texture_2d<f32>;
@group(0) @binding(8) var tedges: texture_2d<f32>;

var<workgroup> wg_mass: atomic<u32>;

fn wrap_idx(x: i32, y: i32) -> u32 {
  let w = i32(sim.size.x);
  let h = i32(sim.size.y);
  return u32(((y % h + h) % h) * w + ((x % w + w) % w));
}

fn hashf(a: u32, b: u32) -> f32 {
  var x = (a * 0x9e3779b1u) ^ ((b + 0x7f4a7c15u) * 0x85ebca6bu);
  x ^= x >> 15u;
  x *= 0x2c1b3c6du;
  x ^= x >> 12u;
  x *= 0x297a2d39u;
  x ^= x >> 15u;
  return f32(x >> 8u) / 16777216.0;
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

fn boost_pic(pic: vec3f) -> vec3f {
  let l = luma_rgb(pic);
  let sat = max(mix(vec3f(l), pic, 1.35), vec3f(0.0));
  return sat + vec3f(0.03);
}

fn bilinear_cell(q: vec2f) -> Cell {
  let p = q - 0.5;
  let i = vec2i(floor(p));
  let f = p - floor(p);
  let c00 = src[wrap_idx(i.x, i.y)];
  let c10 = src[wrap_idx(i.x + 1, i.y)];
  let c01 = src[wrap_idx(i.x, i.y + 1)];
  let c11 = src[wrap_idx(i.x + 1, i.y + 1)];
  var out: Cell;
  out.state = mix(mix(c00.state, c10.state, f.x), mix(c01.state, c11.state, f.x), f.y);
  out.color = mix(mix(c00.color, c10.color, f.x), mix(c01.color, c11.color, f.x), f.y);
  return out;
}

// Initial board seeded directly from the input picture so frame 1 is already rich and media-shaped.
@compute @workgroup_size(16, 16) fn cs_init(@builtin(global_invocation_id) g: vec3u) {
  if (g.x >= sim.size.x || g.y >= sim.size.y) { return; }
  let idx = g.y * sim.size.x + g.x;
  let uv = (vec2f(g.xy) + 0.5) / vec2f(sim.size);
  let pic = boost_pic(textureSampleLevel(tpic, smp, uv, 0.0).rgb);
  let lum = sample_luma(uv, pic);
  let emag = clamp(length(sample_edges(uv)), 0.0, 2.0);
  let h = hashf(idx, sim.hash ^ 0x1337u);
  var alive = 0.0;
  if (sim.lenia > 0.5) {
    let prob = clamp(0.18 + lum * 0.45 + emag * 0.5, 0.0, 0.95);
    alive = select(0.0, clamp(0.45 + 0.55 * h, 0.0, 1.0), h < prob);
  } else {
    let prob = clamp(0.14 + lum * 0.28 + emag * 0.55, 0.0, 0.85);
    alive = select(0.0, 1.0, h < prob);
  }
  dst[idx] = Cell(vec4f(alive, 0.0, alive * 0.8, alive * 0.4), vec4f(pic, emag));
}

// Per-frame media seeding, contour advection (Lenia), onset disc bursts, and live video colour tracking.
@compute @workgroup_size(16, 16) fn cs_seed(@builtin(global_invocation_id) g: vec3u) {
  if (g.x >= sim.size.x || g.y >= sim.size.y) { return; }
  let idx = g.y * sim.size.x + g.x;
  let p = vec2f(g.xy) + 0.5;
  let uv = p / vec2f(sim.size);
  let pic = boost_pic(textureSampleLevel(tpic, smp, uv, 0.0).rgb);
  let lum = sample_luma(uv, pic);
  let evec = sample_edges(uv);
  let emag = clamp(length(evec), 0.0, 2.0);

  var c = src[idx];
  if (sim.lenia > 0.5) {
    // Advect Lenia smoothly along media contour tangents + subtle bass outward zoom
    let cent = vec2f(sim.size) * 0.5;
    let d = p - cent;
    let tangent = vec2f(-evec.y, evec.x) * sim.edge_flow * sim.media_pull;
    let q = cent + d * (1.0 - sim.zoom) - tangent;
    let prevAge = c.state.y;
    c = bilinear_cell(q);
    c.state.y = max(prevAge * 0.85, c.state.y);
  } else if (sim.switched > 0u) {
    // Binarize cleanly when transitioning from Lenia back to Life
    c.state.x = select(0.0, 1.0, c.state.x > 0.32);
  }

  let h1 = hashf(idx, sim.hash);
  let h2 = hashf(idx, sim.hash + 31337u);

  // Continuous contour & bright-feature seeding from the video
  let contourRate = clamp(emag * 0.16 * sim.edge_seed, 0.0, 0.65);
  let lumaRate = clamp(pow(clamp(lum, 0.0, 1.0), 1.6) * 0.065 * sim.luma_seed, 0.0, 0.35);
  let mediaProb = clamp(contourRate + lumaRate, 0.0, 0.72);
  if (h1 < mediaProb) {
    if (sim.lenia > 0.5) {
      let val = clamp(0.45 + 0.55 * h2, 0.0, 1.0);
      if (val > c.state.x) {
        c.state = vec4f(val, c.state.y * 0.5, max(c.state.z, val), max(c.state.w, 0.35 + 0.5 * sim.kick));
      }
    } else if (c.state.x < 0.5) {
      c.state = vec4f(1.0, 0.0, 1.0, 0.45 + 0.55 * sim.kick);
    }
    c.color = vec4f(mix(c.color.rgb, pic, 0.72), emag);
  } else {
    // Living cells gently track moving video colour
    c.color = vec4f(mix(c.color.rgb, pic, sim.color_track * (0.35 + 0.65 * c.state.x)), emag);
  }

  // Onset & beat seed discs, weighted by picture luma and edges
  for (var i = 0u; i < min(sim.nseed, 8u); i++) {
    let s = sim.seeds[i];
    var d = abs(p - s.xy);
    d = min(d, vec2f(sim.size) - d);
    let m = 1.0 - smoothstep(s.z * 0.5, s.z, length(d));
    if (m <= 0.0) { continue; }
    let hs = hashf(idx, sim.hash + i * 7919u + 97u);
    let weight = 0.35 + 0.65 * clamp(lum + emag * 0.8, 0.0, 1.2);
    if (sim.lenia > 0.5) {
      let n = hs * m * s.w * weight;
      if (n > c.state.x) {
        c.state = vec4f(clamp(n, 0.0, 1.0), 0.0, max(c.state.z, n), 0.95);
        c.color = vec4f(pic, emag);
      }
    } else if (hs < 0.48 * m * s.w * weight) {
      c.state = vec4f(1.0, 0.0, 1.0, 1.0);
      c.color = vec4f(pic, emag);
    }
  }

  dst[idx] = c;
}

@compute @workgroup_size(16, 16) fn cs_mass(@builtin(global_invocation_id) g: vec3u, @builtin(local_invocation_index) li: u32) {
  if (g.x < sim.size.x && g.y < sim.size.y) {
    atomicAdd(&wg_mass, u32(clamp(src[g.y * sim.size.x + g.x].state.x, 0.0, 1.0) * 256.0));
  }
  workgroupBarrier();
  if (li == 0u) { atomicAdd(&mass[0], atomicLoad(&wg_mass)); }
}

// Discrete Life-like step: newborns inherit blended colours of their living parents mixed with the live video.
@compute @workgroup_size(16, 16) fn cs_life(@builtin(global_invocation_id) g: vec3u) {
  if (g.x >= sim.size.x || g.y >= sim.size.y) { return; }
  let x = i32(g.x);
  let y = i32(g.y);
  let idx = g.y * sim.size.x + g.x;
  let uv = (vec2f(g.xy) + 0.5) / vec2f(sim.size);
  let pic = boost_pic(textureSampleLevel(tpic, smp, uv, 0.0).rgb);

  var n = 0u;
  var pcol = vec3f(0.0);
  for (var dy = -1; dy <= 1; dy++) {
    for (var dx = -1; dx <= 1; dx++) {
      if (dx == 0 && dy == 0) { continue; }
      let nb = src[wrap_idx(x + dx, y + dy)];
      if (nb.state.x > 0.5) {
        n += 1u;
        pcol += nb.color.rgb;
      }
    }
  }

  var c = src[idx];
  let alive = c.state.x > 0.5;
  var live = select((sim.birth >> n) & 1u, (sim.survive >> n) & 1u, alive) == 1u;
  // Strong media edges slightly stabilize colonies on the beat so the subject silhouette stays legible
  if (!live && alive && n == 1u && c.color.w > 0.55 && sim.media_pull > 0.25 && sim.beat > 0.45) {
    live = true;
  }

  if (live) {
    let parentAvg = select(pic, pcol / f32(max(n, 1u)), n > 0u);
    let nextCol = select(mix(parentAvg, pic, 0.45), mix(c.color.rgb, pic, 0.14), alive);
    let flash = select(0.85, c.state.w * 0.78, alive);
    c.state = vec4f(1.0, select(0.0, c.state.y + 1.0, alive), 1.0, flash);
    c.color = vec4f(nextCol, c.color.w);
  } else {
    c.state = vec4f(0.0, 0.0, c.state.z * sim.decay, c.state.w * 0.75);
    c.color = vec4f(c.color.rgb * 0.97, c.color.w);
  }
  dst[idx] = c;
}

// Continuous Lenia step: ring kernel convolves both mass and colour; media luma & edges steer local fertility.
@compute @workgroup_size(16, 16) fn cs_lenia(@builtin(global_invocation_id) g: vec3u) {
  if (g.x >= sim.size.x || g.y >= sim.size.y) { return; }
  let x = i32(g.x);
  let y = i32(g.y);
  let idx = g.y * sim.size.x + g.x;
  let uv = (vec2f(g.xy) + 0.5) / vec2f(sim.size);
  let pic = boost_pic(textureSampleLevel(tpic, smp, uv, 0.0).rgb);
  let lum = sample_luma(uv, pic);

  var u = 0.0;
  var ucol = vec3f(0.0);
  for (var i = 0u; i < sim.taps; i++) {
    let k = kern[i];
    let nb = src[wrap_idx(x + i32(k.x), y + i32(k.y))];
    let w = k.z * nb.state.x;
    u += w;
    ucol += nb.color.rgb * w;
  }

  let c = src[idx];
  let emag = c.color.w;
  let cover = f32(atomicLoad(&mass[0])) / 256.0 / f32(sim.size.x * sim.size.y);
  let sigma = sim.sigma * clamp(1.0 + sim.feedback * (sim.want - cover), 0.45, 1.25);
  // Media fertility: bright regions and contours shift mu slightly toward healthy growth
  let mu_local = clamp(sim.mu + (0.42 - lum) * 0.028 * sim.media_pull - min(emag, 1.0) * 0.018 * sim.media_pull, 0.08, 0.25);
  let e = (u - mu_local) / sigma;
  let grow = 2.0 * exp(-0.5 * e * e) - 1.0;
  let a = clamp(c.state.x + sim.dt * grow, 0.0, 1.0);
  let age = select(max(c.state.y - 3.0, 0.0), c.state.y + 1.0, a > 0.14);

  let nbCol = select(pic, ucol / max(u, 1e-4), u > 0.02);
  let colBlend = clamp(sim.dt * 2.2, 0.06, 0.42);
  let nextCol = mix(c.color.rgb, mix(nbCol, pic, 0.36), colBlend);

  dst[idx] = Cell(
    vec4f(a, age, max(a, c.state.z * sim.decay), c.state.w * 0.92),
    vec4f(nextCol, emag),
  );
}
