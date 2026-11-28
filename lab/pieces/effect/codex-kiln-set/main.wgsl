fn kiln_hash(p: vec2f) -> f32 {
  let q = fract(vec3f(p.xyx) * vec3f(0.1031, 0.11369, 0.13787));
  let r = q + dot(q, q.yzx + 19.19);
  return fract((r.x + r.y) * r.z);
}

fn shade(uv: vec2f) -> vec4f {
  let centered = uv - 0.5;
  let panel = centered * vec2f(1.06, 1.12);
  let scale = vec2f(aspect(), 1.0) * p_rows();
  let grid = (panel + 0.5) * scale;
  let row = floor(grid.y);
  let stagger = 0.5 * (row - 2.0 * floor(row * 0.5));
  let brick = vec2f(grid.x + stagger, grid.y);
  let cell = floor(brick);
  let local = fract(brick) - 0.5;
  let chip = kiln_hash(cell);
  let salt = kiln_hash(cell + 13.85);
  let sample_uv = (cell + vec2f(0.5 - stagger, 0.5)) / scale;
  let dye = tex_picture(sample_uv).rgb;
  let light = sqrt(clamp(dot(dye, vec3f(0.2126, 0.7152, 0.0722)), 0.0, 1.0));

  // An onset sends a setting wave across the mortar. Tile positions stay fixed while their faces rise.
  let strike = p_strike();
  let sweep = 0.5 + 0.5 * cos(sample_uv.x * 7.0 + sample_uv.y * 5.0 + bar() * 1.57);
  let lift = smoothstep(0.18, 0.74, strike + sweep * 0.28 + chip * 0.17)
    * (0.48 + 0.52 * light);
  let energy = smoothstep(0.11, 0.73, rms());
  let set = clamp(lift + 0.60 * energy, 0.0, 1.0);
  let half_size = 0.385 + 0.045 * chip + 0.064 * set;
  let offset = vec2f(0.010, 0.047) * lift;
  let face_uv = local + offset;
  let corner = abs(face_uv) - vec2f(half_size - 0.092);
  let sd = length(max(corner, vec2f(0.0))) + min(max(corner.x, corner.y), 0.0) - 0.092;
  let aa = max(0.012, 0.7 * p_rows() / resolution().y);
  let coverage = 1.0 - smoothstep(-aa, aa, sd);
  let inset = smoothstep(-0.025, -0.115, sd);
  let sun_side = smoothstep(0.14, -0.46, face_uv.x * 0.7 + face_uv.y);
  let chips = kiln_hash(floor(uv * resolution() * 0.64));
  let glaze = pow(max(0.0, 1.0 - abs(face_uv.x + face_uv.y * 0.6 + 0.21) * 2.8), 6.0);

  let stone = vec3f(0.23, 0.163, 0.110);
  let grout = stone * (0.80 + 0.24 * chips + 0.10 * salt);
  let shadow = smoothstep(0.13, 0.02, sd) * (0.20 + 0.38 * lift);
  let terracotta = vec3f(0.18, 0.064, 0.031);
  let ceramic = mix(terracotta, dye * vec3f(1.21, 1.05, 0.88) + 0.025, 0.80 + 0.16 * set);
  var tile = ceramic * (0.46 + 0.52 * inset + 0.11 * chips) * (0.57 + 1.12 * set);
  tile += vec3f(0.31, 0.195, 0.111) * (1.0 - inset) * sun_side * (0.55 + 0.52 * set);
  tile += vec3f(0.23, 0.15, 0.09) * glaze * inset * (0.25 + 0.66 * lift);
  let picture = mix(grout * (1.0 - shadow), tile, coverage);

  let rim = 0.472 - max(abs(panel.x), abs(panel.y));
  let bead = smoothstep(0.0045, 0.001, abs(rim - 0.004));
  let frame = vec3f(0.049, 0.030, 0.019) * (0.91 + 0.16 * chips);
  let border = smoothstep(-0.025, -0.024, rim);
  let background = frame + stone * (0.6 * border + 0.65 * bead);
  return vec4f(mix(background, picture, smoothstep(0.007, 0.009, rim)), 1.0);
}
