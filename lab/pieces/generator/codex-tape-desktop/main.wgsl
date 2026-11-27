// Packed 4 by 6 glyphs, in alphabetic order. Index 0 is a space.
const GLYPHS = array<u32, 27>(
  0u, 0x99f996u, 0x799797u, 0xe1111eu, 0x799997u, 0xf1171fu,
  0x11171fu, 0xe99d1eu, 0x999f99u, 0x722227u, 0x69888cu, 0x953359u,
  0xf11111u, 0x999ff9u, 0x9ddbb9u, 0x699996u, 0x117997u, 0xed9996u,
  0x957997u, 0x78861eu, 0x66666fu, 0x699999u, 0x669999u, 0x9ff999u,
  0x996699u, 0x666699u, 0xf1248fu,
);
const LABEL_PLAYER = array<u32, 12>(20u, 1u, 16u, 5u, 0u, 4u, 5u, 3u, 11u, 0u, 0u, 0u);
const LABEL_SUNSET = array<u32, 12>(19u, 21u, 14u, 19u, 5u, 20u, 0u, 3u, 1u, 13u, 0u, 0u);
const LABEL_START = array<u32, 12>(19u, 20u, 1u, 18u, 20u, 0u, 0u, 0u, 0u, 0u, 0u, 0u);
const LABEL_FOLDER = array<u32, 12>(20u, 1u, 16u, 5u, 19u, 0u, 0u, 0u, 0u, 0u, 0u, 0u);
const LABEL_FILES = array<u32, 12>(6u, 9u, 12u, 5u, 19u, 0u, 0u, 0u, 0u, 0u, 0u, 0u);
const LABEL_ONSET = array<u32, 12>(19u, 9u, 7u, 14u, 1u, 12u, 0u, 12u, 15u, 3u, 11u, 0u);
const LABEL_STATUS = array<u32, 12>(19u, 9u, 4u, 5u, 0u, 1u, 0u, 0u, 0u, 0u, 0u, 0u);
const LABEL_ONLINE = array<u32, 12>(19u, 9u, 4u, 5u, 0u, 2u, 0u, 0u, 0u, 0u, 0u, 0u);
const LABEL_MENU = array<u32, 12>(6u, 9u, 12u, 5u, 0u, 22u, 9u, 5u, 23u, 0u, 0u, 0u);
const LABEL_CLOCK = array<u32, 12>(16u, 13u, 0u, 0u, 0u, 0u, 0u, 0u, 0u, 0u, 0u, 0u);
const LABEL_NOTICE = array<u32, 12>(14u, 5u, 23u, 0u, 19u, 9u, 7u, 14u, 1u, 12u, 0u, 0u);

const SILVER = vec3f(0.56, 0.53, 0.63);
const INK = vec3f(0.031, 0.018, 0.062);
const WHITE = vec3f(0.96, 0.94, 1.0);

fn inside(p: vec2f, size: vec2f) -> bool {
  return all(p >= vec2f(0.0)) && all(p < size);
}

fn label(p: vec2f, letters: array<u32, 12>) -> bool {
  let q = vec2i(floor(p));
  if (!inside(p, vec2f(60.0, 6.0)) || q.x % 5 == 4) { return false; }
  return ((GLYPHS[letters[q.x / 5]] >> u32(q.y * 4 + q.x % 5)) & 1u) == 1u;
}

fn bevel(p: vec2f, size: vec2f, surface: vec3f, raised: bool) -> vec3f {
  let near = min(p.x, p.y);
  let far = min(size.x - p.x, size.y - p.y);
  if (near < 2.0) { return select(INK, WHITE, raised); }
  if (far < 2.0) { return select(WHITE, INK, raised); }
  if (far < 4.0 && raised) { return vec3f(0.24, 0.20, 0.29); }
  return surface;
}

fn windowFrame(p: vec2f, size: vec2f, title: array<u32, 12>, focused: bool) -> vec3f {
  var col = bevel(p, size, SILVER, true);
  let barPos = p - vec2f(4.0, 4.0);
  if (inside(barPos, vec2f(size.x - 8.0, 22.0))) {
    let blue = mix(vec3f(0.042, 0.025, 0.31), vec3f(0.15, 0.15, 0.66), barPos.x / size.x);
    col = select(vec3f(0.25, 0.22, 0.35), blue, focused);
    if (inside(barPos - vec2f(5.0, 6.0), vec2f(10.0, 10.0))) {
      col = vec3f(0.47, 0.91, 0.86);
    }
    if (label((barPos - vec2f(21.0, 5.0)) * 0.5, title)) { col = WHITE; }
    let control = barPos - vec2f(size.x - 27.0, 4.0);
    if (inside(control, vec2f(14.0, 14.0))) {
      col = bevel(control, vec2f(14.0), SILVER, true);
      let m = abs(control - vec2f(7.0));
      if (max(m.x, m.y) < 4.1 && abs(m.x - m.y) < 1.15) { col = INK; }
    }
  }
  return col;
}

fn wallpaper(p: vec2f, energy: f32, pink: vec3f, aqua: vec3f) -> vec3f {
  let q = (p - vec2f(358.0, 167.0)) / 300.0;
  let curl = sin(8.3 * length(q * vec2f(0.66, 1.16)) - time() * 0.56 + q.x * 1.67);
  let vignette = exp(-dot(q, q) * 0.57);
  let calm = mix(vec3f(0.025, 0.25, 0.27), vec3f(0.13, 0.045, 0.24), 0.5 + 0.5 * curl);
  let hot = mix(pink * 0.78, aqua * 0.86, 0.5 + 0.5 * curl);
  let checker = fract((floor(p.x / 18.0) + floor(p.y / 18.0)) * 0.5);
  return mix(calm, hot, energy * 0.88) * (0.40 + 0.50 * vignette + 0.16 * checker);
}

fn deck(p: vec2f, energy: f32, pink: vec3f, aqua: vec3f, online: bool) -> vec3f {
  let size = vec2f(330.0, 201.0);
  var col = windowFrame(p, size, LABEL_PLAYER, !online);
  if (label((p - vec2f(12.0, 31.0)) * 0.67, LABEL_MENU)) { col = INK; }
  let scope = p - vec2f(12.0, 47.0);
  if (inside(scope, vec2f(306.0, 111.0))) {
    col = bevel(scope, vec2f(306.0, 111.0), vec3f(0.028, 0.015, 0.068), false);
    if (inside(scope - vec2f(5.0), vec2f(296.0, 100.0))) {
      if (fract(scope.x / 18.5) < 0.055 || fract(scope.y / 10.0) < 0.10) { col += vec3f(0.018, 0.105, 0.110); }
      let column = floor((scope.x - 5.0) / 18.5);
      let i = i32(clamp(column, 0.0, 15.0));
      let height = clamp(0.085 + 1.10 * band(i) + energy * 0.085 * sin(f32(i) * 0.9 + time() * 3.4), 0.045, 0.98);
      let cell = (scope - vec2f(5.0)) / vec2f(18.5, 100.0);
      if (fract(cell.x) < 0.82 && fract(cell.y * 12.0) > 0.19 && 1.0 - cell.y < height) {
        col = mix(pink, aqua, cell.y) * (0.88 + energy * 0.43);
      }
    }
  }
  let controls = p - vec2f(12.0, 166.0);
  if (inside(controls, vec2f(84.0, 23.0))) {
    let button = vec2f(controls.x - floor(controls.x / 28.0) * 28.0, controls.y);
    if (button.x < 26.0) {
      col = bevel(button, vec2f(26.0, 23.0), SILVER, true);
      if (inside(button - vec2f(8.0, 6.0), vec2f(10.0, 11.0))) {
        let x = button.x - 8.0;
        let y = abs(button.y - 11.5);
        if ((controls.x < 28.0 && y < (10.0 - x) * 0.55) ||
            (controls.x >= 28.0 && controls.x < 56.0 && (x < 3.0 || x > 7.0)) ||
            controls.x >= 56.0) { col = INK; }
      }
    }
  }
  if (length(p - vec2f(112.0, 177.0)) < 4.2) { col = aqua * (0.5 + energy * 1.07); }
  if (label((p - vec2f(235.0, 173.0)) * 0.6, LABEL_STATUS)) { col = INK; }
  return col;
}

fn monitor(p: vec2f, size: vec2f, energy: f32, pink: vec3f, aqua: vec3f) -> vec3f {
  var col = windowFrame(p, size, LABEL_SUNSET, true);
  let q = (p - vec2f(9.0, 32.0)) / (size - vec2f(18.0, 58.0));
  if (inside(q, vec2f(1.0))) {
    let sky = mix(vec3f(0.063, 0.025, 0.20), pink * (0.63 + energy * 0.62), q.y);
    let s = (q - vec2f(0.5 + 0.07 * sin(time() * 0.47), 0.52)) * vec2f(1.72, 1.0);
    let bands = fract(s.y * (22.0 - 3.0 * energy));
    let disc = length(s) < 0.348 && (s.y < -0.016 || bands > 0.33 + 0.15 * s.y);
    col = select(sky, mix(vec3f(1.05, 0.49, 0.16), pink, q.y), disc);
    if (q.y > 0.76) {
      let z = 1.0 / (q.y - 0.76 + 0.055);
      let g = abs(fract(vec2f((q.x - 0.5) * z * 2.0, z * 0.52 + time() * 0.8) + 0.5) - 0.5);
      col = vec3f(0.069, 0.024, 0.17) + aqua * (0.44 + energy * 0.58) * (1.0 - smoothstep(0.022, 0.09, min(g.x, g.y)));
    }
  }
  if (label((p - vec2f(12.0, size.y - 18.0)) * 0.65, LABEL_ONLINE)) { col = INK; }
  return col;
}

fn shade(uv: vec2f) -> vec4f {
  let screen = vec2f(aspect(), 1.0);
  let scale = min(screen.x / 640.0, 1.0 / 360.0);
  let p = floor((uv - 0.5) * screen / scale + vec2f(320.0, 180.0));
  let energy = clamp(1.52 * bass() + 1.25 * rms(), 0.0, 1.0);
  let pink = palette(0.4);
  let aqua = palette(0.8);
  let online = p_mode() >= 0.5;
  var rgb = wallpaper(p, energy, pink, aqua);

  if (inside(p - vec2f(26.0, 34.0), vec2f(38.0, 26.0))) {
    let folder = p - vec2f(26.0, 34.0);
    if (folder.y >= 6.0 || folder.x < 17.0) {
      rgb = bevel(folder - vec2f(0.0, 5.0), vec2f(38.0, 21.0), vec3f(0.94, 0.62, 0.24), true);
    }
  }
  if (label((p - vec2f(26.0, 65.0)) * 0.66, LABEL_FOLDER)) { rgb = WHITE; }
  if (inside(p - vec2f(30.0, 91.0), vec2f(28.0, 23.0))) {
    rgb = bevel(p - vec2f(30.0, 91.0), vec2f(28.0, 23.0), SILVER, true);
    if (inside(p - vec2f(35.0, 95.0), vec2f(18.0, 13.0))) { rgb = aqua * 0.61; }
  }
  if (label((p - vec2f(26.0, 122.0)) * 0.66, LABEL_FILES)) { rgb = WHITE; }

  let drift = vec2f(7.0 * sin(time() * 0.48), 5.0 * sin(time() * 0.39)) - vec2f(0.0, energy * 8.0);
  let player = floor(p - vec2f(109.0, 64.0) - drift);
  if (inside(player - vec2f(7.0, 9.0), vec2f(330.0, 201.0))) { rgb *= 0.57; }
  if (inside(player, vec2f(330.0, 201.0))) { rgb = deck(player, energy, pink, aqua, online); }

  let arrival = max(p_arrival(), onset() * 0.6);
  let popup = floor(p - vec2f(432.0, 114.0) - vec2f(0.0, 24.0 * (1.0 - arrival)));
  if (online) {
    let cam = floor(p - vec2f(351.0, 133.0) + drift * 0.6);
    if (inside(cam - vec2f(7.0, 8.0), vec2f(252.0, 160.0))) { rgb *= 0.57; }
    if (inside(cam, vec2f(252.0, 160.0))) { rgb = monitor(cam, vec2f(252.0, 160.0), energy, pink, aqua); }
  } else if (arrival > 0.22) {
    if (inside(popup - vec2f(6.0, 7.0), vec2f(161.0, 70.0))) { rgb *= 0.6; }
    if (inside(popup, vec2f(161.0, 70.0))) {
      rgb = windowFrame(popup, vec2f(161.0, 70.0), LABEL_NOTICE, true);
      if (length(popup - vec2f(19.0, 46.0)) < 7.0) { rgb = aqua * 0.73; }
      if (label((popup - vec2f(33.0, 41.0)) * 0.52, LABEL_ONSET)) { rgb = INK; }
    }
  }

  let limit = vec2f(aspect(), 1.0) / scale;
  let bottom = 180.0 + limit.y * 0.5;
  let left = 320.0 - limit.x * 0.5;
  let right = left + limit.x;
  if (p.y >= bottom - 26.0) {
    rgb = select(SILVER, WHITE, p.y < bottom - 24.0);
    let start = p - vec2f(left + 5.0, bottom - 21.0);
    if (inside(start, vec2f(68.0, 18.0))) {
      rgb = bevel(start, vec2f(68.0, 18.0), SILVER, true);
      let mark = start - vec2f(7.0, 5.0);
      if (inside(mark, vec2f(9.0, 9.0)) && mark.x != 4.0 && mark.y != 4.0) { rgb = mix(pink, aqua, mark.x / 9.0); }
      if (label((start - vec2f(21.0, 4.0)) * 0.61, LABEL_START)) { rgb = INK; }
    }
    let tray = p - vec2f(right - 60.0, bottom - 21.0);
    if (inside(tray, vec2f(55.0, 18.0))) {
      rgb = bevel(tray, vec2f(55.0, 18.0), SILVER, false);
      if (length(tray - vec2f(13.0, 9.0)) < 3.0) { rgb = mix(pink, aqua, energy); }
      if (label((tray - vec2f(26.0, 5.0)) * 0.72, LABEL_CLOCK)) { rgb = INK; }
    }
  }

  let cursor = p - floor(vec2f(447.0 + 62.0 * sin(time() * 0.37), 254.0 + 30.0 * cos(time() * 0.43)));
  if (inside(cursor, vec2f(15.0, 21.0))) {
    let edge = max(cursor.x - cursor.y * 0.78, cursor.y - min(19.0, 20.0 - cursor.x * 0.54));
    if (edge <= 0.0) { rgb = select(INK, WHITE, cursor.x > 1.0 && edge < -1.8); }
  }
  let scan = 0.968 + 0.032 * cos(uv.y * resolution().y * 3.14159);
  rgb *= scan * (1.0 - 0.22 * dot(uv - 0.5, uv - 0.5));
  return vec4f(rgb, 1.0);
}
