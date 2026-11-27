// N-body drawn as additive soft stars: instanced camera-facing quads, sized in world units so near
// stars are bigger. Colour: birth radius picks the palette (inner = top stop), speed lifts it.
// A soft core glow at the centre grows with the core mass; a faint nebula backdrop from stop 0.

struct Draw {
  view: mat4x4f, proj: mat4x4f,
  size: f32, glow: f32, kick: f32, shift: f32,
  pal_n: f32, core_m: f32, core_glow: f32, bg: f32,
  aspect: f32, vref: f32, dust: f32, _b: f32,
  pal: array<vec4f, 8>,
};
@group(0) @binding(0) var<uniform> dr: Draw;
@group(0) @binding(1) var<storage, read> pos: array<vec4f>;
@group(0) @binding(2) var<storage, read> vel: array<vec4f>;

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

struct SOut { @builtin(position) pos: vec4f, @location(0) q: vec2f, @location(1) col: vec3f };

const CORNERS = array<vec2f, 6>(vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0), vec2f(-1.0, -1.0), vec2f(1.0, 1.0), vec2f(-1.0, 1.0));

@vertex fn vs_star(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> SOut {
  let p = pos[ii];
  let v = vel[ii].xyz;
  let corner = CORNERS[vi];
  let rel = length(v) / max(dr.vref, 1e-4);
  // every 7th star is a big dim dust puff: gives the disk some body between the arms
  let dust = select(0.0, 1.0, (ii % 7u) == 0u && dr.dust > 0.0);
  var vp = dr.view * vec4f(p.xyz, 1.0);
  let sz = dr.size * (1.0 + 4.0 * dr.dust * dust) * (0.8 + 0.4 * clamp(rel, 0.0, 1.5));
  vp = vec4f(vp.xy + corner * sz, vp.zw);
  var o: SOut;
  o.pos = dr.proj * vp;
  o.q = corner;
  let x = clamp(0.95 - 0.75 * p.w + 0.15 * clamp(rel - 0.8, 0.0, 1.0), 0.0, 1.0);
  let hue = 1.0 - abs(fract((x + dr.shift) * 0.5) * 2.0 - 1.0);
  let k = mix(1.0, 0.12, dust);
  o.col = pal(mix(x, hue, 0.35)) * k * (0.7 + 0.5 * clamp(rel - 0.5, 0.0, 1.0) + 1.5 * dr.kick);
  return o;
}

@fragment fn fs_star(v: SOut) -> @location(0) vec4f {
  let r2 = dot(v.q, v.q);
  let a = exp(-r2 * 4.0) * (1.0 - smoothstep(0.7, 1.0, r2));
  return vec4f(v.col * a * dr.glow, 0.0);
}

@vertex fn vs_core(@builtin(vertex_index) vi: u32) -> SOut {
  let corner = CORNERS[vi];
  var vp = dr.view * vec4f(0.0, 0.0, 0.0, 1.0);
  let sz = 0.18 * sqrt(max(dr.core_m, 0.0)) * (1.0 + 0.4 * dr.kick);
  vp = vec4f(vp.xy + corner * sz, vp.zw);
  var o: SOut;
  o.pos = dr.proj * vp;
  o.q = corner;
  o.col = mix(pal(1.0), vec3f(1.0), 0.3) * dr.core_glow;
  return o;
}

@fragment fn fs_core(v: SOut) -> @location(0) vec4f {
  let r2 = dot(v.q, v.q);
  let a = (exp(-r2 * 30.0) * 2.0 + exp(-r2 * 6.0) * 0.5) * (1.0 - smoothstep(0.6, 1.0, r2));
  return vec4f(v.col * a, 0.0);
}

@fragment fn fs_bg(v: VOut) -> @location(0) vec4f {
  // a faint nebula: stop 0 with a soft glow toward the centre
  let c = (v.uv - 0.5) * vec2f(dr.aspect, 1.0);
  let g = exp(-dot(c, c) * 3.0);
  let col = pal(0.0) * (0.6 + 0.8 * g) + pal(0.3) * g * 0.08;
  return vec4f(col * dr.bg, 1.0);
}
