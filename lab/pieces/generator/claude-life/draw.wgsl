// Colour pass. Life: each cell a rounded square, newborns at the bright end of the palette cooling toward the
// low end with age, dead cells leaving a fading afterglow. Lenia: the smooth field, embossed by its gradient,
// coloured by how long each spot has been alive. Seed stamps flash white.

struct Draw {
  size: vec2f, pal_n: f32, glow: f32,
  kick: f32, rms: f32, shift: f32, relief: f32,
  lenia: f32, gap: f32, ages: f32, trail: f32,
  pal: array<vec4f, 8>, // OKLab stops
};
@group(0) @binding(0) var<uniform> dr: Draw;
@group(0) @binding(1) var<storage, read> cells: array<vec4f>;

fn cell(x: i32, y: i32) -> vec4f {
  let w = i32(dr.size.x);
  let h = i32(dr.size.y);
  return cells[u32(((y % h + h) % h) * w + ((x % w + w) % w))];
}

fn smp(q: vec2f) -> vec4f {
  let p = q - 0.5;
  let i = vec2i(floor(p));
  let f = p - floor(p);
  return mix(mix(cell(i.x, i.y), cell(i.x + 1, i.y), f.x), mix(cell(i.x, i.y + 1), cell(i.x + 1, i.y + 1), f.x), f.y);
}

fn lab2lin(c: vec3f) -> vec3f {
  let l_ = c.x + 0.3963377774 * c.y + 0.2158037573 * c.z;
  let m_ = c.x - 0.1055613458 * c.y - 0.0638541728 * c.z;
  let s_ = c.x - 0.0894841775 * c.y - 1.291485548 * c.z;
  let l = l_ * l_ * l_;
  let m = m_ * m_ * m_;
  let s = s_ * s_ * s_;
  return max(vec3f(0.0), vec3f(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s));
}

fn pal(x: f32) -> vec3f {
  let n = max(i32(dr.pal_n), 1);
  let f = clamp(x, 0.0, 1.0) * f32(n - 1);
  let i = min(i32(floor(f)), n - 1);
  let j = min(i + 1, n - 1);
  return lab2lin(mix(dr.pal[i].xyz, dr.pal[j].xyz, f - f32(i)));
}

// age 0 -> 1 (newborn, bright end) down to 0.2 (old); the palette drifts with `shift`, ping-ponged so there is no seam
fn agecol(age: f32) -> vec3f {
  let a = 1.0 - exp(-age / max(dr.ages, 0.1));
  let x = mix(1.0, 0.22, a);
  return pal(clamp(x + 0.3 * sin(dr.shift * 6.2832 + x * 3.0), 0.12, 1.0));
}

@fragment fn fs_draw(v: VOut) -> @location(0) vec4f {
  let q = v.uv * dr.size;
  let gain = dr.glow * (0.75 + 0.5 * dr.rms + 0.6 * dr.kick);
  if (dr.lenia < 0.5) {
    let c = cell(i32(floor(q.x)), i32(floor(q.y)));
    let f = fract(q) - 0.5;
    // rounded square, `gap` of the cell left dark between neighbours
    let half = 0.5 - dr.gap * 0.5;
    let d = length(max(abs(f) - vec2f(half - 0.18), vec2f(0.0))) - 0.18;
    let px = dr.size.y / 1080.0 * 1.5;
    let m = smoothstep(px, -px, d);
    var col = vec3f(0.0);
    if (c.x > 0.5) {
      let young = exp(-c.y / max(dr.ages * 0.25, 0.1));
      col = agecol(c.y) * (0.55 + 0.9 * young) * m;
    } else {
      col = pal(0.3) * c.z * dr.trail * m * 0.5;
    }
    col += pal(1.0) * c.w * m * 1.2;
    // faint grid so the board reads even when it is sparse
    col += pal(0.08) * 0.025 * (1.0 - m);
    return vec4f(col * gain, 1.0);
  }
  let s = smp(q);
  let a = s.x;
  let gx = smp(q + vec2f(1.0, 0.0)).x - smp(q - vec2f(1.0, 0.0)).x;
  let gy = smp(q + vec2f(0.0, 1.0)).x - smp(q - vec2f(0.0, 1.0)).x;
  let n = normalize(vec3f(-gx * dr.relief, -gy * dr.relief, 0.25));
  let lit = max(dot(n, normalize(vec3f(-0.5, -0.6, 0.6))), 0.0);
  let spec = pow(max(dot(n, normalize(vec3f(-0.25, -0.3, 1.0))), 0.0), 20.0);
  let body = smoothstep(0.03, 0.7, a);
  var col = agecol(s.y) * body * (0.35 + 0.9 * lit);
  col += pal(1.0) * spec * body * 0.6;
  col += pal(0.3) * s.z * (1.0 - body) * dr.trail * 0.4;
  col += pal(1.0) * s.w * body * 0.8;
  col += pal(0.05) * 0.03;
  return vec4f(col * gain, 1.0);
}
