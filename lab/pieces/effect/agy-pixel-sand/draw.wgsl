// Render pass for agy-pixel-sand: crisp pixel-art sand grains, glowing fracture sparks,
// falling streak trails, and a dark Bayer-dithered ghost of the picture inside crumbled voids.

struct Cell {
  state: vec4f,
  color: vec4f,
};

struct Draw {
  size: vec2f, pal_n: f32, glow: f32,
  kick: f32, rms: f32, shift: f32, under: f32,
  trail: f32, pal_mix: f32, dither: f32, beat: f32,
  bass: f32, highs: f32, _p0: f32, _p1: f32,
  pal: array<vec4f, 8>,
};

@group(0) @binding(0) var<uniform> dr: Draw;
@group(0) @binding(1) var<storage, read> cells: array<Cell>;
@group(0) @binding(2) var smp: sampler;
@group(0) @binding(3) var tpic: texture_2d<f32>;

fn cell_at(x: i32, y: i32) -> Cell {
  let w = i32(dr.size.x);
  let h = i32(dr.size.y);
  let cx = clamp(x, 0, w - 1);
  let cy = clamp(y, 0, h - 1);
  return cells[u32(cy * w + cx)];
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
  var m = array<f32, 16>(
    0.0, 8.0, 2.0, 10.0,
    12.0, 4.0, 14.0, 6.0,
    3.0, 11.0, 1.0, 9.0,
    15.0, 7.0, 13.0, 5.0
  );
  return (m[y * 4 + x] + 0.5) / 16.0 - 0.5;
}

fn quant_dither(c: vec3f, b: f32) -> vec3f {
  let lv = 6.0;
  let q = clamp(floor(c * lv + b * dr.dither + 0.5) / lv, vec3f(0.0), vec3f(2.0));
  return mix(c, q, dr.dither * 0.65);
}

@fragment fn fs_draw(v: VOut) -> @location(0) vec4f {
  let q = v.uv * dr.size;
  let iq = vec2i(floor(q));
  let f = fract(q);
  let b = bayer4(iq);

  let c = cell_at(iq.x, iq.y);
  let kind = c.state.x;

  // Pixel-snapped chromatic onset pop
  let shiftPx = select(0, 1, dr.kick > 0.35);
  let cR = cell_at(iq.x + shiftPx, iq.y);
  let cB = cell_at(iq.x - shiftPx, iq.y);
  let pic = textureSampleLevel(tpic, smp, (vec2f(iq) + 0.5) / dr.size, 0.0).rgb;
  let lum = clamp(dot(c.color.rgb, vec3f(0.2126, 0.7152, 0.0722)), 0.0, 1.5);
  let palCol = pal(clamp(0.15 + lum * 0.65 + b * dr.dither * 0.2 + 0.14 * sin(dr.shift * 6.2832), 0.04, 1.0));
  let sparkCol = pal(clamp(0.85 + 0.15 * b, 0.0, 1.0));

  // Crisp grain micro-bevel so individual sand grains read tactilely
  let edgeDist = max(abs(f.x - 0.5), abs(f.y - 0.5));
  let bevel = 1.0 - smoothstep(0.36, 0.5, edgeDist) * 0.26;
  let topLight = 1.0 + (0.5 - f.y) * 0.18;

  var col = vec3f(0.0);

  if (kind >= 1.5) {
    // Loose falling sand grain: tactile bevelled pixel carrying its fractured RGB colour
    let rawGrain = vec3f(
      mix(c.color.r, cR.color.r, dr.kick * 0.55),
      c.color.g,
      mix(c.color.b, cB.color.b, dr.kick * 0.55),
    );
    let styled = mix(quant_dither(rawGrain, b), palCol, dr.pal_mix * 0.42);
    col = styled * (1.05 + 0.28 * dr.bass) * bevel * topLight;
    // Hot palette fracture spark when freshly broken loose
    col += sparkCol * c.state.w * (0.45 + 0.85 * dr.kick);
  } else if (kind >= 0.5) {
    // Pinned intact picture pixel: clean dithered image waiting to fracture
    let styled = mix(quant_dither(c.color.rgb, b), palCol, dr.pal_mix * 0.22);
    col = styled * (0.94 + 0.16 * dr.beat) * (0.92 + 0.08 * bevel);
    // Subtle fracture warning shimmer along high-edge ledges on bass hits
    col += sparkCol * c.color.w * dr.kick * 0.16;
  } else {
    // Empty void: dark dithered ghost of the picture + glowing falling-grain streaks
    let ghostLum = dot(pic, vec3f(0.2126, 0.7152, 0.0722));
    let ghostPal = pal(clamp(0.06 + ghostLum * 0.45 + b * 0.25, 0.02, 0.85));
    let ghost = mix(pic * 0.8, ghostPal * (0.35 + 0.85 * ghostLum), 0.45 + dr.pal_mix * 0.45);
    col = ghost * dr.under * (0.75 + 0.45 * dr.beat);
    // Falling sand trail streaks in negative space
    let trailCol = mix(c.color.rgb, palCol, 0.4 + dr.pal_mix * 0.4);
    col += trailCol * c.state.z * dr.trail * (0.55 + 0.5 * dr.bass);
    col += pal(0.04) * 0.03;
  }

  let gain = dr.glow * (0.78 + 0.42 * dr.rms + 0.5 * dr.kick + 0.2 * dr.beat);
  return vec4f(col * gain, 1.0);
}
