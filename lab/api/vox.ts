// MagicaVoxel `.vox` reader for pieces. Get the bytes with `GpuInit.asset(path)` (declared in piece.json `assets`).
// Format: https://github.com/ephtracy/voxel-model (RIFF-style chunks under MAIN: PACK?, SIZE+XYZI per model, RGBA,
// and the nTRN/nGRP/nSHP scene graph that places the models; materials and layers are skipped). MagicaVoxel is z-up.
// Most pieces want `voxWorld(file)`: every model placed by the scene graph, as one voxel list.

export interface VoxModel {
  /** Size along x, y, z (z up). */
  size: [number, number, number];
  /** x, y, z, colour index (1..255) per voxel: 4 bytes each. */
  voxels: Uint8Array;
}

/** A model placed in the scene: world = rot * (v - floor(size / 2)) + t. `rot` is a row-major 3x3 of -1/0/1. */
export interface VoxInstance { model: number; t: [number, number, number]; rot: number[] }

export interface VoxFile {
  models: VoxModel[];
  /** 256 colours as [r, g, b, a] 0..255; colour index i is entry i (entry 0 unused). */
  palette: [number, number, number, number][];
  /** Every placed model (frame 0 of the scene graph); one identity instance per model when the file has no scene graph. */
  instances: VoxInstance[];
}

/** Grey ramp, for files without an RGBA chunk. */
const fallback = (): VoxFile['palette'] => Array.from({ length: 256 }, (_, i) => [i, i, i, 255]);

/** Parse `.vox` bytes. Throws on a file that isn't one. */
export function parseVox(bytes: Uint8Array): VoxFile {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (p: number) => String.fromCharCode(bytes[p], bytes[p + 1], bytes[p + 2], bytes[p + 3]);
  if (bytes.length < 20 || tag(0) !== 'VOX ') throw new Error('not a .vox file');
  if (tag(8) !== 'MAIN') throw new Error('.vox: MAIN chunk missing');
  const models: VoxModel[] = [];
  const nodes = new Map<number, SceneNode>();
  let palette: VoxFile['palette'] | null = null, size: [number, number, number] | null = null;
  const end = Math.min(bytes.length, 20 + dv.getUint32(12, true) + dv.getUint32(16, true));
  for (let p = 20 + dv.getUint32(12, true); p + 12 <= end;) {
    const id = tag(p), n = dv.getUint32(p + 4, true), kids = dv.getUint32(p + 8, true), body = p + 12;
    if (body + n > bytes.length) throw new Error(`.vox: chunk ${id} runs past the end`);
    if (id === 'SIZE') size = [dv.getUint32(body, true), dv.getUint32(body + 4, true), dv.getUint32(body + 8, true)];
    else if (id === 'XYZI') {
      if (!size) throw new Error('.vox: XYZI before SIZE');
      const count = dv.getUint32(body, true);
      if (body + 4 + count * 4 > body + n) throw new Error('.vox: XYZI count past the chunk');
      models.push({ size, voxels: bytes.slice(body + 4, body + 4 + count * 4) });
      size = null;
    } else if (id === 'nTRN' || id === 'nGRP' || id === 'nSHP') {
      const r = reader(dv, bytes, body), nid = r.u32(); r.dict();
      if (id === 'nTRN') {
        const child = r.u32(); r.u32(); r.u32();
        const frames = r.u32(), f = frames ? r.dict() : {};
        nodes.set(nid, { kind: 'trn', child, t: (f._t ?? '0 0 0').split(' ').map(Number) as [number, number, number], rot: rotation(f._r ? +f._r : 4) });
      } else if (id === 'nGRP') {
        const k = r.u32(), kids: number[] = [];
        for (let i = 0; i < k; i++) kids.push(r.u32());
        nodes.set(nid, { kind: 'grp', kids });
      } else {
        const k = r.u32(), ms: number[] = [];
        for (let i = 0; i < k; i++) { ms.push(r.u32()); r.dict(); }
        nodes.set(nid, { kind: 'shp', models: ms });
      }
    } else if (id === 'RGBA') {
      // file entry k is colour index k + 1
      palette = [[0, 0, 0, 0]];
      for (let k = 0; k < 255; k++) palette.push([bytes[body + k * 4], bytes[body + k * 4 + 1], bytes[body + k * 4 + 2], bytes[body + k * 4 + 3]]);
    }
    p = body + n + kids;
  }
  if (!models.length) throw new Error('.vox: no models');
  const instances: VoxInstance[] = [];
  if (nodes.has(0)) walkScene(nodes, 0, [0, 0, 0], [1, 0, 0, 0, 1, 0, 0, 0, 1], instances, 0);
  if (!instances.length) models.forEach((_, i) => instances.push({ model: i, t: [0, 0, 0], rot: [1, 0, 0, 0, 1, 0, 0, 0, 1] }));
  return { models, palette: palette ?? fallback(), instances };
}

type SceneNode =
  | { kind: 'trn'; child: number; t: [number, number, number]; rot: number[] }
  | { kind: 'grp'; kids: number[] }
  | { kind: 'shp'; models: number[] };

function reader(dv: DataView, bytes: Uint8Array, p: number) {
  const dec = new TextDecoder();
  const u32 = () => { const v = dv.getUint32(p, true); p += 4; return v; };
  const str = () => { const n = u32(), s = dec.decode(bytes.subarray(p, p + n)); p += n; return s; };
  const dict = () => { const n = u32(), d: Record<string, string> = {}; for (let i = 0; i < n; i++) { const k = str(); d[k] = str(); } return d; };
  return { u32, dict };
}

/** The `_r` byte: bits 0-1 / 2-3 = column of the non-zero entry in rows 0 / 1, bits 4-6 = row signs. */
function rotation(b: number): number[] {
  const c0 = b & 3, c1 = (b >> 2) & 3, c2 = 3 - c0 - c1, m = new Array(9).fill(0);
  m[c0] = b & 16 ? -1 : 1; m[3 + c1] = b & 32 ? -1 : 1; m[6 + c2] = b & 64 ? -1 : 1;
  return m;
}
const mul = (a: number[], b: number[]) => Array.from({ length: 9 }, (_, i) => a[i - (i % 3)] * b[i % 3] + a[i - (i % 3) + 1] * b[3 + (i % 3)] + a[i - (i % 3) + 2] * b[6 + (i % 3)]);
const apply = (m: number[], v: number[]): [number, number, number] => [m[0] * v[0] + m[1] * v[1] + m[2] * v[2], m[3] * v[0] + m[4] * v[1] + m[5] * v[2], m[6] * v[0] + m[7] * v[1] + m[8] * v[2]];

function walkScene(nodes: Map<number, SceneNode>, id: number, t: number[], rot: number[], out: VoxInstance[], depth: number): void {
  const n = nodes.get(id);
  if (!n || depth > 64) return;
  if (n.kind === 'trn') {
    const lt = apply(rot, n.t);
    walkScene(nodes, n.child, [t[0] + lt[0], t[1] + lt[1], t[2] + lt[2]], mul(rot, n.rot), out, depth + 1);
  } else if (n.kind === 'grp') for (const k of n.kids) walkScene(nodes, k, t, rot, out, depth + 1);
  else for (const model of n.models) out.push({ model, t: [t[0], t[1], t[2]], rot });
}

/** All placed voxels in world space (z up): positions as Int16 x, y, z triples, colour indices, and the bounds. */
export interface VoxWorld { pos: Int16Array; color: Uint8Array; count: number; min: [number, number, number]; max: [number, number, number] }

/**
 * Flatten a file's scene into one voxel list. `surface` (default true) drops voxels hidden inside their own model.
 * Later instances overwrite earlier ones in the same cell.
 */
export function voxWorld(f: VoxFile, surface = true): VoxWorld {
  const cells = new Map<string, [number, number, number, number]>();
  for (const ins of f.instances) {
    const m = f.models[ins.model];
    if (!m) continue;
    const vs = surface ? voxSurface(m) : m.voxels, h = m.size.map((s) => Math.floor(s / 2));
    for (let i = 0; i < vs.length; i += 4) {
      const w = apply(ins.rot, [vs[i] - h[0], vs[i + 1] - h[1], vs[i + 2] - h[2]]);
      const x = w[0] + ins.t[0], y = w[1] + ins.t[1], z = w[2] + ins.t[2];
      cells.set(`${x},${y},${z}`, [x, y, z, vs[i + 3]]);
    }
  }
  const count = cells.size, pos = new Int16Array(count * 3), color = new Uint8Array(count);
  const min: [number, number, number] = [Infinity, Infinity, Infinity], max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  let i = 0;
  for (const c of cells.values()) {
    for (let k = 0; k < 3; k++) { pos[i * 3 + k] = c[k]; min[k] = Math.min(min[k], c[k]); max[k] = Math.max(max[k], c[k]); }
    color[i++] = c[3];
  }
  if (!count) { min.fill(0); max.fill(0); }
  return { pos, color, count, min, max };
}

/**
 * The voxels of a model that have at least one empty face neighbour (the rest can never be seen).
 * Same layout as `VoxModel.voxels`.
 */
export function voxSurface(m: VoxModel): Uint8Array {
  const [sx, sy, sz] = m.size, solid = new Uint8Array(sx * sy * sz), at = (x: number, y: number, z: number) => x + sx * (y + sy * z);
  for (let i = 0; i < m.voxels.length; i += 4) solid[at(m.voxels[i], m.voxels[i + 1], m.voxels[i + 2])] = 1;
  const full = (x: number, y: number, z: number) => x >= 0 && y >= 0 && z >= 0 && x < sx && y < sy && z < sz && solid[at(x, y, z)] === 1;
  const out: number[] = [];
  for (let i = 0; i < m.voxels.length; i += 4) {
    const x = m.voxels[i], y = m.voxels[i + 1], z = m.voxels[i + 2];
    if (full(x - 1, y, z) && full(x + 1, y, z) && full(x, y - 1, z) && full(x, y + 1, z) && full(x, y, z - 1) && full(x, y, z + 1)) continue;
    out.push(x, y, z, m.voxels[i + 3]);
  }
  return Uint8Array.from(out);
}
