import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parseVox, voxSurface, voxWorld } from '../lab/api/index.ts';
import { lintAssets, lintPieces, PIECE_BYTES } from '../scripts/lab/lint.ts';
import { readIndex } from '../scripts/lab/import.ts';
import { declaredAssets } from '../scripts/lab/vite-assets.ts';
import { loadPieces, LAB } from '../scripts/lab/load.ts';
import { validatePiece } from '../src/core/graph/validate.ts';
import { assetFile, type PieceDef } from '../src/core/graph/types.ts';

/** A minimal .vox: the given chunks under MAIN. */
function vox(chunks: [string, Uint8Array][]): Uint8Array {
  const body = chunks.reduce((n, [, b]) => n + 12 + b.length, 0), out = new Uint8Array(20 + body), dv = new DataView(out.buffer);
  const tag = (p: number, s: string) => { for (let i = 0; i < 4; i++) out[p + i] = s.charCodeAt(i); };
  tag(0, 'VOX '); dv.setUint32(4, 150, true); tag(8, 'MAIN'); dv.setUint32(16, body, true);
  let p = 20;
  for (const [id, b] of chunks) { tag(p, id); dv.setUint32(p + 4, b.length, true); out.set(b, p + 12); p += 12 + b.length; }
  return out;
}
const u32s = (...v: number[]) => new Uint8Array(new Uint32Array(v).buffer);
const str = (s: string) => [s.length, ...[...s].map((c) => c.charCodeAt(0))];
/** u32 fields and strings, little-endian, as chunk bytes. */
function fields(...parts: (number | string)[]): Uint8Array {
  const b: number[] = [];
  for (const x of parts) {
    if (typeof x === 'number') b.push(x & 255, (x >>> 8) & 255, (x >>> 16) & 255, (x >>> 24) & 255);
    else { const [n, ...cs] = str(x); b.push(n, 0, 0, 0, ...cs); }
  }
  return Uint8Array.from(b);
}

test('vox: one model, palette, surface culling', () => {
  // a 3x3x3 solid block: 26 surface voxels, the centre is hidden
  const xyz: number[] = [];
  for (let z = 0; z < 3; z++) for (let y = 0; y < 3; y++) for (let x = 0; x < 3; x++) xyz.push(x, y, z, 7);
  const rgba = new Uint8Array(1024); rgba.set([10, 20, 30, 255], 6 * 4);
  const f = parseVox(vox([['SIZE', u32s(3, 3, 3)], ['XYZI', Uint8Array.from([...u32s(27), ...xyz])], ['RGBA', rgba]]));
  assert.equal(f.models.length, 1);
  assert.deepEqual(f.models[0].size, [3, 3, 3]);
  assert.deepEqual(f.palette[7], [10, 20, 30, 255], 'colour index i is RGBA entry i - 1');
  assert.equal(voxSurface(f.models[0]).length / 4, 26);
  assert.deepEqual(f.instances, [{ model: 0, t: [0, 0, 0], rot: [1, 0, 0, 0, 1, 0, 0, 0, 1] }]);
  assert.equal(parseVox(vox([['SIZE', u32s(1, 1, 1)], ['XYZI', Uint8Array.from([...u32s(1), 0, 0, 0, 1])]])).palette[200][0], 200, 'no RGBA: grey ramp');
  assert.throws(() => parseVox(new Uint8Array(40)), /not a .vox/);
  assert.throws(() => parseVox(vox([['RGBA', rgba]])), /no models/);
});

test('vox: the scene graph places and rotates models', () => {
  // root trn 0 -> grp 1 -> [trn 2 (t 10 0 0, rot 90° about z) -> shp 3 -> model 0]
  const one = [['SIZE', u32s(2, 1, 1)], ['XYZI', Uint8Array.from([...u32s(2), 0, 0, 0, 1, 1, 0, 0, 1])]] as [string, Uint8Array][];
  // _r: row 0 non-zero at column 1, row 1 at column 0, row 0 negative: x' = -y, y' = x, z' = z
  const r = 1 | (0 << 2) | 16;
  const f = parseVox(vox([...one,
    ['nTRN', fields(0, 0, 1, 0xffffffff, 0xffffffff, 1, 0)],
    ['nGRP', fields(1, 0, 1, 2)],
    ['nTRN', fields(2, 0, 3, 0xffffffff, 0xffffffff, 1, 2, '_t', '10 0 0', '_r', String(r))],
    ['nSHP', fields(3, 0, 1, 0, 0)],
  ]));
  assert.equal(f.instances.length, 1);
  assert.deepEqual(f.instances[0].t, [10, 0, 0]);
  assert.deepEqual(f.instances[0].rot, [0, -1, 0, 1, 0, 0, 0, 0, 1]);
  const w = voxWorld(f);
  // voxels at x = 0, 1 minus floor(size / 2) = (1, 0, 0) -> (-1, 0, 0) and (0, 0, 0), rotated -> (0, -1, 0), (0, 0, 0), + t
  const pts = [...Array(w.count).keys()].map((i) => [...w.pos.subarray(i * 3, i * 3 + 3)]).sort();
  assert.deepEqual(pts, [[10, -1, 0], [10, 0, 0]]);
});

test('vox: imported space_sim ships parse and place their parts', () => {
  const f = parseVox(readFileSync(join(LAB, 'assets/vox/fighter.vox')));
  assert.ok(f.models.length > 1 && f.instances.length >= f.models.length);
  const w = voxWorld(f);
  assert.ok(w.count > 5000, `fighter has ${w.count} visible voxels`);
  assert.ok(w.max[1] - w.min[1] > 80, 'the hull is long along y');
});

test('assets: index.json lists every imported file, none from third_party', () => {
  const idx = readIndex(), keys = Object.keys(idx.files);
  assert.ok(keys.length > 500);
  for (const k of keys) {
    const e = idx.files[k];
    assert.ok(!e.source.includes('third_party'), k);
    assert.ok(e.license, `${k}: license`);
    assert.ok(existsSync(join(LAB, k)), `${k} exists`);
    assert.equal(statSync(join(LAB, k)).size, e.bytes, `${k} size`);
  }
  assert.equal(idx.files['assets/vox/furniture/shelfFood.vox'].license, 'unsettled', 'third-party props stay unusable');
  assert.equal(idx.files['assets/vox/fighter.vox'].license, 'own');
});

test('assets: manifest paths and licenses are validated', () => {
  const def = (assets: { path: string; license: string }[]): PieceDef => ({
    manifest: { id: 'x-y', kind: 'generator', name: 'x', ports: { out: { out: { type: 'tex' } } }, shader: 's.wgsl', author: { vendor: 'x' }, assets },
    wgsl: { 's.wgsl': 'fn shade(uv: vec2f) -> vec4f { return vec4f(1.0); }' },
  });
  assert.deepEqual(validatePiece(def([{ path: 'assets/vox/fighter.vox', license: 'own' }, { path: 'img.png', license: 'CC0-1.0' }])), []);
  for (const bad of ['../x.vox', '/abs.vox', 'a\\b.vox', 'C:/x.vox', 'a/../../b.vox']) assert.match(validatePiece(def([{ path: bad, license: 'own' }])).join(), /relative path/, bad);
  assert.match(validatePiece(def([{ path: 'a.vox', license: '' }])).join(), /license required/);
  assert.match(validatePiece(def([{ path: 'a.vox', license: 'unsettled' }])).join(), /unsettled/);
  assert.match(validatePiece(def([{ path: 'a.vox', license: 'own' }, { path: 'a.vox', license: 'own' }])).join(), /twice/);
  assert.equal(assetFile({ kind: 'generator', id: 'x-y' }, 'assets/vox/a.vox'), 'assets/vox/a.vox');
  assert.equal(assetFile({ kind: 'generator', id: 'x-y' }, 'a.vox'), 'pieces/generator/x-y/a.vox');
});

test('assets: lint checks existence, the index license, and counts shared bytes', () => {
  const index = { files: { 'assets/vox/fighter.vox': { license: 'own' } } };
  const m = (assets: { path: string; license: string }[]) => ({ id: 'x-y', kind: 'generator' as const, assets });
  const ok = lintAssets(m([{ path: 'assets/vox/fighter.vox', license: 'own' }]), index);
  assert.deepEqual(ok.errs, []);
  assert.equal(ok.shared, statSync(join(LAB, 'assets/vox/fighter.vox')).size);
  assert.match(lintAssets(m([{ path: 'assets/vox/fighter.vox', license: 'CC0-1.0' }]), index).errs.join(), /index.json says 'own'/);
  assert.match(lintAssets(m([{ path: 'assets/vox/bomber.vox', license: 'own' }]), index).errs.join(), /not in lab\/assets\/index.json/);
  assert.match(lintAssets(m([{ path: 'assets/vox/nope.vox', license: 'own' }]), index).errs.join(), /not found/);
  assert.match(lintAssets(m([{ path: 'mine.vox', license: 'own' }]), index).errs.join(), /not found/);
  assert.deepEqual(lintPieces(), [], 'the shipped pieces lint clean');
});

test('assets: the exemplar piece declares its ships, under the cap, and the bundle ships only declared files', async () => {
  const { reg } = await loadPieces();
  const p = reg.get('claude-vox-ship')!;
  assert.ok(p, 'claude-vox-ship loads');
  const paths = (p.manifest.assets ?? []).map((a) => a.path);
  assert.ok(paths.length >= 3);
  for (const a of paths) assert.ok(p.assets?.[a]?.length, `${a} bytes loaded`);
  const shared = paths.reduce((n, a) => n + statSync(join(LAB, a)).size, 0);
  assert.ok(shared < PIECE_BYTES);
  const { files } = declaredAssets();
  for (const a of paths) assert.ok(files.includes(a));
  assert.ok(files.length < 50, 'only declared assets are bundled, not all of lab/assets');
});
