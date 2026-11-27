// Render pass for agy-media-life: crisp retro pixel cells in Life mode, 3D embossed smooth
// organisms in Lenia mode, coloured by inherited video RGB + OKLab palette + 4x4 Bayer dither.

struct Cell {
  state: vec4f,
  color: vec4f,
};

struct Draw {
  size: vec2f, pal_n: f32, glow: f32,
  kick: f32, rms: f32, shift: f32, relief: f32,
  lenia: f32, gap: f32, under: f32, pal_mix: f32,
  colour: f32, dither: f32, beat: f32, bass: f32,
  pal: array<vec4f, 8>,
};

@group(0) @binding(0) var<uniform> dr: Draw;
@group(0) @binding(1) var<storage, read> cells: array<Cell>;
@group(0) @binding(2) var smp: sampler;
@group(0) @binding(3) var tpic: texture_2d<f32>;

fn cell_at(x: i32, y: i32) -> Cell {
  let w = i32(dr.size.x);
  let h = i32(dr.size.y);
  return cells[u32(((y % h + h) % h) * w + ((x % w + w) % w))];
}

fn smp_cell(q: vec2f) -> Cell {
  let p = q - 0.5;
  let i = vec2i(floor(p));
  let f = p - floor(p);
  let c00 = cell_at(i.x, i.y);
  let c10 = cell_at(i.x + 1, i.y);
  let c01 = cell_at(i.x, i.y + 1);
  let c11 = cell_at(i.x + 1, i.y + 1);
  var out: Cell;
  out.state = mix(mix(c00.state, c10.state, f.x), mix(c01.state, c11.state, f.x), f.y);
  out.color = mix(mix(c00.color, c10.color, f.x), mix(c01.color, c11.color, f.x), f.y);
  return out;
}

fn lab2lin(c: vec3f) -> vec3f {
  let l_ = c.x + 0.3963377774 * c.y + 0.2158037573 * c.z;
  let m_ = c.x - 0.1055613458 * c.y - 0.0638541728 * c.z;
  let s_ = c.x - 0.0894841775 * c.y - 1.291485548 * c.z;
  let l = l_ * l_ * l_;
  let m = m_ * m_ * m_;
  let s = s_ * s_ * s_;
  return max(vec3f(0.0), vec3f(
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ));
}

fn pal(x: f32) -> vec3f {
  let n = max(i32(dr.pal_n), 1);
  let f = clamp(x, 0.0, 1.0) * f32(n - 1);
  let i = min(i32(floor(f)), n - 1);
  let j = min(i + 1, n - 1);
  return lab2lin(mix(dr.pal[i].xyz, dr.pal[j].xyz, f - f32(i)));
}

fn bayer4(p: vec2i) -> f32 {
  let x = p.x & 3;
  let y = p.y & 3;
  let idx = y * 4 + x;
  var m = array<f32, 16>(
    0.0, 8.0, 2.0, 10.0,
    12.0, 4.0, 14.0, 6.0,
    3.0, 11.0, 1.0, 9.0,
    15.0, 7.0, 13.0, 5.0
  );
  return (m[idx] + 0.5) / 16.0 - 0.5;
}

fn style_color(vid: vec3f, age: f32, bayer: f32) -> vec3f {
  let lum = clamp(dot(vid, vec3f(0.2126, 0.7152, 0.0722)), 0.0, 1.5);
  let ageNorm = 1.0 - exp(-age / 7.0);
  let px = clamp(0.18 + lum * 0.55 + (1.0 - ageNorm) * 0.32 + bayer * dr.dither * 0.22 + 0.14 * sin(dr.shift * 6.2832), 0.05, 1.0);
  let pc = pal(px);
  // Subtle Bayer quantize on video colour when dither > 0
  let levels = 5.0;
  let qvid = clamp(floor(vid * levels + bayer * dr.dither + 0.5) / levels, vec3f(0.0), vec3f(2.0));
  let vcol = mix(vid, qvid, dr.dither * 0.65);
  if (dr.colour < 0.5) {
    return mix(vcol, pc, dr.pal_mix * 0.35 * (1.0 - ageNorm));
  } else if (dr.colour < 1.5) {
    return mix(vcol, pc, dr.pal_mix * (0.28 + 0.52 * (1.0 - ageNorm)));
  }
  return pc * (0.5 + 0.9 * sqrt(clamp(lum * 1.4, 0.05, 1.2)));
}

@fragment fn fs_draw(v: VOut) -> @location(0) vec4f {
  // Subtle onset horizontal RGB pixel shift
  let split = dr.kick * 0.0045;
  let q = v.uv * dr.size;
  let iq = vec2i(floor(q));
  let b = bayer4(iq);

  let picR = textureSampleLevel(tpic, smp, clamp(v.uv + vec2f(split, 0.0), vec2f(0.0), vec2f(1.0)), 0.0).r;
  let picG = textureSampleLevel(tpic, smp, v.uv, 0.0).g;
  let picB = textureSampleLevel(tpic, smp, clamp(v.uv - vec2f(split, 0.0), vec2f(0.0), vec2f(1.0)), 0.0).b;
  let pic = vec3f(picR, picG, picB);

  let gain = dr.glow * (0.76 + 0.44 * dr.rms + 0.52 * dr.kick + 0.2 * dr.beat);
  let underAmt = dr.under * (0.7 + 0.45 * dr.beat + 0.35 * dr.bass);

  if (dr.lenia < 0.5) {
    let c = cell_at(iq.x, iq.y);
    let cR = cell_at(iq.x + select(0, 1, dr.kick > 0.35), iq.y);
    let cB = cell_at(iq.x - select(0, 1, dr.kick > 0.35), iq.y);

    let f = fract(q) - 0.5;
    let half = 0.5 - dr.gap * 0.5;
    let d = length(max(abs(f) - vec2f(max(0.05, half - 0.14)), vec2f(0.0))) - 0.14;
    let aa = dr.size.y / 1080.0 * 1.4;
    let mask = smoothstep(aa, -aa, d);

    let vid = vec3f(
      mix(c.color.r, cR.color.r, dr.kick * 0.6),
      c.color.g,
      mix(c.color.b, cB.color.b, dr.kick * 0.6),
    );
    let baseCol = style_color(vid, c.state.y, b);
    var col = pic * underAmt;

    if (c.state.x > 0.5) {
      let young = exp(-c.state.y * 0.32);
      let cellCol = baseCol * (0.85 + 0.65 * young + 0.25 * dr.bass);
      col = mix(col, cellCol, mask);
    } else {
      let trailCol = mix(vid, pal(0.28 + 0.15 * b), dr.pal_mix * 0.6 + 0.2);
      col += trailCol * c.state.z * 0.55 * mask;
    }

    // Newborn & onset flash rim + subtle dark pixel grid
    col += mix(pal(0.95), vid * 1.4, 0.4) * c.state.w * (0.35 + 0.8 * dr.kick) * mask;
    col += pal(0.08) * 0.03 * (1.0 - mask);
    return vec4f(col * gain, 1.0);
  }

  // Lenia mode: smooth bilinear video-coloured organisms with 3D gradient emboss & specular glint
  let s = smp_cell(q);
  let a = s.state.x;
  let gx = smp_cell(q + vec2f(1.0, 0.0)).state.x - smp_cell(q - vec2f(1.0, 0.0)).state.x;
  let gy = smp_cell(q + vec2f(0.0, 1.0)).state.x - smp_cell(q - vec2f(0.0, 1.0)).state.x;
  let n = normalize(vec3f(-gx * dr.relief, -gy * dr.relief, 0.28));
  let lit = max(dot(n, normalize(vec3f(-0.45, -0.55, 0.65))), 0.0);
  let spec = pow(max(dot(n, normalize(vec3f(-0.2, -0.3, 1.0))), 0.0), 18.0);

  let body = smoothstep(0.04, 0.68, a);
  let cellCol = style_color(s.color.rgb, s.state.y, b);
  var col = pic * underAmt * (1.0 - body * 0.6);
  col += cellCol * body * (0.48 + 0.88 * lit + 0.25 * dr.bass);
  col += mix(pal(1.0), s.color.rgb * 1.5, 0.4) * spec * body * (0.55 + 0.5 * dr.kick);
  col += mix(s.color.rgb, pal(0.32), 0.45) * s.state.z * (1.0 - body) * 0.45;
  col += pal(0.95) * s.state.w * body * (0.4 + 0.65 * dr.kick);
  col += pal(0.05) * 0.025;
  return vec4f(col * gain, 1.0);
}
