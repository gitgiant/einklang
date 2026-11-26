const PI = 3.14159265;

fn hash(x: f32) -> f32 {
  return fract(fract(x * 0.1987) * fract(x * 0.3719) * 91.71);
}

fn noise(x: f32) -> f32 {
  let cell = floor(x);
  let f = fract(x);
  return mix(hash(cell), hash(cell + 1.0), f * f * (3.0 - 2.0 * f));
}

fn shade(uv: vec2f) -> vec4f {
  let pixel = 264.0;
  let p = (floor((uv - 0.5) * vec2f(aspect(), 1.0) * pixel) + 0.5) / pixel;
  let t = time();
  let mids = (band(4) + band(6) + band(8)) / 3.0;
  let heat = mix(p_heat(), mids, 0.45);
  let pulse = pow(1.0 - phase(), 3.0);
  let dark = palette(0.0);
  let purple = palette(1.0 / 6.0);
  let vermilion = palette(0.5);
  let gold = palette(5.0 / 6.0);
  let white = palette(1.0);
  let c = p - vec2f(sin(t * 1.18) * 0.18, -0.10 - 0.035 * pulse);
  let radius = 0.244 + 0.071 * heat + 0.012 * pulse;
  let q = c / radius;
  let r2 = dot(q, q);
  var color = dark + purple * (0.27 + 0.75 * (1.0 - smoothstep(0.4, 2.5, r2)));

  // A sparse independent layer of sparks rises past the sphere.
  let ash = vec2f(p.x + 0.038 * sin(p.y * 14.0 + t), p.y + t * (0.16 + 0.05 * heat)) * vec2f(29.0, 17.0);
  let ashCell = floor(ash);
  let fleck = hash(ashCell.x * 7.9 + ashCell.y * 41.3 + 0.17);
  let spark = 1.0 - step(0.077, length(fract(ash) - vec2f(fleck, fract(fleck * 9.8))));
  color += gold * spark * step(0.73, fleck) * (0.21 + heat * 0.68);

  // A tilted dotted orbit passes behind the sphere.
  let orbit = vec2f(q.x, (q.y + 0.31 * q.x) * 3.55);
  let orbitDist = abs(length(orbit) - 1.44);
  let trail = 1.0 - smoothstep(0.013, 0.052, orbitDist);
  let phaseAlongOrbit = atan2(orbit.y, orbit.x + 0.00001) / (2.0 * PI);
  let beads = step(0.56, fract(phaseAlongOrbit * 48.0 - t * 13.0));
  color += vermilion * trail * beads * (0.45 + 0.32 * heat);

  if (r2 < 1.0) {
    let depth = sqrt(1.0 - r2);
    // Inverse-rotate the visible surface normal into the point lattice.
    let tilt = 0.43 + 0.26 * sin(t * 0.72);
    let s = sin(tilt);
    let co = cos(tilt);
    let latitude = asin(clamp(q.y * co + depth * s, -1.0, 1.0));
    let longitude = atan2(q.x, depth * co - q.y * s + 0.00001);
    let row = latitude * 21.0 / PI + 10.5;
    let stagger = fract(floor(row) * 0.5);
    let lattice = vec2f(longitude * 48.0 / (2.0 * PI) + t * 9.6 + stagger, row);
    let dotPos = fract(lattice) - 0.5;
    let dist = length(dotPos * vec2f(max(0.38, cos(latitude)), 1.0));
    let dots = 1.0 - smoothstep(0.125 + 0.055 * heat, 0.22 + 0.055 * heat, dist);
    let surface = smoothstep(0.06, 0.53, depth) * smoothstep(0.05, 0.43, cos(latitude));
    let shine = max(0.0, dot(vec3f(q, depth), vec3f(-0.4, -0.5, 0.76)));
    let ink = mix(vermilion, gold, shine) + white * pow(shine, 6.0) * 0.62;
    color = mix(dark, purple * 0.73, depth) + ink * dots * surface * (0.9 + 0.46 * heat);
  }

  // Vertical advection through three bands of value noise shapes a stepped fire palette.
  let up = 0.5 - p.y;
  if (up < 0.34) {
    let warp = 0.08 * sin(p.x * 11.0 - t * 2.1);
    let tongues = 0.11 * noise(p.x * 11.0 + up * 7.0 - t * 1.9)
      + 0.075 * noise(p.x * 23.0 - up * 22.0 + t * 4.4)
      + 0.048 * noise((p.x + warp) * 42.0 + up * 41.0 - t * 7.0);
    let potential = (0.056 + (0.069 + 0.043 * pulse) * heat + tongues - up) * 23.0;
    let dither = fract(floor(p.x * pixel) * 0.5 + floor(p.y * pixel) * 0.5);
    let index = clamp(floor(potential + dither), 0.0, 6.0);
    let fire = palette(index / 6.0);
    color = mix(color, fire * (0.85 + heat * 0.22), clamp(index * 0.35, 0.0, 1.0));
  }
  return vec4f(color, 1.0);
}
