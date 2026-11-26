fn star_random(lane: u32, seed: u32) -> f32 {
  return f32(h32(lane, seed) >> 8u) / 16777216.0;
}

fn shade(uv: vec2f) -> vec4f {
  let p = (uv - vec2f(0.47, 0.51)) * vec2f(aspect(), 1.0);
  let r = length(p);
  let pixel = 1.0 / resolution().y;
  let energy = clamp(0.63 * p_warp() + 0.74 * rms(), 0.0, 1.0);
  let burst = max(onset(), smoothstep(0.04, 0.38, bass()) * exp(-phase() * 8.0) * 0.65);
  let night = palette(0.0);
  let blue = palette(0.25);
  let cyan = palette(0.5);
  let white = palette(0.75);
  let gold = palette(1.0);
  let angle = atan2(p.y, p.x + select(0.0, 0.000001, r < 0.000001));
  let bank = sin(angle - 0.62 - r * 2.1 + time() * 0.09);
  let dust = exp(-4.1 * bank * bank) * exp(-r * 3.7);
  var color = night * 0.59 + blue * (0.06 + 0.31 * dust + energy * dust * 0.34)
    + cyan * (0.071 + 0.048 * burst) * exp(-r * 11.0);

  // Each angular sector owns several stars at staggered depths. The projected radius is
  // inversely proportional to depth, so every star accelerates toward the edge of the view.
  let sectorCount = 96.0;
  let sectorPos = fract(angle / 6.2831853 + 0.5) * sectorCount;
  let sector = u32(floor(sectorPos));
  let local = fract(sectorPos);
  let halfSector = 3.14159265 * r / sectorCount;
  for (var layer = 0u; layer < 8u; layer++) {
    let lane = sector * 8u + layer;
    let offset = (f32(layer) + star_random(lane, 5u)) / 8.0;
    let fast = layer % 3u != 0u && layer > 2u;
    let spark = layer == 7u;
    let rate = p_speed() * select(0.56, 1.47, fast) * (0.84 + star_random(lane, 3u) * 0.31);
    let travel = time() * rate + offset;
    let cycle = u32(floor(travel));
    let z = 1.0 - fract(travel);
    let seed = cycle * 11u;
    let azimuth = 0.2 + 0.6 * star_random(lane, seed + 7u);
    let across = abs(local - azimuth) * 2.0 * halfSector;
    let distance = 0.043 + 0.123 * star_random(lane, seed + 9u);
    let head = distance / (0.042 + z);
    let exposure = select(0.019, 0.048, fast) * (1.0 + 1.7 * energy + 1.6 * burst);
    let tail = distance / (0.042 + z + exposure);
    let tip = max(0.45 * pixel, mix(0.70, 1.66, clamp(head, 0.0, 1.0)) * pixel);
    let radius = min(tip, halfSector * 0.18);
    let delta = max(max(tail - r, r - head), 0.0);
    let line = 1.0 - smoothstep(radius * 0.27, radius + min(pixel, halfSector * 0.20), length(vec2f(across, delta)));
    let taper = smoothstep(tail - pixel, head, r);
    let arrival = smoothstep(0.0, 0.14, 1.0 - z) * smoothstep(0.047, 0.15, r);
    let weight = select(1.0 - 0.44 * energy, 0.23 + 0.99 * energy, fast);
    let tint = mix(cyan, white, star_random(lane, seed + 10u));
    let flash = select(1.0, burst * 2.24, spark);
    color += mix(tint, gold, select(0.06, 0.88, spark)) * line * taper * arrival
      * (0.74 + 0.61 * r) * weight * flash * p_glow();
  }
  return vec4f(color, 1.0);
}
