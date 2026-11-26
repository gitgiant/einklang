// claude-page-turn: the old scene is a sheet that rolls up from a seeded corner around a cylinder
// and folds back over itself. Coordinates are centred and aspect-corrected; the fold is the line
// dot(x, n) = f, with n pointing at the peeling corner.

/** Signed distance to the sheet (negative inside). */
fn page(x: vec2f, h: vec2f) -> f32 { let d = abs(x) - h; return max(d.x, d.y); }
fn uvOf(x: vec2f) -> vec2f { return x / vec2f(T.aspect, 1.0) + 0.5; }
/** The paper's back: pale, with a faint show-through of the front. */
fn paper(x: vec2f) -> vec3f {
  let a = sa(uvOf(x));
  return vec3f(0.30, 0.28, 0.25) + 0.10 * min(a, vec3f(2.0));
}

fn trans(uv: vec2f) -> vec3f {
  let p = T.p;
  let h = vec2f(0.5 * T.aspect, 0.5);
  let x = (uv - 0.5) * vec2f(T.aspect, 1.0);
  let k = h32(T.seed, 11u) >> 7u;
  let corner = vec2f(select(-1.0, 1.0, (k & 1u) != 0u), select(-1.0, 1.0, (k & 2u) != 0u));
  // between a shallow and a steep diagonal
  let ang = mix(0.35, 1.05, rnd(T.seed, 12u));
  let n = corner * vec2f(cos(ang), sin(ang));
  let rad = mix(0.07, 0.13, rnd(T.seed, 13u));
  let sMax = dot(h, abs(n));
  let f = mix(sMax, -sMax - rad - 0.02, p);
  let s = dot(x, n);
  let d = s - f;
  let px = 1.5 / T.res.y;
  let live = smoothstep(0.0, 0.08, p) * (1.0 - smoothstep(0.92, 1.0, p));

  // the new scene, shaded by the roll just above it
  var c = sb(uv) * (1.0 - 0.65 * live * exp(-max(d - rad, 0.0) / (1.4 * rad)));
  if (d <= 0.0) {
    // still flat; the folded-back flap casts a soft shadow just outside its edge
    let flap = x + n * (3.14159265 * rad - 2.0 * d);
    let sh = 1.0 - smoothstep(0.0, 0.09, page(flap, h));
    c = sa(uv) * (1.0 - 0.5 * live * sh);
    let cov = clamp(0.5 - page(flap, h) / px, 0.0, 1.0);
    let ridge = 0.82 + 0.18 * smoothstep(0.0, 2.5 * rad, -d);
    c = mix(c, paper(flap) * ridge, cov);
  } else if (d < rad) {
    let th = asin(clamp(d / rad, 0.0, 1.0));
    // lower half of the roll: the front, turning away from the light
    let lo = x + n * (rad * th - d);
    c = mix(c, sa(uvOf(lo)) * (0.25 + 0.75 * cos(th)), clamp(0.5 - page(lo, h) / px, 0.0, 1.0));
    // upper half: the back, with a highlight along the crest
    let hi = x + n * (rad * (3.14159265 - th) - d);
    let lit = 0.45 + 0.37 * cos(th) + 0.55 * pow(max(0.0, cos(th - 0.6)), 24.0);
    c = mix(c, paper(hi) * lit, clamp(0.5 - page(hi, h) / px, 0.0, 1.0));
  }
  return c;
}
