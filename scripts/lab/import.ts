// One-time copy of space_sim's own voxel assets into lab/assets/vox/, with provenance in
// lab/assets/index.json. third_party/ (licenses unknown) is never copied. Spec: docs/prd-lab.md "Assets import".
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, relative, sep } from 'node:path';
import { LAB } from './load.ts';

export const ASSETS = join(LAB, 'assets');
export const INDEX = join(ASSETS, 'index.json');
export const DEFAULT_SRC = 'C:\\Users\\giant\\Desktop\\space_sim';

export interface AssetEntry {
  /** Where it came from, relative to the source repo. */
  source: string;
  /** `own` (the owner's work), a license id (`CC0-1.0`, `CC-BY-4.0`...), or `unsettled` (no piece may use it). */
  license: string;
  bytes: number;
  sha256: string;
  note?: string;
}
/** lab/assets/index.json: keys are paths relative to lab/ (`assets/vox/fighter.vox`). */
export interface AssetIndex { files: Record<string, AssetEntry> }

/** space_sim furniture with third-party props stamped in (space_sim assets/CREDITS.md): author and license not recorded. */
const UNSETTLED = new Set(['furniture/shelfFood.vox', 'furniture/shelfDrinks.vox', 'furniture/shelfTools.vox', 'furniture/producestand.vox', 'furniture/orebin.vox']);
const KEEP = /\.(vox|json|png)$/;

export function readIndex(): AssetIndex {
  return existsSync(INDEX) ? JSON.parse(readFileSync(INDEX, 'utf8')) : { files: {} };
}

function* walk(dir: string, skip: (rel: string) => boolean, root = dir): Generator<string> {
  for (const f of readdirSync(dir).sort()) {
    const p = join(dir, f), rel = relative(root, p).split(sep).join('/');
    if (skip(rel)) continue;
    if (statSync(p).isDirectory()) yield* walk(p, skip, root);
    else if (KEEP.test(f)) yield rel;
  }
}

/** Copy (or re-copy) the space_sim assets; returns what was written. Existing entries from other sources are kept. */
export function importSpaceSim(src = DEFAULT_SRC): { files: number; bytes: number } {
  const sets: { from: string; to: string; source: string }[] = [
    { from: join(src, 'assets/vox'), to: 'assets/vox', source: 'space_sim/assets/vox' },
    { from: join(src, 'assets/agent/ship'), to: 'assets/vox/agent-ship', source: 'space_sim/assets/agent/ship' },
  ];
  const index = readIndex();
  for (const k of Object.keys(index.files)) if (index.files[k].source.startsWith('space_sim/')) delete index.files[k];
  let files = 0, bytes = 0;
  for (const s of sets) {
    if (!existsSync(s.from)) throw new Error(`not found: ${s.from}`);
    for (const rel of walk(s.from, (r) => r === 'third_party' || r.startsWith('third_party/'))) {
      const key = `${s.to}/${rel}`, dst = join(LAB, key), buf = readFileSync(join(s.from, rel));
      mkdirSync(dirname(dst), { recursive: true });
      copyFileSync(join(s.from, rel), dst);
      const unsettled = s.to === 'assets/vox' && UNSETTLED.has(rel);
      index.files[key] = {
        source: `${s.source}/${rel}`,
        license: unsettled ? 'unsettled' : 'own',
        bytes: buf.length,
        sha256: createHash('sha256').update(buf).digest('hex'),
        ...(unsettled ? { note: 'contains third-party props (space_sim assets/CREDITS.md); author and license not recorded' } : {}),
      };
      files++; bytes += buf.length;
    }
  }
  const sorted: AssetIndex = { files: Object.fromEntries(Object.entries(index.files).sort(([a], [b]) => a.localeCompare(b))) };
  writeFileSync(INDEX, JSON.stringify(sorted, null, 1) + '\n');
  return { files, bytes };
}
