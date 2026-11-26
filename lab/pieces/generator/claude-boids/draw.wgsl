// Boids drawn as instanced quads stretched along the velocity: a soft glowing streak per bird,
// additively blended. Colour comes from the palette by speed / heading.

struct Draw {
  aspect: f32, size: f32, streak: f32, glow: f32,
  speed: f32, kick: f32, shift: f32, hue: f32,
  pal_n: f32, sky: f32, _a: f32, _b: f32,
  pal: array<vec4f, 8>,
};
@group(0) @binding(0) var<uniform> dr: Draw;
@group(0) @binding(1) var<storage, read> boids: array<vec4f>;

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

struct BOut { @builtin(position) pos: vec4f, @location(0) q: vec2f, @location(1) col: vec3f };

@vertex fn vs_boid(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> BOut {
  let b = boids[ii];
  let sp = length(b.zw);
  let dir = select(vec2f(1.0, 0.0), b.zw / sp, sp > 1e-6);
  let nrm = vec2f(-dir.y, dir.x);
  var corners = array<vec2f, 6>(vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0), vec2f(-1.0, -1.0), vec2f(1.0, 1.0), vec2f(-1.0, 1.0));
  let corner = corners[vi];
  // the streak trails behind the bird and grows with speed
  let rel = sp / max(dr.speed, 1e-5);
  let len = dr.size * (1.0 + dr.streak * rel);
  let along = (corner.x * 0.5 - 0.5) * len + dr.size * 0.5 * (corner.x + 1.0) * 0.5;
  let w = dr.size * 0.5;
  let p = b.xy + dir * along + nrm * corner.y * w;
  var o: BOut;
  o.pos = vec4f(p.x / dr.aspect * 2.0 - 1.0, 1.0 - p.y * 2.0, 0.0, 1.0);
  o.q = vec2f(corner.x, corner.y);
  // colour: heading sweeps the middle of the palette, fast birds climb toward the top stop
  let head = atan2(dir.y, dir.x) / 6.2831853 + 0.5;
  let x = clamp(0.25 + 0.45 * (0.5 + 0.5 * sin((head + dr.shift) * 6.2831853)) + 0.3 * clamp(rel - 0.8, 0.0, 1.0), 0.0, 1.0);
  o.col = pal(x) * (0.6 + 0.6 * clamp(rel - 0.6, 0.0, 1.0) + 0.8 * dr.kick);
  return o;
}

@fragment fn fs_boid(v: BOut) -> @location(0) vec4f {
  // bright head at +x, fading tail toward -x, soft across
  let a = (1.0 - v.q.y * v.q.y) * smoothstep(-1.0, 0.6, v.q.x) * (1.0 - smoothstep(0.7, 1.0, v.q.x));
  return vec4f(v.col * a * dr.glow, 0.0);
}

@fragment fn fs_sky(v: VOut) -> @location(0) vec4f {
  // dusk gradient from the darkest stops: brighter at the horizon (bottom)
  let y = v.uv.y;
  let c = mix(pal(0.0), pal(0.18), smoothstep(0.1, 1.1, y));
  return vec4f(c * dr.sky, 1.0);
}
