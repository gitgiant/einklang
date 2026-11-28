// The media is dyed into the yarn. The loom coordinates move independently of the lighting.
fn warp_loom_hash(p: vec2f) -> f32 {
  let q = fract(p * vec2f(0.1031, 0.11369));
  return fract(31.71 * (q.x + q.y) * (0.21 + dot(q, q.yx + 5.13)));
}

fn shade(uv: vec2f) -> vec4f {
  let centered = uv - 0.5;
  let cloth = centered * vec2f(1.08, 1.20);
  let bass_pull = smoothstep(0.09, 0.76, bass());
  let upper = (band(8) + band(11) + band(14)) / 3.0;
  let beat_pull = (1.0 - phase()) * (0.38 + 0.62 * (1.0 - phase()));
  let tug = p_tension() * bass_pull * (0.35 + 0.65 * beat_pull);
  let fold = cos(cloth.x * 16.0 + cloth.y * 10.0 - time() * 1.9);
  let wave = sin(cloth.x * 12.5 - cloth.y * 4.0 + time() * 1.25);
  let yarn_uv = cloth + vec2f(
    0.013 * wave + tug * 0.035 * fold,
    0.008 * fold + tug * (0.15 * wave + 0.04 * fold)
  );
  let grid = (yarn_uv + 0.5) * vec2f(aspect(), 1.0) * p_count();
  let knot = floor(grid);
  let local = fract(grid) - 0.5;
  let warp_over = (i32(knot.x) + i32(knot.y)) % 2 == 0;
  let cross_yarn = select(local.y, local.x, warp_over);
  let along_yarn = select(local.x, local.y, warp_over);
  let yarn = sqrt(max(0.0, 1.0 - 4.0 * cross_yarn * cross_yarn));
  let fiber = 0.5 + 0.5 * cos(47.0 * cross_yarn + 1.5 * sin(along_yarn * 7.0));
  let pick = warp_loom_hash(knot);
  let sample_shift = select(vec2f(0.002, 0.0), vec2f(0.0, 0.0025), warp_over);
  let dye = tex_picture(yarn_uv + 0.5 + sample_shift).rgb;
  let dyed = vec3f(0.040, 0.021, 0.012) + dye * vec3f(1.10, 0.93, 0.76);
  let crossing_shadow = 1.0 - 0.24 * smoothstep(0.22, 0.49, abs(along_yarn));
  let glint = pow(max(0.0, 1.0 - abs(cross_yarn + 0.19) * 3.5), 3.0);
  var face = dyed * (0.15 + 0.83 * yarn * crossing_shadow) * (0.79 + 0.21 * pick);
  face += vec3f(0.17, 0.105, 0.054) * glint * yarn * (0.38 + 0.55 * fiber + upper);
  face *= 0.65 + 0.24 * fold * tug + 0.98 * bass_pull + 0.16 * onset();

  // Selvage and a row of tied warp ends along the top and bottom of the panel.
  let edge = 0.48 - max(abs(cloth.x), abs(cloth.y));
  let border = smoothstep(0.021, 0.014, edge);
  let binding = vec3f(0.22, 0.115, 0.048) * (0.36 + 0.64 * yarn) * (0.65 + 0.5 * pick);
  face = mix(face, binding, border);
  let piping = smoothstep(0.003, 0.0005, abs(edge - 0.019));
  face += vec3f(0.11, 0.06, 0.023) * piping * yarn;
  let fringe_x = (cloth.x + 0.5 + 0.002 * wave * tug) * aspect() * p_count();
  let fringe_yarn = smoothstep(0.39, 0.19, abs(fract(fringe_x) - 0.5));
  let fringe_end = 0.497 + 0.029 * warp_loom_hash(vec2f(floor(fringe_x), sign(cloth.y)));
  let fringe = fringe_yarn * smoothstep(fringe_end, fringe_end - 0.012, abs(cloth.y))
    * smoothstep(0.48, 0.477, abs(cloth.x));
  let mount = vec3f(0.020, 0.013, 0.009) * (1.08 - 0.75 * dot(centered, centered));
  let outside = mix(mount, binding * (0.6 + 0.35 * wave), fringe);
  return vec4f(mix(outside, face, smoothstep(-0.001, 0.001, edge)), 1.0);
}
