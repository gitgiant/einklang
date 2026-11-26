// PNG and GIF codecs for the lab's sprite tools (node only, no dependencies).
import { deflateSync, inflateSync } from 'node:zlib';

export interface Rgba { w: number; h: number; data: Uint8Array }

// ------------------------------------------------------------------ PNG

const SIG = [137, 80, 78, 71, 13, 10, 26, 10];
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(b: Uint8Array): number { let c = 0xffffffff; for (const x of b) c = CRC[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }

/** Decode an 8-bit (or 16-bit, truncated) non-interlaced PNG of any colour type to RGBA8. */
export function decodePng(buf: Uint8Array): Rgba {
  if (!SIG.every((x, i) => buf[i] === x)) throw new Error('not a PNG');
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let w = 0, h = 0, depth = 0, type = 0, interlace = 0, plte: Uint8Array | null = null, trns: Uint8Array | null = null;
  const idat: Uint8Array[] = [];
  for (let p = 8; p + 8 <= buf.length;) {
    const len = dv.getUint32(p), id = String.fromCharCode(...buf.subarray(p + 4, p + 8)), body = buf.subarray(p + 8, p + 8 + len);
    if (id === 'IHDR') { w = dv.getUint32(p + 8); h = dv.getUint32(p + 12); depth = body[8]; type = body[9]; interlace = body[12]; }
    else if (id === 'PLTE') plte = body;
    else if (id === 'tRNS') trns = body;
    else if (id === 'IDAT') idat.push(body);
    else if (id === 'IEND') break;
    p += 12 + len;
  }
  if (interlace) throw new Error('interlaced PNGs are not supported: re-save without interlacing');
  if (depth !== 8 && depth !== 16 && !(type === 3 && depth <= 8) && !(type === 0 && depth < 8)) throw new Error(`PNG bit depth ${depth} not supported`);
  const ch = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as Record<number, number>)[type];
  if (!ch) throw new Error(`PNG colour type ${type} not supported`);
  const raw = inflateSync(Buffer.concat(idat));
  const bpp = Math.max(1, (ch * depth) / 8), stride = Math.ceil((w * ch * depth) / 8);
  const px = new Uint8Array(stride * h);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)], src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)), row = px.subarray(y * stride, (y + 1) * stride);
    const up = y ? px.subarray((y - 1) * stride, y * stride) : new Uint8Array(stride);
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? row[i - bpp] : 0, b = up[i], c = i >= bpp ? up[i - bpp] : 0;
      let v = src[i];
      if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      row[i] = v & 255;
    }
  }
  const out = new Uint8Array(w * h * 4);
  const sample = (y: number, x: number, c: number): number => {
    if (depth === 16) return px[y * stride + (x * ch + c) * 2];
    if (depth === 8) return px[y * stride + x * ch + c];
    const per = 8 / depth, byte = px[y * stride + Math.floor(x / per)], shift = 8 - depth * ((x % per) + 1);
    return (byte >> shift) & ((1 << depth) - 1);
  };
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const o = (y * w + x) * 4;
    if (type === 3) {
      const i = sample(y, x, 0);
      out.set([plte![i * 3], plte![i * 3 + 1], plte![i * 3 + 2], trns && i < trns.length ? trns[i] : 255], o);
    } else if (type === 0 || type === 4) {
      const v = depth < 8 ? Math.round((sample(y, x, 0) * 255) / ((1 << depth) - 1)) : sample(y, x, 0);
      out.set([v, v, v, type === 4 ? sample(y, x, 1) : 255], o);
    } else out.set([sample(y, x, 0), sample(y, x, 1), sample(y, x, 2), type === 6 ? sample(y, x, 3) : 255], o);
  }
  return { w, h, data: out };
}

/** Encode RGBA8 as a PNG (filter 0, zlib default). */
export function encodePng(img: Rgba): Uint8Array {
  const stride = img.w * 4, raw = new Uint8Array((stride + 1) * img.h);
  for (let y = 0; y < img.h; y++) raw.set(img.data.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  const chunk = (id: string, body: Uint8Array) => {
    const b = new Uint8Array(12 + body.length), dv = new DataView(b.buffer);
    dv.setUint32(0, body.length); b.set([...id].map((c) => c.charCodeAt(0)), 4); b.set(body, 8);
    dv.setUint32(8 + body.length, crc32(b.subarray(4, 8 + body.length)));
    return b;
  };
  const ihdr = new Uint8Array(13), dv = new DataView(ihdr.buffer);
  dv.setUint32(0, img.w); dv.setUint32(4, img.h); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from(SIG), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', new Uint8Array(0))]);
}

// ------------------------------------------------------------------ GIF

export interface GifFrames { w: number; h: number; frames: Uint8Array[]; delays: number[] }

/** Decode every frame of a GIF, composited onto the logical screen (disposal 0-2), as RGBA8. Delays in ms. */
export function decodeGif(buf: Uint8Array): GifFrames {
  const head = String.fromCharCode(...buf.subarray(0, 6));
  if (head !== 'GIF87a' && head !== 'GIF89a') throw new Error('not a GIF');
  const u16 = (p: number) => buf[p] | (buf[p + 1] << 8);
  const w = u16(6), h = u16(8), flags = buf[10];
  let p = 13, gct: Uint8Array | null = null;
  if (flags & 0x80) { const n = 3 << ((flags & 7) + 1); gct = buf.subarray(p, p + n); p += n; }
  const canvas = new Uint8Array(w * h * 4), frames: Uint8Array[] = [], delays: number[] = [];
  let delay = 0, transp = -1, dispose = 0;
  const subBlocks = () => { const parts: Uint8Array[] = []; while (buf[p]) { parts.push(buf.subarray(p + 1, p + 1 + buf[p])); p += buf[p] + 1; } p++; return Buffer.concat(parts); };
  while (p < buf.length) {
    const b = buf[p++];
    if (b === 0x3b) break;
    if (b === 0x21) {
      const label = buf[p++];
      if (label === 0xf9) { const pf = buf[p + 1]; dispose = (pf >> 2) & 7; delay = u16(p + 2) * 10; transp = pf & 1 ? buf[p + 4] : -1; p += buf[p] + 1; p++; }
      else subBlocks();
      continue;
    }
    if (b !== 0x2c) throw new Error('GIF: unexpected block');
    const fx = u16(p), fy = u16(p + 2), fw = u16(p + 4), fh = u16(p + 6), ff = buf[p + 8]; p += 9;
    let ct = gct;
    if (ff & 0x80) { const n = 3 << ((ff & 7) + 1); ct = buf.subarray(p, p + n); p += n; }
    const minCode = buf[p++], data = subBlocks(), idx = lzw(data, minCode, fw * fh);
    const before = dispose === 3 ? canvas.slice() : null;
    const order = ff & 0x40 ? interlaceRows(fh) : Array.from({ length: fh }, (_, i) => i);
    for (let r = 0; r < fh; r++) for (let x = 0; x < fw; x++) {
      const c = idx[r * fw + x], X = fx + x, Y = fy + order[r];
      if (c === transp || X >= w || Y >= h || !ct) continue;
      canvas.set([ct[c * 3], ct[c * 3 + 1], ct[c * 3 + 2], 255], (Y * w + X) * 4);
    }
    frames.push(canvas.slice()); delays.push(delay);
    if (dispose === 2) for (let y = fy; y < Math.min(h, fy + fh); y++) canvas.fill(0, (y * w + fx) * 4, (y * w + Math.min(w, fx + fw)) * 4);
    else if (before) canvas.set(before);
    delay = 0; transp = -1; dispose = 0;
  }
  return { w, h, frames, delays };
}

function interlaceRows(h: number): number[] {
  const rows: number[] = [];
  for (const [start, step] of [[0, 8], [4, 8], [2, 4], [1, 2]]) for (let y = start; y < h; y += step) rows.push(y);
  return rows;
}

function lzw(data: Uint8Array, minCode: number, n: number): Uint8Array {
  const out = new Uint8Array(n), clear = 1 << minCode, eoi = clear + 1;
  let size = minCode + 1, dict: number[][] = [], prev: number[] | null = null, o = 0, bit = 0;
  const reset = () => { dict = Array.from({ length: clear }, (_, i) => [i]); dict.push([], []); size = minCode + 1; prev = null; };
  reset();
  while (o < n) {
    let code = 0;
    for (let i = 0; i < size; i++, bit++) { const byte = data[bit >> 3]; if (byte === undefined) return out; code |= ((byte >> (bit & 7)) & 1) << i; }
    if (code === clear) { reset(); continue; }
    if (code === eoi) break;
    let entry: number[];
    if (code < dict.length) entry = dict[code];
    else if (prev) entry = [...prev, prev[0]];
    else break;
    for (const v of entry) if (o < n) out[o++] = v;
    if (prev && dict.length < 4096) { dict.push([...prev, entry[0]]); if (dict.length === 1 << size && size < 12) size++; }
    prev = entry;
  }
  return out;
}
