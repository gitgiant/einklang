// claude-shatter: A is cut into Voronoi shards (one site per cell of a jittered grid). Each shard
// waits for the crack front from a seeded impact point, then spins, tumbles and falls off the
// bottom. Per pixel: try the shards that could be here, map back into A, keep the frontmost.
// Space: uv * (aspect, 1).

fn site(i: vec2i, cell: vec2f) -> vec2f {
  let id = u32(i.x + 64 * i.y);
  let j = vec2f(rnd(T.seed ^ 0x51u, id), rnd(T.seed ^ 0xa7u, id));
  return (vec2f(i) + 0.2 + 0.6 * j) * cell;
}

fn trans(uv: vec2f) -> vec3f {
  let p = T.p;
  let asp = vec2f(T.aspect, 1.0);
  let x = uv * asp;
  let nx = 6 + i32((h32(T.seed, 31u) >> 8u) % 4u);
  let ny = max(3, i32(round(f32(nx) / T.aspect)) + i32((h32(T.seed, 32u) >> 8u) % 2u));
  let cell = vec2f(T.aspect / f32(nx), 1.0 / f32(ny));
  let hit = vec2f(0.2 + 0.6 * rnd(T.seed, 33u), 0.2 + 0.6 * rnd(T.seed, 34u)) * asp;
  let rmax = 1.25 * length(cell);
  let cracked = smoothstep(0.0, 0.05, p);
  let col = i32(floor(x.x / cell.x));

  var c = sb(uv);
  var front = -1.0;
  var glass = vec3f(0.0);
  var cover = 0.0;
  for (var ix = max(col - 2, 0); ix <= min(col + 2, nx - 1); ix++) {
    for (var iy = 0; iy < ny; iy++) {
      let i = vec2i(ix, iy);
      let id = u32(ix + 64 * iy);
      let s0 = site(i, cell);
      let wait = 0.04 + 0.34 * clamp(length(s0 - hit) / length(asp), 0.0, 1.0) + 0.1 * rnd(T.seed ^ 0x13u, id);
      let t = clamp((p - wait) / (0.98 - wait), 0.0, 1.0);
      if (t >= 1.0) { continue; }
      let away = clamp((s0.x - hit.x) / cell.x, -1.0, 1.0);
      let drift = vec2f((0.25 * away + 0.3 * (rnd(T.seed ^ 0x29u, id) - 0.5)) * cell.x * t,
        t * t * (1.0 - s0.y + 2.2 * cell.y) - 0.12 * t * (1.0 - t));
      let at = s0 + drift;
      if (length(x - at) > rmax) { continue; }
      // undo the motion: spin in the plane, then foreshorten about the shard's own axis
      let spin = (rnd(T.seed ^ 0x3bu, id) - 0.5) * 5.0 * t;
      let flip = cos(t * mix(2.0, 7.0, rnd(T.seed ^ 0x47u, id)));
      let axis = rnd(T.seed ^ 0x59u, id) * 3.14159265;
      var l = rot(x - at, -spin);
      l = rot(l, -axis);
      l.y /= select(-1.0, 1.0, flip >= 0.0) * max(abs(flip), 0.18);
      l = rot(l, axis);
      let q = s0 + l * (1.0 - 0.2 * t) / (1.0 + 0.35 * t * (1.0 - t));
      if (q.x < 0.0 || q.y < 0.0 || q.x > T.aspect || q.y > 1.0) { continue; }
      // q belongs to this shard if no neighbouring site is nearer; edge = distance to its border
      let own = dot(q - s0, q - s0);
      var edge = 1.0;
      for (var n = 0; n < 9 && edge >= 0.0; n++) {
        let j = i + vec2i(n % 3 - 1, n / 3 - 1);
        if (n == 4 || j.x < 0 || j.y < 0 || j.x >= nx || j.y >= ny) { continue; }
        let s = site(j, cell);
        edge = min(edge, (dot(q - s, q - s) - own) / (2.0 * length(s - s0)));
      }
      if (edge < 0.0) { continue; }
      if (t <= front) { continue; }
      front = t;
      let moving = smoothstep(0.0, 0.15, t);
      // each pane catches the light differently as it tilts
      let tilt = 1.0 - moving * (0.55 * (1.0 - abs(flip)) + 0.15 * rnd(T.seed ^ 0x61u, id));
      let glint = moving * pow(max(0.0, 1.0 - abs(flip - 0.55) * 3.0), 3.0);
      let rim = (1.0 - smoothstep(0.0, 3.0 / T.res.y, edge)) * cracked;
      glass = sa(q / asp) * tilt + vec3f(0.55, 0.65, 0.8) * (0.7 * rim + 0.3 * glint);
      cover = 1.0 - smoothstep(0.85, 1.0, t);
    }
  }
  if (front >= 0.0) { return mix(c, glass, cover); }
  // B starts a little dim behind the breaking pane
  return c * mix(0.55, 1.0, smoothstep(0.2, 0.9, p));
}
