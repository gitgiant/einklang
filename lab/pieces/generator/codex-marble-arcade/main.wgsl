fn mask(d: f32, aa: f32) -> f32 {
  return 1.0 - smoothstep(-aa, aa, d);
}

fn rect(p: vec2f, h: vec2f) -> f32 {
  let d = abs(p) - h;
  return max(d.x, d.y);
}

fn ellipse(p: vec2f, size: vec2f) -> f32 {
  return (length(p / size) - 1.0) * min(size.x, size.y);
}

fn palm(p: vec2f, aa: f32, wind: f32) -> f32 {
  let y = clamp(p.y / 0.31, 0.0, 1.0);
  let trunk = max(abs(p.x - 0.076 * y * y) - mix(0.004, 0.012, y), abs(p.y - 0.156) - 0.158);
  var leaves = length(p) - 0.017;
  if (length(p) < 0.22) {
    for (var i = 0; i < 8; i++) {
      let a = f32(i) * 0.7854 + 0.21;
      let axis = vec2f(cos(a), 0.63 * sin(a));
      let along = dot(p, axis) / dot(axis, axis);
      let s = clamp(along / (0.106 + 0.045 * abs(axis.x)), 0.0, 1.0);
      let blade = abs(p.x * axis.y - (p.y - (0.075 + wind) * s * s) * axis.x);
      let fringe = 0.68 + 0.32 * sin(s * 82.0 + a * 2.0);
      let outline = blade - (0.003 + 0.022 * s) * (1.0 - s) * fringe;
      leaves = min(leaves, max(outline, max(-along, s * 0.002 + along - 0.146)));
    }
  }
  return mask(min(leaves, trunk), aa);
}

// A shallow relief is built from overlapping ellipsoids. The z offset controls
// the cast of each facial plane over the skull, while each surface has its own normal.
fn stone(p: vec2f, center: vec2f, size: vec2f, relief: f32, front: f32) -> vec4f {
  let q = (p - center) / size;
  let dome = sqrt(max(0.0, 1.0 - dot(q, q)));
  return vec4f(q / size, dome / relief, select(-2.0, front + relief * dome, dot(q, q) <= 1.0));
}

fn upper(a: vec4f, b: vec4f) -> vec4f {
  return select(a, b, b.w > a.w);
}

fn marble(p: vec2f, aa: f32, energy: f32) -> vec4f {
  let skull = vec2f(-0.017, -0.069);
  let head = vec2f(0.103, 0.141);
  let chin = vec2f(0.011, 0.032);
  let jaw = vec2f(0.084, 0.082);
  let neck = vec2f(-0.021, 0.113);
  let throat = vec2f(0.055, 0.104);
  let shoulders = vec2f(-0.008, 0.225);
  let chest = vec2f(0.201, 0.075);
  let ear = vec2f(-0.107, -0.016);
  let pinna = vec2f(0.019, 0.038);
  var silhouette = min(ellipse(p - skull, head), ellipse(p - chin, jaw));
  silhouette = min(silhouette, min(ellipse(p - neck, throat), ellipse(p - ear, pinna)));
  silhouette = min(silhouette, max(ellipse(p - shoulders, chest), p.y - 0.251));
  let opacity = mask(silhouette, aa);
  if (opacity <= 0.0) { return vec4f(0.0); }

  var surface = stone(p, shoulders, chest, 0.069, -0.025);
  surface = upper(surface, stone(p, neck, throat, 0.063, -0.013));
  surface = upper(surface, stone(p, ear, pinna, 0.026, 0.001));
  surface = upper(surface, stone(p, skull, head, 0.086, 0.0));
  surface = upper(surface, stone(p, chin, jaw, 0.100, 0.006));
  surface = upper(surface, stone(p, vec2f(0.018, 0.008), vec2f(0.065, 0.038), 0.045, 0.064));
  surface = upper(surface, stone(p, vec2f(0.037, -0.037), vec2f(0.023, 0.052), 0.055, 0.065));
  surface = upper(surface, stone(p, vec2f(0.048, -0.010), vec2f(0.024, 0.016), 0.046, 0.079));
  let n = normalize(surface.xyz + vec3f(0.0, 0.0, 0.001));
  let shade = clamp(dot(n, normalize(vec3f(-0.61, -0.60, 0.66))), 0.0, 1.0);
  let rim = pow(max(0.0, 1.0 - abs(n.z)), 2.0) * (0.23 + 0.35 * energy);
  var col = mix(vec3f(0.28, 0.18, 0.36), vec3f(1.22, 1.10, 1.02), shade);
  col += rim * vec3f(0.30, 0.77, 0.95);
  let eyeL = ellipse(p - vec2f(-0.030, -0.048), vec2f(0.029, 0.007));
  let eyeR = ellipse(p - vec2f(0.068, -0.048), vec2f(0.021, 0.006));
  let sockets = exp(-89.0 * max(0.0, min(eyeL, eyeR))) * 0.32;
  let lips = exp(-265.0 * abs(p.y - 0.050 + (p.x - 0.022) * (p.x - 0.022) * 2.8)) * exp(-pow(abs(p.x - 0.025) / 0.039, 4.0));
  let nostril = mask(ellipse(p - vec2f(0.052, 0.003), vec2f(0.008, 0.003)), aa);
  col *= 1.0 - sockets - lips * 0.35 - nostril * 0.27;

  // Overlapping arcs pick out the curls and a pale vein crosses the whole carving.
  let hairline = -0.105 + 3.8 * pow(abs(p.x + 0.009), 2.0) + 0.007 * sin(54.0 * p.x);
  if (p.y < hairline) {
    let curlCell = vec2f(p.x + 0.014 * sin(p.y * 44.0), p.y) * vec2f(26.0, 36.0);
    let curl = length(fract(curlCell) - vec2f(0.50, 0.54));
    col *= 0.77 + 0.17 * cos(curl * 15.0 - 1.2) + 0.16 * (1.0 - curl);
  }
  let grain = sin(88.0 * p.x + 119.0 * p.y + 2.9 * sin(21.0 * p.y - 29.0 * p.x));
  col *= 1.0 - 0.11 * pow(abs(grain), 18.0);
  return vec4f(col, opacity);
}

fn arcade(p: vec2f, side: f32, aa: f32) -> vec2f {
  let x = p.x * side;
  if (x < 0.31 || p.y < 0.14 || p.y > 0.70) { return vec2f(0.0); }
  let base = 0.54 + 0.153 * min(x, 1.3);
  let top = 0.436 - 0.285 * min(x, 1.3);
  let bay = fract((x - 0.34) * 5.25 + 0.51) - 0.5;
  let spacing = 1.0 + 0.70 * x;
  let capital = rect(vec2f(bay, p.y - top - 0.021), vec2f(0.17, 0.016));
  let shaft = max(abs(bay) - 0.092 * spacing, max(top + 0.018 - p.y, p.y - base));
  let entablature = abs(p.y - top) - 0.018;
  let rail = abs(p.y - base) - 0.013;
  let silhouette = mask(min(min(capital, shaft), min(entablature, rail)), aa);
  let flute = 0.33 + 0.47 * smoothstep(-0.11, 0.099, side * bay) + 0.12 * cos(bay * 113.0);
  return vec2f(silhouette, flute);
}

fn shade(uv: vec2f) -> vec4f {
  let t = time();
  let aa = 1.1 / resolution().y;
  let p = vec2f((uv.x - 0.5) * aspect(), uv.y);
  let energy = clamp(1.55 * bass() + 1.25 * rms(), 0.0, 1.0);
  let kick = max(onset(), exp(-phase() * 8.0) * energy * 0.52);
  let dusk = palette(0.0);
  let orchid = palette(0.2);
  let pink = palette(0.4);
  let peach = palette(0.6);
  let aqua = palette(0.8);
  let horizon = 0.586;
  let haze = exp(-3.6 * abs(p.y - horizon));
  let wave = 0.5 + 0.5 * sin(38.0 * p.y - 4.0 * t - 5.0 * p.x * p.x);
  var rgb = mix(dusk * 0.72, mix(orchid * 0.86, pink * 1.04, energy), haze);
  rgb += (0.11 + 0.25 * kick * wave) * peach * exp(-2.6 * length(p - vec2f(0.0, 0.54)));
  let corona = abs(length(p - vec2f(0.0, 0.318)) - (0.204 + 0.032 * energy));
  rgb += peach * exp(-corona * 29.0) * (0.23 + 0.56 * kick);
  rgb += peach * mask(corona - 0.002, aa) * (0.28 + 0.30 * energy);

  if (p.y > horizon) {
    let depth = p.y - horizon;
    let z = 0.34 / (depth + 0.027);
    let tile = vec2f(p.x * z * 5.2, z - t * 0.43);
    let cellsPerPixel = aa * vec2f(5.2 * z * (1.0 + abs(p.x) * z / 0.34), z * z / 0.34);
    let detail = 1.0 - smoothstep(0.08, 0.48, max(cellsPerPixel.x, cellsPerPixel.y));
    let parity = mix(0.5, fract((floor(tile.x) + floor(tile.y)) * 0.5) * 2.0, detail);
    let darkTile = mix(dusk * 0.62, orchid * 0.85, energy);
    let lightTile = mix(vec3f(0.37, 0.18, 0.45), aqua * 1.02, energy);
    let floorColor = mix(darkTile, lightTile, parity);
    rgb = mix(rgb, floorColor, smoothstep(0.002, 0.075, depth));
    let reflection = exp(-7.6 * abs(p.x) - depth * 1.4);
    rgb += (0.11 + 0.26 * kick) * reflection * peach;
  }

  let arch = arcade(p, select(-1.0, 1.0, p.x > 0.0), aa);
  let plaster = mix(vec3f(0.095, 0.063, 0.16), vec3f(0.69, 0.35, 0.53), arch.y);
  rgb = mix(rgb, plaster + aqua * (0.15 * energy * arch.y), arch.x);

  let wind = 0.016 * sin(t * 0.77) + 0.016 * kick;
  let left = palm((p - vec2f(-0.58, 0.374)) / 0.93, aa, wind);
  let right = palm(vec2f(-1.0, 1.0) * (p - vec2f(0.60, 0.307)) / 1.16, aa, -wind);
  let far = palm(vec2f(-1.0, 1.0) * (p - vec2f(0.34, 0.458)) / 0.54, aa * 1.6, wind);
  rgb = mix(rgb, dusk * 0.64, max(max(left, right), far * 0.83));

  let bob = 0.025 * sin(0.73 * t) + 0.020 * energy;
  let plinth = ellipse(p - vec2f(0.0, 0.753), vec2f(0.184, 0.029));
  rgb *= 1.0 - 0.58 * exp(-65.0 * max(plinth, 0.0));
  let base = rect(p - vec2f(0.0, 0.728), vec2f(0.149, 0.024));
  let top = ellipse(p - vec2f(0.0, 0.705), vec2f(0.153, 0.021));
  rgb = mix(rgb, vec3f(0.27, 0.15, 0.35) + orchid * energy * 0.36, mask(base, aa));
  rgb = mix(rgb, vec3f(0.66, 0.42, 0.62) + aqua * energy * 0.48, mask(top, aa));

  let bustPoint = p - vec2f(0.022 * sin(t * 0.47), 0.397 - bob);
  if (abs(bustPoint.x) < 0.215 && abs(bustPoint.y - 0.020) < 0.247) {
    let bust = marble(bustPoint, aa, energy);
    rgb = mix(rgb, bust.rgb, bust.a);
  }
  rgb *= 1.0 - 0.41 * dot(uv - vec2f(0.5), uv - vec2f(0.5));
  return vec4f(rgb, 1.0);
}
