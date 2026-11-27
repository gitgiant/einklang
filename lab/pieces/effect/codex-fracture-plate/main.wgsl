fn plate_rotate(p: vec2f, angle: f32) -> vec2f {
  let cs = vec2f(cos(angle), sin(angle));
  return vec2f(dot(p, vec2f(cs.x, -cs.y)), dot(p, cs.yx));
}

fn plate_hash(cell: vec2f) -> f32 {
  let p = fract(cell.xyx * vec3f(0.11369, 0.13787, 0.09987));
  let q = p + dot(p, p.yzx + 19.19);
  return fract((q.x + q.y) * q.z);
}

fn shade(uv: vec2f) -> vec4f {
  let shape = vec2f(aspect(), 1.0);
  let p = (uv - 0.5) * shape;
  let energy = smoothstep(0.025, 0.64, bass() + 0.45 * rms());
  let kick = energy * (1.0 - smoothstep(0.0, 0.7, phase()));
  let hit = max(kick, 0.9 * clamp(onset(), 0.0, 1.0));
  let angle = 0.09 * sin(time() * 0.44) + 0.27 * energy;
  let density = p_tiles() / (1.0 + 0.31 * energy);
  let drift = 0.25 * vec2f(sin(time() * 0.42), cos(time() * 0.34));
  let world = plate_rotate(p, angle) * density + drift;
  // Invert an equilateral triangular lattice and split each parallelogram along its diagonal.
  let lattice = vec2f(world.x - world.y * 0.57735027, world.y * 1.15470054);
  let cell = floor(lattice);
  let local = fract(lattice);
  let upper = local.x + local.y > 1.0;
  let f = select(local, 1.0 - local, upper);
  let center = cell + select(1.0 / 3.0, 2.0 / 3.0, upper);
  let center_xy = vec2f(center.x + 0.5 * center.y, 0.8660254 * center.y);
  let tile = plate_rotate((center_xy - drift) / density, -angle);
  let roll = plate_hash(cell + select(vec2f(0.0), vec2f(0.5, -0.5), upper));
  let inward = p - tile;
  let depth = p_breakup() * (0.16 + 0.38 * energy + 0.46 * hit);
  let split = depth * (0.10 + 0.09 * roll);
  let edge = min(min(f.x, f.y), 1.0 - f.x - f.y);
  let aa = density / resolution().y;
  let face = smoothstep(split - aa, split + aa, edge);
  let lip = 1.0 - smoothstep(split + 0.009, split + 0.065, edge);

  // Each triangle retains a piece of the picture with its own tilt and outward jump.
  let push = tile * (roll - 0.2) * depth * 0.65;
  let source = tile + plate_rotate(inward, (roll - 0.5) * depth * 1.7) * (0.61 + 0.35 * roll) - push;
  let media = tex_picture(0.5 + source / shape).rgb;
  let avg = tex_picture(0.5 + (tile - push) / shape).rgb;
  let luma = sqrt(clamp(dot(avg, vec3f(0.2126, 0.7152, 0.0722)), 0.0, 1.0));
  let glaze = mix(vec3f(0.029, 0.094, 0.16), vec3f(0.37, 0.19, 0.070), smoothstep(0.17, 0.77, luma));
  let light = 0.94 + 0.83 * energy + 0.27 * hit + 0.26 * roll + 0.19 * (f.x - f.y);
  let rim = vec3f(0.29, 0.47, 0.60) * lip * (0.1 + 0.25 * roll + 0.35 * hit);
  let plate = (mix(avg, media, 0.69) * 0.74 + glaze * (0.39 + luma * 0.65)) * light + rim;
  let bed = vec3f(0.014, 0.037, 0.061) + vec3f(0.25, 0.085, 0.018) * (0.2 + hit) * max(0.0, 1.0 - length(p));
  return vec4f(mix(bed, plate, face), 1.0);
}
