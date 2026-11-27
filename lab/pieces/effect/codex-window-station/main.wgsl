// 640 by 360 virtual desktop. Window roles are tape, contact sheet and saver.
const TAPE = array<u32, 8>(20, 1, 16, 5, 0, 0, 0, 0);
const PROOF = array<u32, 8>(3, 15, 14, 20, 1, 3, 20, 0);
const SAVER = array<u32, 8>(19, 1, 22, 5, 18, 0, 0, 0);
const GLYPHS = array<u32, 27>(
  0u, 0x99f996u, 0x799797u, 0xe1111eu, 0x799997u, 0xf1171fu,
  0x11171fu, 0xe99d1eu, 0x999f99u, 0x722227u, 0x69888cu, 0x953359u,
  0xf11111u, 0x999ff9u, 0x9ddbb9u, 0x699996u, 0x117997u, 0xed9996u,
  0x957997u, 0x78861eu, 0x66666fu, 0x699999u, 0x669999u, 0x9ff999u,
  0x996699u, 0x666699u, 0xf1248fu,
);

struct Desk {
  shadow: vec3f,
  idle: vec3f,
  lit: vec3f,
  chrome: vec3f,
  signal: vec3f,
  accent: vec3f,
}

fn deskColors(mode: i32) -> Desk {
  switch mode {
    case 1: {
      return Desk(vec3f(0.084, 0.052, 0.032), vec3f(0.20, 0.127, 0.070), vec3f(0.93, 0.63, 0.32),
                  vec3f(0.55, 0.44, 0.30), vec3f(1.0, 0.58, 0.21), vec3f(0.36, 0.93, 0.72));
    }
    case 2: {
      return Desk(vec3f(0.018, 0.025, 0.062), vec3f(0.024, 0.065, 0.17), vec3f(0.09, 0.32, 0.77),
                  vec3f(0.089, 0.14, 0.25), vec3f(0.51, 1.0, 0.28), vec3f(0.29, 0.81, 1.0));
    }
    default: {
      return Desk(vec3f(0.048, 0.019, 0.082), vec3f(0.083, 0.050, 0.17), vec3f(0.61, 0.19, 0.50),
                  vec3f(0.38, 0.34, 0.49), vec3f(0.97, 0.39, 0.69), vec3f(0.29, 0.95, 0.84));
    }
  }
}

fn inside(p: vec2f, size: vec2f) -> bool {
  return all(p >= vec2f(0.0)) && all(p < size);
}

fn title(p: vec2f, role: i32) -> bool {
  if (!inside(p, vec2f(40.0, 6.0))) { return false; }
  let q = vec2u(p);
  if (q.x % 5u == 4u) { return false; }
  let i = q.x / 5u;
  let letter = select(select(TAPE[i], PROOF[i], role == 1), SAVER[i], role == 2);
  return ((GLYPHS[letter] >> (q.y * 4u + q.x % 5u)) & 1u) != 0u;
}

// Keep the fitted source's proportions in a viewport, cropping around its center.
fn cover(uv: vec2f, viewAspect: f32) -> vec2f {
  let ratio = viewAspect / aspect();
  return (uv - 0.5) * vec2f(min(ratio, 1.0), min(1.0 / ratio, 1.0)) + 0.5;
}

fn luma(color: vec3f) -> f32 {
  return dot(color, vec3f(0.2126, 0.7152, 0.0722));
}

fn tape(uv: vec2f, size: vec2f, heat: f32, hit: f32, d: Desk) -> vec3f {
  let line = floor(uv.y * size.y);
  let track = fract(time() * 0.28 + 0.23);
  let tear = 1.0 - smoothstep(0.008, 0.052, abs(uv.y - track));
  let sway = (0.004 + 0.050 * hit) * tear * sin(line * 0.79);
  let coords = cover(uv, size.x / size.y) + vec2f(sway, 0.0);
  let shift = vec2f(0.003 + 0.018 * (heat + tear * hit), 0.0);
  let main = tex_in(coords).rgb;
  let echo = tex_in(coords + shift).rgb;
  let rgb = vec3f(main.r, mix(main.g, echo.g, 0.32), echo.b);
  let scan = select(0.80, 1.0, fract(line * 0.5) < 0.5);
  return (rgb * scan + d.accent * tear * (0.024 + 0.12 * hit)) * (0.48 + 0.84 * heat);
}

fn contact(uv: vec2f, size: vec2f, heat: f32, hit: f32, d: Desk) -> vec3f {
  let columns = select(2.0, 3.0, size.x > 225.0);
  let cells = vec2f(columns, 2.0);
  let grid = uv * cells;
  let local = fract(grid);
  let margin = vec2f(3.0) / (size / cells);
  let index = floor(grid.x) + floor(grid.y) * columns;
  let selected = index == (bar() % (columns * 2.0));
  let border = mix(d.shadow, d.accent, select(0.24, 0.55 + 0.28 * hit, selected));
  if (!inside(local - margin, 1.0 - margin * 2.0)) { return border; }
  let tile = (local - margin) / (1.0 - margin * 2.0);
  let area = size / cells - 6.0;
  let coords = cover(tile, area.x / area.y);
  let zoom = 1.0 - 0.09 * index - select(0.0, 0.12 * hit, selected);
  let pan = vec2f(sin(index * 2.4), cos(index * 2.4)) * index * 0.024;
  let source = tex_in((coords - 0.5) * zoom + 0.5 + pan).rgb;
  let value = clamp(luma(source), 0.0, 1.0);
  let proof = mix(d.shadow, mix(d.signal, d.accent, index / 5.0), sqrt(value));
  return mix(source, proof, select(0.71, 0.16, selected)) * (0.50 + 0.90 * heat);
}

fn saver(uv: vec2f, size: vec2f, heat: f32, hit: f32, d: Desk) -> vec3f {
  let q = (uv - 0.5) * size / size.y;
  let radius = length(q);
  let angle = atan2(q.y, q.x + 0.00001) + time() * 0.37 + bass() * 0.22;
  let petal = abs(fract(angle * 0.955 + 0.5) - 0.5) * 1.0472;
  let ring = radius * (1.06 - heat * 0.26) + 0.033 * sin(radius * 17.0 - time() * 3.8) * hit;
  let axis = vec2f(cos(petal - 0.31), sin(petal - 0.31));
  let coords = clamp(vec2f(0.42 + 0.06 * sin(time() * 0.48), 0.49) + ring * axis, vec2f(0.02), vec2f(0.98));
  let source = tex_in(coords).rgb;
  let ripple = 0.5 + 0.5 * cos(radius * 43.0 - time() * 4.0 + heat * 3.0);
  let sheen = d.signal * pow(ripple, 7.0) * (0.022 + 0.11 * hit);
  return (mix(source, source.gbr, 0.21 + 0.17 * sin(angle * 6.0)) + sheen)
    * (0.50 + 0.91 * heat) * (1.0 - 0.42 * smoothstep(0.22, 0.78, radius));
}

fn panel(p: vec2f, size: vec2f, role: i32, focus: bool, heat: f32, hit: f32, d: Desk) -> vec3f {
  let bright = vec3f(0.78, 0.90, 0.94);
  let far = min(size.x - p.x, size.y - p.y);
  if (min(p.x, p.y) < 1.0) { return mix(d.chrome, bright, 0.62); }
  if (far < 2.0) { return d.shadow * 0.43; }
  if (p.y >= 3.0 && p.y < 19.0 && p.x >= 3.0 && p.x < size.x - 3.0) {
    let strip = mix(d.shadow, mix(d.idle, d.lit, heat), p.x / size.x);
    if (title((floor(p) - vec2f(18.0, 6.0)) / 1.5, role)) { return bright; }
    if (inside(p - vec2f(7.0, 8.0), vec2f(6.0))) { return mix(d.signal, d.accent, hit); }
    let button = p - vec2f(size.x - 17.0, 6.0);
    if (inside(button, vec2f(10.0))) {
      let xmark = abs(abs(button.x - 5.0) - abs(button.y - 5.0)) < 0.8;
      return select(d.chrome, d.shadow, xmark);
    }
    return mix(strip, d.accent, select(0.04, 0.12, focus));
  }
  let frame = size - vec2f(12.0, 37.0);
  let pos = p - vec2f(6.0, 23.0);
  if (inside(pos, frame)) {
    let uv = pos / frame;
    switch role {
      case 0: { return tape(uv, frame, heat, hit, d); }
      case 1: { return contact(uv, frame, heat, hit, d); }
      default: { return saver(uv, frame, heat, hit, d); }
    }
  }
  let meter = p - vec2f(8.0, size.y - 9.0);
  if (inside(meter, vec2f(size.x - 16.0, 4.0))) {
    let cell = meter.x / ((size.x - 16.0) / 16.0);
    let strength = band(i32(cell));
    return mix(d.shadow, mix(d.accent, d.signal, cell / 16.0),
      select(0.0, 0.28 + 0.72 * clamp(strength * 1.8, 0.0, 1.0), fract(cell) < 0.75));
  }
  return d.chrome * (0.59 + 0.50 * heat);
}

fn shade(uv: vec2f) -> vec4f {
  let desk = i32(p_desk());
  let d = deskColors(desk);
  let layout = i32(p_layout());
  let scale = min(aspect() / 640.0, 1.0 / 360.0);
  let p = (uv - 0.5) * vec2f(aspect(), 1.0) / scale + vec2f(320.0, 180.0);
  let beat = exp(-phase() * 6.0);
  let hit = clamp(onset() * 1.25 + bass() * beat * 0.94, 0.0, 1.0);
  let heat = clamp((rms() * 2.85 + bass() * (0.65 + 0.22 * beat) + hit * 0.27) * p_drive(), 0.0, 1.0);
  let q = (p - vec2f(270.0, 161.0)) / 260.0;
  let signal = 0.5 + 0.5 * sin(length(q) * 10.5 - time() * 0.64 + heat * 1.3);
  let grid = abs(fract(p / 24.0 + 0.5) - 0.5);
  var rgb = mix(d.idle * 0.44, d.lit, heat * (0.67 + 0.33 * signal));
  rgb *= 0.56 + 0.44 / (1.0 + dot(q, q));
  if (desk == 1) {
    let ruler = min(grid.x, grid.y) < 0.028 && max(grid.x, grid.y) < 0.15;
    rgb += d.signal * select(0.0, 0.19, ruler);
  } else if (desk == 2) {
    let sweep = abs(fract(p.y / 37.0 + time() * 0.34) - 0.5);
    rgb += d.accent * (0.06 + 0.08 * hit) * (1.0 - smoothstep(0.01, 0.12, sweep));
  } else {
    rgb *= select(1.0, 1.22, min(grid.x, grid.y) < 0.025);
  }

  let opening = clamp(0.22 + heat * 0.67 + hit * 0.68, 0.0, 1.0);
  let drift = vec2f(9.0 * sin(time() * 0.65), 5.0 * cos(time() * 0.91));
  var primary = vec2f(48.0, 43.0) + drift + vec2f(-13.0, -13.0) * heat;
  var mainSize = vec2f(367.0, 254.0);
  var secondary = vec2f(430.0, 38.0) - drift * 0.38;
  var sideSize = vec2f(174.0, 137.0);
  var floating = vec2f(407.0, 193.0) + drift * 0.64 - vec2f(34.0, 19.0) * hit;
  var popSize = vec2f(184.0, mix(69.0, 138.0, opening));
  if (layout == 1) {
    primary = vec2f(222.0, 37.0) - drift * 0.53 + vec2f(8.0, -12.0) * heat;
    mainSize = vec2f(378.0, 270.0);
    secondary = vec2f(36.0, 52.0) + drift * 0.42;
    sideSize = vec2f(172.0, 144.0);
    floating = vec2f(62.0, 203.0) - drift + vec2f(24.0, -25.0) * hit;
    popSize = vec2f(177.0, mix(69.0, 125.0, opening));
  }
  if (layout == 2) {
    primary = vec2f(100.0, 25.0) + drift * 0.52 + vec2f(-13.0, -6.0) * heat;
    mainSize = vec2f(444.0, 251.0);
    secondary = vec2f(39.0, 193.0) + drift * 0.55 - vec2f(6.0, 12.0) * heat;
    sideSize = vec2f(182.0, 123.0);
    floating = vec2f(411.0, 186.0) - drift * 0.38 + vec2f(15.0, -17.0) * hit;
    popSize = vec2f(183.0, mix(74.0, 140.0, opening));
  }

  // Resolve visibility first so a covered pixel only shades its topmost window.
  let a = p - floor(primary);
  let b = p - floor(secondary);
  let c = p - floor(floating);
  let cShadow = inside(c - vec2f(6.0, 8.0), popSize);
  let bShadow = inside(b - vec2f(6.0, 8.0), sideSize);
  let aShadow = inside(a - vec2f(6.0, 8.0), mainSize);
  if (inside(c, popSize)) {
    rgb = panel(c, popSize, (layout + 2) % 3, hit > 0.24, heat, hit, d);
  } else if (inside(b, sideSize)) {
    rgb = panel(b, sideSize, (layout + 1) % 3, false, heat, hit, d);
  } else if (inside(a, mainSize)) {
    rgb = panel(a, mainSize, layout, true, heat, hit, d) * select(1.0, 0.58, cShadow || bShadow);
  } else if (aShadow || bShadow || cShadow) {
    rgb *= 0.48;
  }

  let bottom = 180.0 + 0.5 / scale;
  let task = p.y - (bottom - 25.0);
  if (task >= 0.0) {
    rgb = select(d.chrome * (0.36 + 0.59 * heat), d.accent * 0.55, task < 1.5);
    let dock = vec2f(p.x - 26.0, task - 6.0);
    if (inside(dock, vec2f(60.0, 13.0))) {
      let cell = floor(dock.x / 20.0);
      let button = vec2f(dock.x % 20.0, dock.y);
      if (button.x < 16.0) {
        rgb = d.shadow * 0.74;
        if (inside(button - vec2f(3.0), vec2f(10.0, 7.0))) {
          rgb = select(d.accent * 0.39, d.signal * (0.79 + hit * 0.21), i32(cell) == layout);
        }
      }
    }
    let vu = vec2f(p.x - 514.0, task - 7.0);
    if (inside(vu, vec2f(100.0, 11.0))) {
      let cell = vu.x / 6.25;
      let level = clamp(band(i32(cell)) * 1.55 + hit * 0.14, 0.0, 1.0);
      rgb = select(d.shadow, mix(d.accent, d.signal, level), vu.y / 11.0 > 1.0 - level && fract(cell) < 0.72);
    }
  }

  let pointer = p - floor(floating + vec2f(39.0 + sin(time() * 0.48) * 24.0, -9.0));
  if (inside(pointer, vec2f(12.0, 16.0))) {
    let edge = min(pointer.y * 0.73 - pointer.x, 14.0 - pointer.y - pointer.x * 0.36);
    if (edge >= 0.0) { rgb = select(d.shadow, vec3f(0.93), edge > 1.25 && pointer.x > 0.9); }
  }
  return vec4f(rgb * (0.96 + 0.04 * cos(p.y * 3.14159)), 1.0);
}
