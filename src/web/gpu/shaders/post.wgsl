// Post chain: feedback trails -> bright pass -> separable blur -> composite + tonemap.

struct Post {
  decay: f32,     // trail persistence per frame (0 = off)
  zoom: f32,      // trail zoom per frame (+ = content flows outward)
  rotate: f32,    // trail rotation per frame, radians
  bloom: f32,     // bloom mix
  threshold: f32, // bloom bright-pass threshold
  exposure: f32,
  aspect: f32,
  view: f32,     // per-host view transform (composite only), see VIEWS in post.ts
  texel: vec2f,   // 1 / size of the texture being sampled by this pass
  dir: vec2f,     // blur direction
};
@group(0) @binding(0) var<uniform> P: Post;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var texA: texture_2d<f32>;
@group(0) @binding(3) var texB: texture_2d<f32>;

@fragment fn fs_feedback(in: VOut) -> @location(0) vec4f {
  let cur = textureSampleLevel(texA, samp, in.uv, 0.0).rgb;
  var c = (in.uv - 0.5) * vec2f(P.aspect, 1.0);
  let cs = cos(P.rotate);
  let sn = sin(P.rotate);
  c = vec2f(c.x * cs - c.y * sn, c.x * sn + c.y * cs) * (1.0 - P.zoom);
  let prev = textureSampleLevel(texB, samp, c / vec2f(P.aspect, 1.0) + 0.5, 0.0).rgb;
  return vec4f(max(cur, prev * P.decay), 1.0);
}

@fragment fn fs_bright(in: VOut) -> @location(0) vec4f {
  // 4 bilinear taps = 4x4 box downsample
  let o = P.texel;
  var c = textureSampleLevel(texA, samp, in.uv + vec2f(-o.x, -o.y), 0.0).rgb;
  c += textureSampleLevel(texA, samp, in.uv + vec2f(o.x, -o.y), 0.0).rgb;
  c += textureSampleLevel(texA, samp, in.uv + vec2f(-o.x, o.y), 0.0).rgb;
  c += textureSampleLevel(texA, samp, in.uv + vec2f(o.x, o.y), 0.0).rgb;
  c *= 0.25;
  let l = max(c.r, max(c.g, c.b));
  return vec4f(c * smoothstep(P.threshold, P.threshold + 0.5, l), 1.0);
}

@fragment fn fs_blur(in: VOut) -> @location(0) vec4f {
  // 9-tap gaussian via 5 linear-filtered samples
  let w = array<f32, 3>(0.2270270270, 0.3162162162, 0.0702702703);
  let o = array<f32, 3>(0.0, 1.3846153846, 3.2307692308);
  var c = textureSampleLevel(texA, samp, in.uv, 0.0).rgb * w[0];
  for (var i = 1; i < 3; i++) {
    let d = P.dir * P.texel * o[i];
    c += textureSampleLevel(texA, samp, in.uv + d, 0.0).rgb * w[i];
    c += textureSampleLevel(texA, samp, in.uv - d, 0.0).rgb * w[i];
  }
  return vec4f(c, 1.0);
}

fn aces(x: vec3f) -> vec3f {
  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), vec3f(0.0), vec3f(1.0));
}

fn view_uv(uv: vec2f) -> vec2f {
  let v = u32(P.view);
  if (v == 1u) { return vec2f(1.0 - uv.x, uv.y); }                 // mirror
  if (v == 2u) { return vec2f(uv.x, 1.0 - uv.y); }                 // flip
  if (v == 3u) { return 1.0 - uv; }                                // rotate 180
  if (v == 4u) { return (uv - 0.5) / 1.6 + 0.5; }                  // zoom
  if (v == 5u) { return 0.5 - abs(uv - 0.5); }                     // kaleido: 4-way mirror
  return uv;
}

@fragment fn fs_composite(in: VOut) -> @location(0) vec4f {
  let uv = view_uv(in.uv);
  let base = textureSampleLevel(texA, samp, uv, 0.0).rgb;
  let glow = textureSampleLevel(texB, samp, uv, 0.0).rgb;
  var c = (base + glow * P.bloom) * P.exposure;
  c = aces(c);
  // subtle vignette
  let v = in.uv - 0.5;
  c *= 1.0 - dot(v, v) * 0.35;
  return vec4f(pow(c, vec3f(1.0 / 2.2)), 1.0);
}
