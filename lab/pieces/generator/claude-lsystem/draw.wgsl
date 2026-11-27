// L-system trees: a sky gradient, then instanced prims max-blended on top.
// prim = two vec4: (x0, y0, x1, y1), (w0, w1, palette x, brightness) in uv units with x scaled by the aspect.
// w1 < 0 marks a blossom: centre (x0, y0), rotation x1, radius w0.

struct Draw {
  aspect: f32, px: f32, pal_n: f32, glow: f32,
  kick: f32, bass: f32, rms: f32, shift: f32,
  sky: f32, _a: f32, _b: f32, _c: f32,
  pal: array<vec4f, 8>,
};
@group(0) @binding(0) var<uniform> dr: Draw;
@group(0) @binding(1) var<storage, read> prims: array<vec4f>;

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

// palette position drifting with `shift`, ping-ponged so there is no seam
fn palc(x: f32) -> vec3f {
  return pal(1.0 - abs(fract((x + dr.shift) * 0.5) * 2.0 - 1.0));
}

@fragment fn fs_sky(v: VOut) -> @location(0) vec4f {
  let y = v.uv.y;
  let x = (v.uv.x - 0.5) * dr.aspect;
  // dark zenith, a horizon glow that swells with the bass and the kick, dark ground below the roots
  let horizon = exp(-pow((0.965 - y) * 5.0, 2.0)) * (0.05 + 0.45 * dr.bass + 0.35 * dr.kick + 0.2 * dr.rms);
  let haze = (0.012 + 0.03 * dr.rms) * (0.4 + 0.6 * y);
  var col = pal(0.05) * haze + pal(0.35) * horizon * (1.0 - 0.25 * abs(x));
  if (y > 0.965) { col = pal(0.0) * 0.02; }
  return vec4f(col * dr.sky, 1.0);
}

struct POut {
  @builtin(position) pos: vec4f,
  @location(0) q: vec2f,
  @location(1) @interpolate(flat) a: vec4f,
  @location(2) @interpolate(flat) b: vec4f,
};

@vertex fn vs_prim(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> POut {
  let a = prims[ii * 2u];
  let b = prims[ii * 2u + 1u];
  var lo: vec2f;
  var hi: vec2f;
  if (b.y < 0.0) {
    let r = b.x * 1.6 + 2.0 * dr.px;
    lo = a.xy - vec2f(r);
    hi = a.xy + vec2f(r);
  } else {
    let r = max(b.x, b.y) * 2.5 + 2.0 * dr.px;
    lo = min(a.xy, a.zw) - vec2f(r);
    hi = max(a.xy, a.zw) + vec2f(r);
  }
  var quad = array<vec2f, 6>(vec2f(0, 0), vec2f(1, 0), vec2f(0, 1), vec2f(1, 0), vec2f(1, 1), vec2f(0, 1));
  let corner = quad[vi];
  let q = mix(lo, hi, corner);
  var o: POut;
  o.pos = vec4f(q.x / dr.aspect * 2.0 - 1.0, 1.0 - 2.0 * q.y, 0.0, 1.0);
  o.q = q;
  o.a = a;
  o.b = b;
  return o;
}

@fragment fn fs_prim(i: POut) -> @location(0) vec4f {
  let aa = dr.px * 1.2;
  if (i.b.y < 0.0) {
    // five-petal blossom with a bright heart
    let d = i.q - i.a.xy;
    let r = i.b.x;
    let th = atan2(d.y, d.x) + i.a.z;
    let petal = r * (0.55 + 0.45 * abs(cos(th * 2.5)));
    let dist = length(d);
    let body = smoothstep(petal + aa, petal - aa, dist);
    let heart = smoothstep(r * 0.28, 0.0, dist);
    let halo = exp(-dist / max(r * 0.6, dr.px)) * 0.25;
    let c = palc(i.b.z) * (body * (0.7 + 0.3 * dist / max(r, 1e-5)) + halo) + pal(1.0) * heart * 0.8;
    return vec4f(c * i.b.w * dr.glow, 1.0);
  }
  // tapered capsule
  let pa = i.q - i.a.xy;
  let ba = i.a.zw - i.a.xy;
  let h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-10), 0.0, 1.0);
  let dist = length(pa - ba * h);
  let r = mix(i.b.x, i.b.y, h);
  let body = smoothstep(r + aa, r - aa, dist);
  let core = smoothstep(r * 0.5 + aa, 0.0, dist);
  let halo = exp(-max(dist - r, 0.0) / max(r * 0.8, dr.px)) * 0.3;
  let c = palc(i.b.z) * (body * (0.6 + 0.6 * core) + halo);
  return vec4f(c * i.b.w * dr.glow, 1.0);
}
