// claude-cube: A is the front face of a block, B the neighbouring face; the block turns a quarter
// round. `a` is the screen axis across the turn (x, or y for an up/down turn), `b` the other one.
// Camera at z = -DIST looking at the screen plane z = 0, which the front face fills at p = 0 and 1.

const DIST: f32 = 2.0;

fn trans(uv: vec2f) -> vec3f {
  let p = T.p;
  let k = h32(T.seed, 21u) >> 9u;
  let vert = (k & 1u) != 0u;
  let dir = select(-1.0, 1.0, (k & 2u) != 0u);
  let x = (uv - 0.5) * vec2f(T.aspect, 1.0);
  let a = select(x.x, x.y, vert) * dir;
  let b = select(x.y, x.x, vert);
  let ha = select(0.5 * T.aspect, 0.5, vert);
  let hb = select(0.5, 0.5 * T.aspect, vert);
  let bump = sin(3.14159265 * p);
  let back = bump * mix(0.5, 0.9, rnd(T.seed, 22u)); // pull away mid-turn
  let th = 1.57079633 * p;
  let cs = cos(th);
  let sn = sin(th);
  // ray in the block's frame (a, z), origin at its centre
  let oz = -DIST - ha - back;
  let o = vec2f(-sn * oz, cs * oz);
  let r = vec2f(cs * a - sn * DIST, sn * a + cs * DIST);

  // backdrop: a dim, blurred-away glow of the incoming scene
  var c = sb(uv) * 0.03 * bump;
  var fa = -1.0; // coordinate across the hit face, 0..1
  var fb = 0.0;
  var face = 0u;
  // front face (A): z = -ha
  if (r.y > 1e-5) {
    let t = (-ha - o.y) / r.y;
    let u = (o.x + t * r.x) / (2.0 * ha) + 0.5;
    let v = t * b / (2.0 * hb) + 0.5;
    if (t > 0.0 && u >= -1e-4 && u <= 1.0001 && v >= -1e-4 && v <= 1.0001) { fa = u; fb = v; face = 1u; }
  }
  // side face (B): a = +ha, seen only from outside it
  if (face == 0u && r.x < -1e-5) {
    let t = (ha - o.x) / r.x;
    let u = (o.y + t * r.y) / (2.0 * ha) + 0.5;
    let v = t * b / (2.0 * hb) + 0.5;
    if (t > 0.0 && u >= -1e-4 && u <= 1.0001 && v >= -1e-4 && v <= 1.0001) { fa = u; fb = v; face = 2u; }
  }
  if (face != 0u) {
    let along = select(1.0 - fa, fa, dir > 0.0);
    let q = select(vec2f(along, fb), vec2f(fb, along), vert);
    let facing = select(sn, cs, face == 1u);
    let shade = mix(0.18, 1.0, pow(clamp(facing, 0.0, 1.0), 0.9));
    c = select(sb(q), sa(q), face == 1u) * shade;
    // lit rim so the edges read against dark scenes
    let e = min(min(fa, 1.0 - fa) * 2.0 * ha, min(fb, 1.0 - fb) * 2.0 * hb);
    c += vec3f(0.35, 0.4, 0.5) * bump * (1.0 - smoothstep(0.0, 0.008, e));
  }
  return c;
}
