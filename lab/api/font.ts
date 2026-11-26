// Baked fonts for pieces: the `.efont` format `einklang-lab font bake` writes. Two kinds:
//   bitmap: one alpha byte per pixel (pixel fonts; sample with a nearest sampler, scale by whole steps)
//   msdf:   multi-channel signed distance field, RGBA8 (crisp at any size: median(r, g, b) in the shader,
//           see `MSDF_WGSL`)
// Layout: "EFN1", u32 JSON length, JSON (FontInfo), then atlasW x atlasH x (1 | 4) bytes.

export interface Glyph {
  /** Atlas rect in pixels. */
  x: number; y: number; w: number; h: number;
  /** Offset of the rect's top-left from the pen position on the baseline, and the advance, in font pixels. */
  ox: number; oy: number; adv: number;
}
export interface FontInfo {
  name: string;
  mode: 'bitmap' | 'msdf';
  /** Em size the atlas was baked at, in pixels. */
  size: number;
  lineHeight: number; ascent: number;
  /** msdf: distance range in atlas pixels. */
  range: number;
  atlasW: number; atlasH: number;
  /** By code point (decimal string keys). */
  glyphs: Record<string, Glyph>;
  license?: string; source?: string;
}
export interface Font extends FontInfo { pixels: Uint8Array }

export function parseFont(bytes: Uint8Array): Font {
  if (bytes.length < 8 || String.fromCharCode(...bytes.subarray(0, 4)) !== 'EFN1') throw new Error('not an .efont');
  const n = new DataView(bytes.buffer, bytes.byteOffset).getUint32(4, true);
  const info = JSON.parse(new TextDecoder().decode(bytes.subarray(8, 8 + n))) as FontInfo;
  const px = info.atlasW * info.atlasH * (info.mode === 'msdf' ? 4 : 1);
  const pixels = bytes.slice(8 + n, 8 + n + px);
  if (pixels.length !== px) throw new Error('.efont: atlas truncated');
  return { ...info, pixels };
}

export function encodeFont(f: Font): Uint8Array {
  const { pixels, ...info } = f;
  const json = new TextEncoder().encode(JSON.stringify(info)), out = new Uint8Array(8 + json.length + pixels.length);
  out.set([69, 70, 78, 49]); new DataView(out.buffer).setUint32(4, json.length, true);
  out.set(json, 8); out.set(pixels, 8 + json.length);
  return out;
}

/** The atlas as a texture: r8unorm (bitmap) or rgba8unorm (msdf). */
export function fontTexture(device: GPUDevice, f: Font): GPUTexture {
  const bpp = f.mode === 'msdf' ? 4 : 1;
  const tex = device.createTexture({ label: `font ${f.name}`, size: [f.atlasW, f.atlasH], format: bpp === 4 ? 'rgba8unorm' : 'r8unorm', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
  device.queue.writeTexture({ texture: tex }, f.pixels as Uint8Array<ArrayBuffer>, { bytesPerRow: f.atlasW * bpp }, [f.atlasW, f.atlasH]);
  return tex;
}

/** One laid-out glyph: screen rect in font pixels (y down, line top at 0), atlas uv rect, and its index in the text. */
export interface Quad { x: number; y: number; w: number; h: number; u0: number; v0: number; u1: number; v1: number; i: number; line: number; ch: string }
export interface Layout { quads: Quad[]; width: number; height: number; lines: number[] }

/**
 * Lay out text (\n breaks lines; unknown characters fall back to '?', then to a blank advance).
 * `wrap`: break lines wider than this many font pixels at spaces. `align`: per line.
 */
export function layoutText(f: FontInfo, text: string, opts: { wrap?: number; align?: 'left' | 'center' | 'right'; tracking?: number } = {}): Layout {
  const g = (c: string) => f.glyphs[String(c.codePointAt(0))] ?? f.glyphs['63'];
  const track = opts.tracking ?? 0, space = f.glyphs['32']?.adv ?? f.size * 0.3;
  // word wrap first
  const lines: string[] = [];
  for (const raw of text.split('\n')) {
    if (!opts.wrap) { lines.push(raw); continue; }
    let cur = '';
    for (const word of raw.split(' ')) {
      const next = cur ? `${cur} ${word}` : word;
      if (cur && measure(next) > opts.wrap) { lines.push(cur); cur = word; } else cur = next;
    }
    lines.push(cur);
  }
  function measure(s: string) { let x = 0; for (const c of s) x += (c === ' ' ? space : g(c)?.adv ?? space) + track; return x - (s ? track : 0); }
  const quads: Quad[] = [], widths = lines.map(measure), width = Math.max(0, ...widths);
  let i = 0;
  lines.forEach((ln, li) => {
    let x = opts.align === 'center' ? (width - widths[li]) / 2 : opts.align === 'right' ? width - widths[li] : 0;
    const base = li * f.lineHeight + f.ascent;
    for (const c of ln) {
      const gl = c === ' ' ? null : g(c);
      if (gl && gl.w && gl.h) quads.push({ x: x + gl.ox, y: base + gl.oy, w: gl.w, h: gl.h, u0: gl.x / f.atlasW, v0: gl.y / f.atlasH, u1: (gl.x + gl.w) / f.atlasW, v1: (gl.y + gl.h) / f.atlasH, i, line: li, ch: c });
      x += (gl?.adv ?? space) + track; i++;
    }
    i++; // the line break counts as a character (typewriter timing)
  });
  return { quads, width, height: lines.length * f.lineHeight, lines: widths };
}

/** WGSL for sampling either kind: coverage 0..1 at uv, given the screen-space size of one atlas pixel (`px`). */
export const MSDF_WGSL = /* wgsl */ `
fn font_median(c: vec3f) -> f32 { return max(min(c.r, c.g), min(max(c.r, c.g), c.b)); }
// msdf: range = FontInfo.range; px_per_texel = screen pixels per atlas pixel (>= 1 is crisp)
fn font_msdf(s: vec4f, range: f32, px_per_texel: f32) -> f32 {
  let d = font_median(s.rgb) - 0.5;
  return clamp(d * range * px_per_texel + 0.5, 0.0, 1.0);
}
`;
