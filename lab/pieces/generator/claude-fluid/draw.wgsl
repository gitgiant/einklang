// Colour pass: the dye grid, upsampled bilinearly. Density sets opacity over a dark gradient
// from the palette's low end; the carried tag picks the colour; the density gradient shades it
// like lit smoke (light from above), and thick cores glow toward the top stop.

struct Draw {
  size: vec2f, pal_n: f32, glow: f32,
  gain: f32, kick: f32, shift: f32, bg: f32,
  light: f32, rms: f32, _a: f32, _b: f32,
  pal: array<vec4f, 8>, // OKLab stops
};
@group(0) @binding(0) var<uniform> dr: Draw;
@group(0) @binding(1) var<storage, read> dye: array<vec2f>;

fn cell(x: i32, y: i32) -> vec2f {
  let w = i32(dr.size.x);
  let h = i32(dr.size.y);
  return dye[u32(clamp(y, 0, h - 1) * w + clamp(x, 0, w - 1))];
}

fn samp(q: vec2f) -> vec2f {
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

fn tri(x: f32) -> f32 { return 1.0 - abs(fract(x * 0.5) * 2.0 - 1.0); }

@fragment fn fs_draw(v: VOut) -> @location(0) vec4f {
  let q = v.uv * dr.size;
  let d = samp(q);
  let dens = max(d.x, 0.0);
  let tag = clamp(d.y / max(d.x, 1e-4), 0.0, 1.0);
  let a = 1.0 - exp(-dens * dr.gain);
  // shading from the density gradient: a soft normal, lit from the upper left
  let e = 1.5;
  let gx = samp(q + vec2f(e, 0.0)).x - samp(q - vec2f(e, 0.0)).x;
  let gy = samp(q + vec2f(0.0, e)).x - samp(q - vec2f(0.0, e)).x;
  let n = normalize(vec3f(-gx * dr.gain, -gy * dr.gain, 0.6));
  let lit = mix(1.0, 0.55 + 0.75 * max(dot(n, normalize(vec3f(-0.4, -0.8, 0.5))), 0.0), dr.light);
  // palette position: the tag sweeps the upper stops (drifting), density lifts it toward the top
  let x = 0.3 + 0.55 * tri(tag + dr.shift) + 0.25 * smoothstep(0.5, 1.0, a);
  let smoke = pal(x) * lit * dr.glow * (0.85 + 0.3 * dr.rms + 0.5 * dr.kick);
  // the backdrop: darkest stop, a little lighter toward the floor where the nozzles are
  let bg = mix(pal(0.0), pal(0.12), smoothstep(0.2, 1.1, v.uv.y)) * dr.bg;
  var col = mix(bg, smoke, a);
  col += pal(1.0) * smoothstep(0.75, 1.0, a) * (0.25 + 0.6 * dr.kick) * dr.glow;
  return vec4f(col, 1.0);
}
