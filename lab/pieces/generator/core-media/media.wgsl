// core-media: the picked media fitted to the screen (see lab/api/media.ts fitScale), graded,
// pulsed; plus its perceptual luma and luma gradient. Three targets: tex, mask, field.

struct U {
  res: vec2f, src: vec2f,
  scale: vec2f, zoom: f32, mirror: f32,
  bright: f32, contrast: f32, sat: f32, pulse: f32,
  has: f32, time: f32, hue: f32, bass: f32,
  center: vec2f, edgepx: f32, env: f32,
};
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var media: texture_2d<f32>;

const LUMA = vec3f(0.2126, 0.7152, 0.0722);

// Nothing picked: soft drifting colour fields with a few rings, so luma and edges have shapes.
fn fallback(p: vec2f) -> vec3f {
  let a = u.res.x / max(u.res.y, 1.0);
  let q = (p - 0.5) * vec2f(a, 1.0);
  let t = u.time * 0.15;
  var v = sin(q.x * 3.1 + t) + sin(q.y * 2.3 - t * 1.3) + sin(length(q - vec2f(0.3 * sin(t), 0.2 * cos(t * 0.7))) * 7.0 - t * 2.0);
  let rings = smoothstep(0.06, 0.0, abs(fract(length(q) * 2.5 - t * 0.5) - 0.5) - 0.18);
  let h = fract(u.hue + v * 0.08 + 0.55);
  return hsv2rgb(h, 0.55, 0.12 + 0.1 * (v + 3.0) / 6.0 + 0.25 * rings);
}

fn raw(p: vec2f) -> vec3f {
  if (u.has < 0.5) { return fallback(p); }
  if (p.x < 0.0 || p.y < 0.0 || p.x > 1.0 || p.y > 1.0) { return vec3f(0.0); } // contain: bars
  let c = textureSampleLevel(media, samp, p, 0.0);
  return c.rgb * c.a; // transparent images sit on black
}

fn grade(c: vec3f) -> vec3f {
  let l = dot(c, LUMA);
  var x = mix(vec3f(l), c, u.sat);
  x = (x - 0.18) * u.contrast + 0.18; // pivot at mid grey (linear)
  return max(x * u.bright * (1.0 + u.pulse * u.env), vec3f(0.0));
}

fn src_uv(uv: vec2f) -> vec2f {
  let x = select(uv.x, 1.0 - uv.x, u.mirror > 0.5);
  return (vec2f(x, uv.y) - 0.5) * u.scale / u.zoom + u.center;
}

fn lum(c: vec3f) -> f32 { return sqrt(clamp(dot(c, LUMA), 0.0, 1.0)); }
fn at(uv: vec2f) -> f32 { return lum(grade(raw(src_uv(uv)))); }

struct Out { @location(0) col: vec4f, @location(1) luma: vec4f, @location(2) edge: vec4f };

@fragment fn fs_media(in: VOut) -> Out {
  let c = grade(raw(src_uv(in.uv)));
  let d = u.edgepx / u.res;
  // Sobel on luma, in screen space
  let tl = at(in.uv + vec2f(-d.x, -d.y)); let tc = at(in.uv + vec2f(0.0, -d.y)); let tr = at(in.uv + vec2f(d.x, -d.y));
  let ml = at(in.uv + vec2f(-d.x, 0.0));                                          let mr = at(in.uv + vec2f(d.x, 0.0));
  let bl = at(in.uv + vec2f(-d.x, d.y));  let bc = at(in.uv + vec2f(0.0, d.y));  let br = at(in.uv + vec2f(d.x, d.y));
  let gx = (tr + 2.0 * mr + br) - (tl + 2.0 * ml + bl);
  let gy = (bl + 2.0 * bc + br) - (tl + 2.0 * tc + tr);
  var o: Out;
  o.col = vec4f(c, 1.0);
  o.luma = vec4f(lum(c), 0.0, 0.0, 1.0);
  o.edge = vec4f(gx * 0.25, gy * 0.25, 0.0, 1.0);
  return o;
}
