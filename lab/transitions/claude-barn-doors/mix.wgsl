// claude-barn-doors: the two halves of A are doors hinged on the outer screen edges, swinging
// toward the viewer; B waits recessed behind them and comes forward. `a` is the axis across the
// split (x, or y when it splits across), `b` the other one. Camera at z = -DIST.

const DIST: f32 = 1.8;

fn trans(uv: vec2f) -> vec3f {
  let p = T.p;
  let vert = (h32(T.seed, 41u) & 0x100u) != 0u;
  let x = (uv - 0.5) * vec2f(T.aspect, 1.0);
  let a = select(x.x, x.y, vert);
  let b = select(x.y, x.x, vert);
  let ha = select(0.5 * T.aspect, 0.5, vert); // also each door's width
  let hb = select(0.5, 0.5 * T.aspect, vert);
  let side = select(-1.0, 1.0, a >= 0.0);
  // one door (seeded) leads the other a little
  let late = select(-1.0, 1.0, (h32(T.seed, 42u) & 0x100u) != 0u) == side;
  let lag = 0.25 * rnd(T.seed, 43u);
  let o = clamp(p * (1.0 + lag) - select(0.0, lag, late), 0.0, 1.0);
  let th = 1.6580628 * o; // 95 degrees: fully out of view
  let cs = cos(th);
  let sn = sin(th);

  // B behind the doorway: further back and darker until the doors are open, lit through the gap
  let qb = (uv - 0.5) * (1.0 - 0.16 * (1.0 - p)) + 0.5;
  let jamb = smoothstep(0.0, 0.35, ha - abs(a));
  var c = sb(qb) * mix(mix(0.25, 0.75, jamb), 1.0, smoothstep(0.35, 1.0, p));

  // ray against this side's door: r = distance from the hinge along the door
  let m = -abs(a); // mirrored so the hinge is at -ha
  let den = cs + m * sn / DIST;
  if (den > 1e-4) {
    let r = (m + ha) / den;
    let depth = 1.0 - r * sn / DIST;
    let v = b * depth;
    if (r >= 0.0 && r <= ha && abs(v) <= hb) {
      let al = -side * (r - ha); // position across the screen the door point came from
      let q = select(vec2f(al, v), vec2f(v, al), vert) / vec2f(T.aspect, 1.0) + 0.5;
      let w = r / ha;
      var d = sa(q) * (1.0 - sn * mix(0.35, 0.75, w));
      // the free edge catches the light from the room behind
      let rim = 1.0 - smoothstep(0.0, 0.012, ha - r);
      d += vec3f(0.9, 0.75, 0.5) * rim * smoothstep(0.0, 0.1, o) * (1.0 - o);
      return d;
    }
    // soft shadow just past the free edge
    let gap = max(r - ha, 0.0);
    c *= 1.0 - 0.45 * (1.0 - smoothstep(0.0, 0.12, gap)) * smoothstep(0.0, 0.15, o) * (1.0 - o);
  }
  return c;
}
