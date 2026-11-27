// Blit sorted storage texture to output with optional dry/wet mix.

struct BlitU {
  mix_amt: f32,
  punch: f32,
  _pad0: f32,
  _pad1: f32,
};

@group(0) @binding(0) var<uniform> u: BlitU;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var tex_src: texture_2d<f32>;
@group(0) @binding(3) var tex_sorted: texture_2d<f32>;

@fragment fn fs_blit(v: VOut) -> @location(0) vec4f {
  let src = textureSample(tex_src, samp, v.uv).rgb;
  let srt = textureSample(tex_sorted, samp, v.uv).rgb;
  let out_rgb = mix(src, srt, u.mix_amt);
  return vec4f(max(out_rgb, vec3f(0.0)), 1.0);
}
