// Sprite sheets for pieces: the `.spr` format the lab's importers write (PNG/Aseprite/GIF/.vox slices,
// code-drawn recipes, `sprite gen`). Indexed colour, every frame the same size; on the GPU a sheet is
// one rgba8unorm texture_2d_array layer per frame. Read the bytes with `GpuInit.asset(path)`.
//
// Layout (little-endian): "SPR1", u16 w, u16 h, u16 frames, u16 colours, u16 tags, u16 reserved,
//   colours x RGBA8 (index 0 is always transparent), frames x u16 duration ms (0 = no hint),
//   tags x (u8 name length, name UTF-8, u16 from, u16 to), then frames x h x w u8 colour indices.

export interface SpriteTag { name: string; from: number; to: number }
export interface Sheet {
  /** Frame size in pixels. */
  w: number; h: number;
  frames: number;
  /** RGBA8 per colour index; index 0 is transparent. */
  palette: Uint8Array;
  /** frames x h x w colour indices. */
  pixels: Uint8Array;
  /** Per-frame duration hint in ms (0 = none: time it to the beat). */
  durations: Uint16Array;
  /** Named frame ranges (Aseprite tags), inclusive. */
  tags: SpriteTag[];
}

const MAGIC = 'SPR1';

export function parseSheet(bytes: Uint8Array): Sheet {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 16 || String.fromCharCode(...bytes.subarray(0, 4)) !== MAGIC) throw new Error('not a .spr sheet');
  const w = dv.getUint16(4, true), h = dv.getUint16(6, true), frames = dv.getUint16(8, true), colours = dv.getUint16(10, true), ntags = dv.getUint16(12, true);
  let p = 16;
  const palette = bytes.slice(p, p + colours * 4); p += colours * 4;
  const durations = new Uint16Array(frames);
  for (let i = 0; i < frames; i++, p += 2) durations[i] = dv.getUint16(p, true);
  const tags: SpriteTag[] = [], dec = new TextDecoder();
  for (let i = 0; i < ntags; i++) {
    const n = bytes[p]; const name = dec.decode(bytes.subarray(p + 1, p + 1 + n)); p += 1 + n;
    tags.push({ name, from: dv.getUint16(p, true), to: dv.getUint16(p + 2, true) }); p += 4;
  }
  const pixels = bytes.slice(p, p + frames * w * h);
  if (pixels.length !== frames * w * h) throw new Error('.spr: pixel data truncated');
  return { w, h, frames, palette, pixels, durations, tags };
}

export function encodeSheet(s: Sheet): Uint8Array {
  const enc = new TextEncoder(), names = s.tags.map((t) => enc.encode(t.name).subarray(0, 255));
  const colours = s.palette.length / 4;
  const size = 16 + colours * 4 + s.frames * 2 + names.reduce((n, b) => n + 5 + b.length, 0) + s.pixels.length;
  const out = new Uint8Array(size), dv = new DataView(out.buffer);
  out.set([...MAGIC].map((c) => c.charCodeAt(0)));
  dv.setUint16(4, s.w, true); dv.setUint16(6, s.h, true); dv.setUint16(8, s.frames, true); dv.setUint16(10, colours, true); dv.setUint16(12, s.tags.length, true);
  let p = 16;
  out.set(s.palette, p); p += s.palette.length;
  for (let i = 0; i < s.frames; i++, p += 2) dv.setUint16(p, s.durations[i] ?? 0, true);
  s.tags.forEach((t, i) => { out[p] = names[i].length; out.set(names[i], p + 1); p += 1 + names[i].length; dv.setUint16(p, t.from, true); dv.setUint16(p + 2, t.to, true); p += 4; });
  out.set(s.pixels, p);
  return out;
}

/** One frame as RGBA8 (w x h x 4). */
export function sheetRgba(s: Sheet, frame: number): Uint8Array {
  const n = s.w * s.h, out = new Uint8Array(n * 4), base = (frame % s.frames) * n;
  for (let i = 0; i < n; i++) { const c = s.pixels[base + i]; if (c) out.set(s.palette.subarray(c * 4, c * 4 + 4), i * 4); }
  return out;
}

/** The sheet as an rgba8unorm 2d-array texture, one layer per frame (sample it with a nearest sampler). */
export function sheetTexture(device: GPUDevice, s: Sheet, label = 'sprite'): GPUTexture {
  const tex = device.createTexture({ label, size: [s.w, s.h, s.frames], format: 'rgba8unorm', dimension: '2d', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
  for (let f = 0; f < s.frames; f++) device.queue.writeTexture({ texture: tex, origin: [0, 0, f] }, sheetRgba(s, f) as Uint8Array<ArrayBuffer>, { bytesPerRow: s.w * 4, rowsPerImage: s.h }, [s.w, s.h, 1]);
  return tex;
}

/** The frame to show `beats` into a loop that steps `perBeat` frames each beat, within an optional tag. */
export function frameAt(s: Sheet, beats: number, perBeat: number, tag?: string): number {
  const t = tag ? s.tags.find((x) => x.name === tag) : undefined;
  const from = t?.from ?? 0, len = t ? t.to - t.from + 1 : s.frames;
  const i = Math.floor(beats * perBeat);
  return from + (((i % len) + len) % len);
}
