// Starburst fireworks rendering: persistent trail fade, velocity-stretched additive sparks, and starry night composite.

struct DrawU {
  // res.x, res.y, aspect, time
  a: vec4f,
  // trail_decay, gravity, gain, sparkle
  b: vec4f,
  // rms, bass, treble, flash_strength
  c: vec4f,
  // flash_x, flash_y, 0, 0
  d: vec4f,
  // flash_col.rgb, 1
  flash_col: vec4f,
  // sky_col.rgb, 1
  sky_col: vec4f,
};

@group(0) @binding(0) var<uniform> u: DrawU;

// --- Pass 1A: Fade previous trail texture ---
@group(0) @binding(1) var prev_tex: texture_2d<f32>;
@group(0) @binding(2) var samp: sampler;

@fragment fn fs_fade(v: VOut) -> @location(0) vec4f {
  // Tiny downward drift in UV (uv.y = 0 is top, so sampling slightly above makes trails droop down)
  let drift = vec2f(0.0, -0.00055 * u.b.y);
  let uv = clamp(v.uv + drift, vec2f(0.0), vec2f(1.0));
  let prev = textureSample(prev_tex, samp, uv).rgb;
  let decay = u.b.x;
  let faded = max(prev * decay - vec3f(0.0008), vec3f(0.0));
  return vec4f(faded, 1.0);
}

// --- Pass 1B: Additive velocity-stretched spark streaks ---
@group(0) @binding(3) var<storage, read> pts: array<vec4f>;

struct SparkOut {
  @builtin(position) pos: vec4f,
  @location(0) local: vec2f,
  @location(1) col: vec3f,
};

@vertex fn vs_spark(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> SparkOut {
  let p0 = pts[ii * 3u + 0u];
  let p1 = pts[ii * 3u + 1u];
  let p2 = pts[ii * 3u + 2u];

  var out: SparkOut;
  let age = p1.w;
  if (age < 0.0) {
    out.pos = vec4f(2.0, 2.0, 2.0, 1.0);
    out.local = vec2f(0.0);
    out.col = vec3f(0.0);
    return out;
  }

  let corners = array<vec2f, 6>(
    vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(-1.0, 1.0),
    vec2f(-1.0, 1.0), vec2f(1.0, -1.0), vec2f(1.0, 1.0),
  );
  let c = corners[vi];

  let max_life = max(0.1, p2.x);
  let life_t = clamp(age / max_life, 0.0, 1.0);
  let size = p2.y;
  let sparkle_seed = p2.w;

  let asp = u.a.z;
  let pos_xy = p0.xy;
  let vel_xy = p0.zw;
  let spd = length(vel_xy);

  // Build velocity-aligned basis so fast sparks stretch into crisp streaks
  var dir = vec2f(1.0, 0.0);
  if (spd > 0.001) {
    dir = vel_xy / spd;
  }
  let perp = vec2f(-dir.y, dir.x);

  // Head radius shrinks slightly over lifetime; tail stretches proportionally to velocity
  let rad = size * (0.0085 + 0.0065 * (1.0 - life_t));
  let tail_len = rad + min(0.14, spd * 0.055);

  // Quad spans [-tail_len .. +rad] along dir, [-rad .. +rad] along perp
  let along = select(-tail_len, rad, c.x > 0.0);
  let across = c.y * rad;
  let world = pos_xy + dir * along + perp * across;

  // Map aspect-corrected space (x in [-asp, asp], y in [-1, 1]) to NDC
  let ndc = vec2f(world.x / asp, world.y);

  // Lifecycle envelope: hot white birth flash -> saturated palette -> sparkling fade-out
  let birth = smoothstep(0.0, 0.03, life_t);
  let fade = pow(max(0.0, 1.0 - life_t), 1.35);
  let hot_flash = exp(-life_t * 14.0);

  // Glitter / crackle twinkle in the second half of life, boosted by treble & sparkle param
  let tw_phase = u.a.w * (24.0 + 20.0 * sparkle_seed) + sparkle_seed * 62.8318;
  let twinkle = 0.5 + 0.5 * sin(tw_phase);
  let crackle_mask = smoothstep(0.32, 0.72, life_t);
  let sparkle_boost = mix(1.0, 0.35 + (1.35 + 1.15 * u.c.z) * pow(twinkle, 3.0) * u.b.w, crackle_mask);

  let base_col = mix(p1.rgb, vec3f(1.0, 0.97, 0.92), clamp(0.28 + 0.65 * hot_flash, 0.0, 0.92));
  let intensity = u.b.z * birth * fade * sparkle_boost * (0.72 + 0.55 * u.c.x + 0.35 * u.c.y);

  out.pos = vec4f(ndc, 0.0, 1.0);
  out.local = c;
  out.col = base_col * intensity;
  return out;
}

@fragment fn fs_spark(in: SparkOut) -> @location(0) vec4f {
  // Bright circular head near local.x = 0.6, smooth tapered tail toward local.x = -1.0
  let head_d = length(vec2f((in.local.x - 0.55) * 1.4, in.local.y));
  let head_glow = exp(-head_d * head_d * 5.5);

  let tail_x = clamp((in.local.x + 1.0) * 0.5, 0.0, 1.0);
  let tail_y = in.local.y;
  let tail_glow = exp(-tail_y * tail_y * 6.5) * pow(tail_x, 1.2) * (1.0 - smoothstep(0.65, 1.0, in.local.x));

  let shape = max(head_glow, tail_glow * 0.72);
  if (shape < 0.004) { discard; }
  return vec4f(in.col * shape, 0.0);
}

// --- Pass 2: Composite trails over starry twilight sky + burst atmospheric flash ---
fn star_hash(p: vec2f) -> f32 {
  return fract(sin(dot(p, vec2f(127.1, 311.7))) * 43758.5453123);
}

@fragment fn fs_compose(v: VOut) -> @location(0) vec4f {
  let asp = u.a.z;
  let trails = textureSample(prev_tex, samp, v.uv).rgb;

  // Deep night sky gradient with subtle horizon glow reacting to bass/rms
  let y_up = 1.0 - v.uv.y;
  let zenith = vec3f(0.008, 0.012, 0.028);
  let horizon = u.sky_col.rgb * (0.045 + 0.08 * u.c.x + 0.06 * u.c.y);
  var sky = mix(horizon, zenith, pow(clamp(y_up, 0.0, 1.0), 0.65));

  // Subtle twinkling starfield in the upper sky
  let star_grid = floor(v.uv * vec2f(asp * 85.0, 85.0));
  let star_f = fract(v.uv * vec2f(asp * 85.0, 85.0)) - vec2f(0.5);
  let sh = star_hash(star_grid);
  if (sh > 0.985) {
    let sd = length(star_f);
    let tw = 0.55 + 0.45 * sin(u.a.w * (2.0 + 4.0 * fract(sh * 91.3)) + sh * 100.0);
    let star = exp(-sd * sd * 28.0) * tw * smoothstep(0.15, 0.7, y_up) * 0.28;
    sky = sky + vec3f(0.85, 0.92, 1.0) * star;
  }

  // Atmospheric radial illumination flash at the latest burst origin
  let p_world = vec2f((v.uv.x * 2.0 - 1.0) * asp, 1.0 - v.uv.y * 2.0);
  let fd = length(p_world - u.d.xy);
  let flash_glow = exp(-fd * fd * 4.5) * u.c.w;
  sky = sky + u.flash_col.rgb * flash_glow * 0.55;

  let col = max(sky + trails, vec3f(0.0));
  return vec4f(col, 1.0);
}
