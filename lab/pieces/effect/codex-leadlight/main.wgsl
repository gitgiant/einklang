// Integer cell coordinates keep the glass grain and sites stable as the sheet moves.
fn glass_hash(cell: vec2f) -> vec2f {
  let p = fract(cell.xyx * vec3f(0.1031, 0.1030, 0.0973));
  let q = p + dot(p, p.yzx + 33.33);
  return fract((q.xx + q.yz) * q.zy);
}

fn glass_rotate(p: vec2f, angle: f32) -> vec2f {
  let cs = vec2f(cos(angle), sin(angle));
  return vec2f(dot(p, vec2f(cs.x, -cs.y)), dot(p, cs.yx));
}

fn shade(uv: vec2f) -> vec4f {
  let shape = vec2f(aspect(), 1.0);
  let screen = (uv - 0.5) * shape;
  let energy = smoothstep(0.03, 0.65, bass() + 0.4 * rms());
  let strike = clamp(onset(), 0.0, 1.0) * (1.0 - phase());
  let density = p_cells() / (1.0 + 0.29 * energy + 0.14 * strike);
  let drift = vec2f(0.25 * sin(time() * 0.37), 0.25 * cos(time() * 0.29));
  let angle = 0.12 * sin(time() * 0.25) + 0.48 * energy;
  let p = glass_rotate(screen, angle) * density + drift;
  let cell = floor(p);
  let local = fract(p);
  var first = 9.0;
  var second = 9.0;
  var site = vec2f(0.0);
  var neighbor = vec2f(0.0);
  for (var y = -1; y <= 1; y++) {
    for (var x = -1; x <= 1; x++) {
      let offset = vec2f(f32(x), f32(y));
      let candidate = offset + 0.22 + 0.56 * glass_hash(cell + offset);
      let delta = candidate - local;
      let d = dot(delta, delta);
      if (d < first) {
        second = first;
        neighbor = site;
        first = d;
        site = candidate;
      } else if (d < second) {
        second = d;
        neighbor = candidate;
      }
    }
  }

  // Distance to the bisector between the two nearest sites, in cell units.
  let seam = (second - first) * 0.5 / max(length(neighbor - site), 0.01);
  let aa = density / resolution().y;
  let lead = 1.0 - smoothstep(0.024 - aa, 0.024 + aa, seam);
  let ridge = 1.0 - smoothstep(0.028, 0.091, seam);
  let normal = normalize(neighbor - site + vec2f(0.0001, 0.0));
  let bevel = 0.32 + 0.68 * smoothstep(-0.7, 0.65, dot(normal, vec2f(-0.6, -0.8)));

  let center = glass_rotate((cell + site - drift) / density, -angle);
  let offset = (screen - center) * (0.26 + 0.22 * energy);
  let sample_uv = 0.5 + (center + offset) / shape;
  let media = tex_picture(sample_uv).rgb;
  let base = tex_light(sample_uv).x;
  let warmth = smoothstep(0.17, 0.70, base);
  let enamel = mix(vec3f(0.018, 0.115, 0.155), vec3f(0.57, 0.16, 0.031), warmth);
  let ripple = sin((local.x + local.y) * 29.0 + sin(local.y * 18.0)) * 0.035;
  let lamp = 0.85 + 1.4 * energy + 0.42 * strike;
  let glass = (0.78 * media + enamel * (0.45 + base)) * (lamp - 0.22 * first + ripple);
  let metal = vec3f(0.07, 0.032, 0.021) * (0.75 + 0.25 * bevel);
  let gleam = vec3f(0.42, 0.22, 0.071) * ridge * bevel * (0.45 + 1.1 * energy);

  return vec4f(mix(glass + gleam, metal, lead), 1.0);
}
