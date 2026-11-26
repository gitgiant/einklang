fn shade(uv: vec2f) -> vec4f {
  let p = (floor((uv - 0.5) * vec2f(aspect(), 1.0) * 284.0) + 0.5) / 284.0;
  let t = time();
  let kick = mix(p_zoom(), bass(), 0.45);
  let angle = t * 0.65 + 0.65 * sin(t * 0.67);
  let lens = 5.3 + 2.25 * sin(t * 1.5) - 2.35 * kick;
  let camera = vec2f(cos(angle), sin(angle));
  let drift = vec2f(t * 0.72, 1.2 * sin(t * 0.69));
  let world = vec2f(dot(p, camera), dot(p, vec2f(-camera.y, camera.x))) * lens + drift;

  let tile = floor(world);
  let q = (floor(fract(world) * 32.0) + 0.5) / 32.0 - 0.5;
  let a = abs(q);
  let checker = fract((tile.x + tile.y) * 0.5) * 2.0;
  let accent = fract((tile.x - tile.y) * 0.25) * 2.0;
  let seam = step(0.452, max(a.x, a.y));

  // Each tile is a flat 32 by 32 inlay. Diagonal facets alternate across the checkerboard.
  let diamond = a.x + a.y;
  let orientation = mix(q.x + q.y, q.x - q.y, checker);
  let facet = step(0.0, orientation);
  let edging = step(0.43, diamond) * (1.0 - step(0.50, diamond));
  let recess = (1.0 - step(0.43, diamond));
  let inset = 1.0 - step(0.253, diamond);
  let jewel = 1.0 - step(0.106, diamond);
  let joint = (1.0 - step(0.058, min(a.x, a.y))) * step(0.28, max(a.x, a.y));
  let pin = 1.0 - step(0.072, abs(a.x - 0.375) + abs(a.y - 0.375));

  var index = 1.0 + checker * 1.0 + 0.4 * facet;
  index = mix(index, 3.0 + facet + accent * 0.6, recess);
  index = mix(index, 0.0, edging);
  index = mix(index, 1.0 + checker + facet, inset);
  index = mix(index, 5.0 + facet, max(jewel, pin));
  index = mix(index, 3.7 + checker * 0.72, joint * (1.0 - recess));
  index = mix(index, 0.0, seam);

  // Alternating pixels give the half-tones the appearance of an indexed palette.
  let dither = fract((floor(q.x * 32.0) + floor(q.y * 32.0)) * 0.5) * 2.0;
  let color = palette(clamp(floor(index + 0.68 * dither) / 6.0, 0.0, 1.0));
  let falloff = 1.0 - 0.37 * smoothstep(0.28, 1.0, length(p));
  let lift = 0.79 + 0.32 * kick + 0.12 * pow(1.0 - phase(), 3.0);
  return vec4f(color * falloff * lift, 1.0);
}
