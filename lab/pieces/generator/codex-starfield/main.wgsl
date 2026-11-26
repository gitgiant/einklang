fn star_random(lane: u32, seed: u32) -> f32 {
  return f32(h32(lane, seed) >> 8u) / 16777216.0;
}

fn shade(uv: vec2f) -> vec4f {
  let impulse = smoothstep(0.12, 0.74, bass());
  let energy = smoothstep(0.21, 0.63, rms() + 0.10 * impulse);
  let warp = clamp(energy * (0.88 + 0.4 * p_warp()), 0.0, 1.0);
  let shimmer = smoothstep(0.34, 0.84, (band(10) + band(13) + band(15)) / 3.0);
  let beat = phase();
  let burst = max(onset(), impulse * exp(-beat * 3.6));
  let aim = vec2f(0.47, 0.51) + warp * vec2f(sin(time() * 1.4) * 0.036, 0.043 * burst);
  let p = (uv - aim) * vec2f(aspect(), 1.0);
  let r = length(p);
  let pixel = 1.0 / resolution().y;
  let night = palette(0.0);
  let blue = palette(0.25);
  let cyan = palette(0.5);
  let white = palette(0.75);
  let gold = palette(1.0);
  let angle = atan2(p.y, p.x + select(0.0, 0.000001, r < 0.000001));
  let bank = sin(angle - 0.62 - r * (2.1 + warp * 1.6) + time() * 0.14);
  let dust = exp(-(4.1 - 1.5 * warp) * bank * bank) * exp(-r * (3.7 - 1.6 * warp));
  let jet = 0.54 + 0.46 * sin(angle * 5.0 + r * 10.0 - time() * 1.8);
  let halo = exp(-r * (4.8 - 2.9 * warp));
  let waveRadius = 0.055 + beat * (0.59 + 0.28 * impulse);
  let wave = exp(-abs(r - waveRadius) * 22.0) * burst;
  var color = night * 0.48 + blue * (0.06 + 0.24 * dust);
  color += cyan * dust * min(rms(), 0.22) * 0.16;
  color += mix(blue, cyan, 0.38 + 0.31 * shimmer) * (dust * (0.67 + 0.38 * jet) + halo * 0.32) * warp;
  color += mix(cyan, gold, 0.35 + 0.34 * burst) * (wave * 0.36 + halo * burst * 0.44);

  // Each angular sector owns several stars at staggered depths. The projected radius is
  // inversely proportional to depth, so every star accelerates toward the edge of the view.
  let sectorCount = 96.0;
  let sectorPos = fract(angle / 6.2831853 + 0.5) * sectorCount;
  let sector = u32(floor(sectorPos));
  let local = fract(sectorPos);
  let halfSector = 3.14159265 * r / sectorCount;
  let surge = (1.0 - exp(-4.0 * beat)) / (1.0 - exp(-4.0)) - beat;
  let flight = time() + (0.1 + 0.78 * warp) * surge * (60.0 / max(bpm(), 55.0));
  for (var layer = 0u; layer < 8u; layer++) {
    let lane = sector * 8u + layer;
    let offset = (f32(layer) + star_random(lane, 5u)) / 8.0;
    let fast = layer % 3u != 0u && layer > 2u;
    let spark = layer == 7u;
    let rate = p_speed() * select(0.48, 1.86, fast) * (0.84 + star_random(lane, 3u) * 0.31);
    let travel = flight * rate + offset;
    let cycle = u32(floor(travel));
    let z = 1.0 - fract(travel);
    let seed = cycle * 11u;
    let azimuth = 0.2 + 0.6 * star_random(lane, seed + 7u);
    let across = abs(local - azimuth) * 2.0 * halfSector;
    let distance = 0.043 + 0.123 * star_random(lane, seed + 9u);
    let head = distance / (0.042 + z);
    let exposure = select(0.009, 0.022, fast) + warp * select(0.10, 0.29, fast) + 0.16 * burst;
    let tail = distance / (0.042 + z + exposure);
    let tip = (mix(0.70, 1.66, clamp(head, 0.0, 1.0)) + 1.28 * warp + 0.7 * burst) * pixel;
    let radius = min(tip, halfSector * 0.18);
    let delta = max(max(tail - r, r - head), 0.0);
    let line = 1.0 - smoothstep(radius * 0.27, radius + min(pixel, halfSector * 0.20), length(vec2f(across, delta)));
    let taper = smoothstep(tail - pixel, head, r);
    let arrival = smoothstep(0.0, 0.14, 1.0 - z) * smoothstep(0.047, 0.15, r);
    let weight = select(0.91 - 0.28 * warp, 0.10 + 1.34 * warp, fast);
    let tint = mix(cyan, white, min(1.0, star_random(lane, seed + 10u) + shimmer * 0.44));
    let flash = select(1.0, burst * 3.04, spark);
    color += mix(tint, gold, select(0.06, 0.88, spark)) * line * taper * arrival
      * (0.74 + 0.61 * r) * weight * flash * p_glow();
  }
  return vec4f(color, 1.0);
}
