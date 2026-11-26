fn crt_rand(p: vec2f) -> f32 {
  let i = vec2u(vec2i(floor(p)) + vec2i(100000));
  var h = (i.x * 0x8da6b343u) ^ (i.y * 0xd8163841u);
  h = (h ^ (h >> 13u)) * 0x5bd1e995u;
  h = h ^ (h >> 15u);
  return f32(h >> 8u) / 16777216.0;
}

fn shade(uv: vec2f) -> vec4f {
  let res = resolution();
  // barrel
  var q = uv - 0.5;
  q *= 1.0 + p_curve() * dot(q * vec2f(aspect(), 1.0), q * vec2f(aspect(), 1.0)) * 0.5;
  var w = q + 0.5;
  let inside = step(0.0, w.x) * step(w.x, 1.0) * step(0.0, w.y) * step(w.y, 1.0);
  // soft bezel edge
  let e = min(min(w.x, 1.0 - w.x) * aspect(), min(w.y, 1.0 - w.y));
  let bezel = smoothstep(0.0, 0.012, e) * inside;

  // VHS tracking band: rolls up the screen, tears sideways on onsets
  let ty = fract(time() * 0.07);
  let band_d = abs(w.y - (1.0 - ty));
  let tb = exp(-band_d * 60.0) * p_track();
  let tear = tb * (0.004 + 0.02 * onset() + 0.01 * bass()) * (crt_rand(vec2f(w.y * res.y * 0.25, time() * 30.0)) - 0.3);
  w.x += tear;

  // convergence error, kicking with bass and onsets
  let k = p_shift() + p_kick() * (bass() + 0.6 * onset());
  let dir = normalize(q + vec2f(1e-4, 0.0)) * k + vec2f(k * 0.5, 0.0);
  let cr = tex_in(clamp(w + dir, vec2f(0.0), vec2f(1.0))).r;
  let cg = tex_in(clamp(w, vec2f(0.0), vec2f(1.0))).g;
  let cb = tex_in(clamp(w - dir, vec2f(0.0), vec2f(1.0))).b;
  var c = vec3f(cr, cg, cb);

  // scanlines + aperture grille (in output pixels)
  let sl = 0.5 - 0.5 * cos(w.y * p_lines() * 6.2831853);
  c *= 1.0 - p_scan() * sl;
  let pxx = i32(floor(uv.x * res.x)) % 3;
  var g = vec3f(1.0 - p_mask());
  if (pxx == 0) { g.r = 1.0; } else if (pxx == 1) { g.g = 1.0; } else { g.b = 1.0; }
  c *= g;
  c *= 1.0 + p_scan() * 0.5 + p_mask() * 0.4;

  // tape noise, stronger inside the tracking band
  let nz = crt_rand(vec2f(uv.x * res.x * 0.5, uv.y * res.y * 0.5) + vec2f(f32(i32(time() * 60.0) % 997) * 13.0, 0.0));
  c += vec3f(nz - 0.5) * (p_noise() + tb * 0.25);
  c += vec3f(0.6, 0.7, 1.0) * tb * 0.06;

  // vignette
  let vg = 1.0 - p_vignette() * dot(q, q) * 1.6;
  c *= clamp(vg, 0.0, 1.0) * bezel;
  return vec4f(max(c, vec3f(0.0)), 1.0);
}
