fn print_rotate(p: vec2f, angle: f32) -> vec2f {
  let cs = vec2f(cos(angle), sin(angle));
  return vec2f(dot(p, vec2f(cs.x, -cs.y)), dot(p, cs.yx));
}

fn shade(uv: vec2f) -> vec4f {
  let shape = vec2f(aspect(), 1.0);
  let p = (uv - 0.5) * shape;
  let low = smoothstep(0.025, 0.65, bass() + 0.36 * rms());
  let high = smoothstep(0.01, 0.52, 0.5 * (band(8) + band(12)));
  let strike = clamp(onset(), 0.0, 1.0);
  let angle = 0.16 * sin(time() * 0.26) + 0.73 * low;
  let q = print_rotate(p, angle) * (7.8 - 2.0 * low);
  let mix_mode = 0.68 + 0.27 * sin(time() * 0.54) + 0.26 * high;
  // Antisymmetric standing modes on a plate. Their zero crossings gather ink.
  let wave = sin(q.x * 1.4) * sin(q.y * 3.0) - mix_mode * sin(q.x * 3.0) * sin(q.y * 1.4);
  let width = p_nodal() * (0.72 + 0.57 * low + 0.27 * strike);
  let aa = clamp(fwidth(wave), 0.004, 0.13);
  let node = 1.0 - smoothstep(width * 0.28, width + aa, abs(wave));

  let warped = print_rotate(p, -0.17 * low) * (1.06 - 0.21 * low);
  let sample_uv = 0.5 + (warped + vec2f(0.015, -0.019) * wave * (1.0 + low)) / shape;
  let luma = tex_light(sample_uv).x;
  let media = tex_picture(sample_uv).rgb;
  let shade_weight = 1.0 - smoothstep(0.08, 0.92, luma);
  let ink_coverage = 0.11 + (0.36 + 0.15 * low) * shade_weight + (0.14 + 0.22 * high) * node;
  let pitch = min(p_lines(), resolution().y * 0.23);
  let cut = dot(p, vec2f(0.16 - 0.52 * low, 0.98)) * pitch + 0.43 * wave;
  let line = abs(fract(cut) - 0.5) * 2.0;
  let soft = max(0.045, fwidth(cut));
  let hatch = 1.0 - smoothstep(ink_coverage - soft, ink_coverage + soft, line);
  let deposit = clamp(hatch * (0.62 + shade_weight * 0.27) + node * (0.19 + 0.28 * low), 0.0, 1.0);

  let sheet = mix(vec3f(0.78, 0.62, 0.41), vec3f(0.11, 0.25, 0.27), 0.69 * low);
  let paper = sheet * (0.61 + 0.39 * luma) + media * (0.14 + 0.21 * low);
  let pigment = mix(vec3f(0.014, 0.12, 0.13), vec3f(0.51, 0.099, 0.029),
                    clamp(0.45 + 0.33 * wave + 0.62 * (media.r - media.b), 0.0, 1.0));
  let ink = pigment * (0.39 + 0.49 * luma + 0.39 * strike);
  return vec4f(mix(paper, ink, deposit), 1.0);
}
