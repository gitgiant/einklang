// Auto-shader pieces: piece.json + one WGSL file with `fn shade(uv: vec2f) -> vec4f`. The runtime
// generates the prelude (uniforms, param getters, input samplers, palette) and the pipeline.
import type { Audio, PieceManifest, ParamValue, Palette } from '../../../lab/api/index.ts';
import { TEX_FORMAT, isTexPort, oklch } from '../../../lab/api/index.ts';

/** Header floats before the params (see the Lab struct below). */
const HEAD = 60, MAX_STOPS = 8;

export interface AutoLayout {
  /** Generated WGSL to put between the shared prelude and the piece's shader. */
  prelude: string;
  /** Param name -> float offset in the uniform block (colors take 3). */
  slots: [string, number, 'num' | 'color'][];
  /** Image inputs in binding order (binding 2 + i); `prev` last when feedback. */
  textures: string[];
  /** Name of the palette input, if any. */
  palette: string | null;
  floats: number;
}

export function autoLayout(m: PieceManifest): AutoLayout {
  const slots: AutoLayout['slots'] = [];
  const getters: string[] = [];
  let off = 0;
  for (const [name, s] of Object.entries(m.params ?? {})) {
    if (s.type === 'text') continue;
    const at = HEAD + off, v = `lab.p[${off >> 2}]`;
    if (s.type === 'color') {
      if ((off & 3) > 1) off = (off + 3) & ~3; // keep the 3 floats in one vec4
      const a = HEAD + off, i = off >> 2, c = off & 3;
      slots.push([name, a, 'color']);
      getters.push(`fn p_${name}() -> vec3f { return vec3f(lab.p[${i}][${c}], lab.p[${i}][${c + 1}], lab.p[${i}][${c + 2}]); }`);
      off += 3;
    } else {
      slots.push([name, at, 'num']);
      getters.push(`fn p_${name}() -> f32 { return ${v}[${off & 3}]; }`);
      off += 1;
    }
  }
  const nvec = Math.max(1, Math.ceil(off / 4));
  const ins = Object.entries(m.ports.in ?? {});
  const textures = ins.filter(([, p]) => isTexPort(p.type)).map(([n]) => n);
  if (m.feedback) textures.push('prev');
  const palette = ins.find(([, p]) => p.type === 'palette')?.[0] ?? null;
  const tex = textures.map((n, i) =>
    `@group(0) @binding(${2 + i}) var lab_${n}: texture_2d<f32>;\n` +
    `fn ${n === 'prev' ? 'prev' : `tex_${n}`}(uv: vec2f) -> vec4f { return textureSampleLevel(lab_${n}, lab_samp, uv, 0.0); }`);
  const prelude = `
struct Lab {
  res: vec2f, t: f32, sub: f32,
  rms_: f32, onset_: f32, phase_: f32, bar_: f32,
  bands: array<vec4f, 4>,
  pal: array<vec4f, ${MAX_STOPS}>,
  pal_n: f32, bpm_: f32, tick_: f32, _pad: f32,
  p: array<vec4f, ${nvec}>,
};
@group(0) @binding(0) var<uniform> lab: Lab;
@group(0) @binding(1) var lab_samp: sampler;
fn aspect() -> f32 { return lab.res.x / lab.res.y; }
fn resolution() -> vec2f { return lab.res; }
fn time() -> f32 { return lab.t; }
fn rms() -> f32 { return lab.rms_; }
fn onset() -> f32 { return lab.onset_; }
fn phase() -> f32 { return lab.phase_; }
fn bar() -> f32 { return lab.bar_; }
fn bpm() -> f32 { return lab.bpm_; }
fn band(i: i32) -> f32 { let j = clamp(i, 0, 15); return lab.bands[j / 4][j % 4]; }
fn bass() -> f32 { return (band(0) + band(1) + band(2)) / 3.0; }
fn oklab_to_linear(c: vec3f) -> vec3f {
  let l_ = c.x + 0.3963377774 * c.y + 0.2158037573 * c.z;
  let m_ = c.x - 0.1055613458 * c.y - 0.0638541728 * c.z;
  let s_ = c.x - 0.0894841775 * c.y - 1.291485548 * c.z;
  let l = l_ * l_ * l_; let m = m_ * m_ * m_; let s = s_ * s_ * s_;
  return max(vec3f(0.0), vec3f(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s));
}
// x in 0..1 (clamped; use fract(x) to cycle). Interpolates in OKLab.
fn palette(x: f32) -> vec3f {
  let n = max(i32(lab.pal_n), 1);
  let f = clamp(x, 0.0, 1.0) * f32(n - 1);
  let i = min(i32(floor(f)), n - 1);
  let j = min(i + 1, n - 1);
  return oklab_to_linear(mix(lab.pal[i].xyz, lab.pal[j].xyz, f - f32(i)));
}
${getters.join('\n')}
${tex.join('\n')}
`;
  return { prelude, slots, textures, palette, floats: HEAD + nvec * 4 };
}

export const autoFragment = '\n@fragment fn fs_auto(v: VOut) -> @location(0) vec4f { return shade(v.uv); }\n';

/** The palette an unconnected palette input reads: a rainbow that follows the pads' step. */
export function defaultPalette(a: Audio): Palette {
  return { stops: Array.from({ length: 6 }, (_, i) => oklch(0.72, 0.15, a.pal + i / 6)) };
}

const hexRgb = (s: string) => [1, 3, 5].map((i) => (parseInt(s.slice(i, i + 2), 16) / 255) ** 2.2);

/** Fill the uniform block for one frame. */
export function writeAuto(L: AutoLayout, f: Float32Array, w: number, h: number, time: number, sub: number, a: Audio, tick: number, params: Record<string, ParamValue>, pal: Palette): void {
  f.fill(0);
  f.set([w, h, time, sub / 256, a.rms, a.onset ? 1 : 0, a.phase, a.bar], 0);
  f.set(a.bands, 8);
  const st = pal.stops.slice(0, MAX_STOPS);
  st.forEach((s, i) => f.set(s, 24 + i * 4));
  f.set([st.length, a.bpm, tick % 65536, 0], 56);
  for (const [name, at, kind] of L.slots) {
    const v = params[name];
    if (kind === 'color') f.set(typeof v === 'string' ? hexRgb(v) : [0, 0, 0], at);
    else f[at] = typeof v === 'boolean' ? +v : typeof v === 'number' ? v : 0;
  }
}

export const formatOf = (t: string): GPUTextureFormat => (isTexPort(t as never) ? TEX_FORMAT[t as keyof typeof TEX_FORMAT] : 'rgba16float');
