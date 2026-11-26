// Piece rules the manifest schema can't express: imports and folder size.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve, relative, sep } from 'node:path';
import { LAB } from './load.ts';
import { assetFile } from '../../src/core/graph/types.ts';
import type { PieceManifest } from '../../lab/api/index.ts';

/** Per-piece cap: the folder plus the shared lab/assets files it declares. */
export const PIECE_BYTES = 2 * 1024 * 1024;
/** Globals a driver must not touch: the page, network, storage, timers. */
const BANNED = /\b(document|window|localStorage|sessionStorage|indexedDB|fetch|XMLHttpRequest|WebSocket|setTimeout|setInterval|navigator|location|eval|Function\s*\()\b/;

/**
 * Problems in a driver's source. Non-core pieces import only from lab/api (and their own folder);
 * vendor `core` pieces may also import from src/core (they wrap the v1 engine).
 */
export function lintDriver(src: string, pieceDir: string, core: boolean): string[] {
  const errs: string[] = [];
  const api = resolve(LAB, 'api'), coreDir = resolve(LAB, '../src/core');
  for (const m of src.matchAll(/(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]/g)) {
    const spec = m[1] ?? m[2];
    if (!spec.startsWith('.')) { errs.push(`import '${spec}': only lab/api and files in the piece folder`); continue; }
    const target = resolve(pieceDir, spec);
    const inside = (dir: string) => !relative(dir, target).startsWith('..') && !relative(dir, target).includes(`..${sep}`);
    if (inside(pieceDir) || inside(api) || (core && inside(coreDir))) continue;
    errs.push(`import '${spec}': only lab/api and files in the piece folder`);
  }
  if (!core) {
    const code = src.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    const hit = code.match(BANNED);
    if (hit) errs.push(`uses ${hit[1]}: pieces run inside the frame loop and may not touch the page, network, storage or timers`);
  }
  return errs;
}

function size(dir: string): number {
  let n = 0;
  for (const f of readdirSync(dir)) { const p = join(dir, f), s = statSync(p); n += s.isDirectory() ? size(p) : s.size; }
  return n;
}

/** lab/assets/index.json: provenance and license of each shared asset, keyed by path relative to lab/. */
type Index = { files: Record<string, { license: string }> };

/**
 * A piece's declared assets: each exists, shared ones (`assets/...`) are in lab/assets/index.json with the same
 * license. Returns the errors and the bytes of the shared files (piece-folder files count via the folder size).
 */
export function lintAssets(m: Pick<PieceManifest, 'id' | 'kind' | 'assets'>, index: Index, lab = LAB): { errs: string[]; shared: number } {
  const errs: string[] = [];
  let shared = 0;
  for (const a of m.assets ?? []) {
    if (typeof a.path !== 'string') continue; // the manifest validator reports it
    const rel = assetFile(m, a.path), file = join(lab, rel);
    if (!existsSync(file)) { errs.push(`${m.id}: asset ${a.path} not found (${rel})`); continue; }
    if (!a.path.startsWith('assets/')) continue;
    shared += statSync(file).size;
    const e = index.files[rel];
    if (!e) errs.push(`${m.id}: asset ${a.path} is not in lab/assets/index.json (add it with its source and license)`);
    else if (e.license !== a.license) errs.push(`${m.id}: asset ${a.path} license '${a.license}' but index.json says '${e.license}'`);
  }
  return { errs, shared };
}

/** Lint every piece folder (imports of every .ts file, declared assets, size). */
export function lintPieces(root = join(LAB, 'pieces')): string[] {
  const errs: string[] = [], idx = join(root, '../assets/index.json');
  const index: Index = existsSync(idx) ? JSON.parse(readFileSync(idx, 'utf8')) : { files: {} };
  for (const kind of readdirSync(root)) for (const id of readdirSync(join(root, kind))) {
    const dir = join(root, kind, id);
    let m: PieceManifest | null = null;
    try { m = JSON.parse(readFileSync(join(dir, 'piece.json'), 'utf8')); } catch { /* reported by the loader */ }
    const core = m?.author?.vendor === 'core';
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.ts'))) for (const e of lintDriver(readFileSync(join(dir, f), 'utf8'), dir, core)) errs.push(`${id}/${f}: ${e}`);
    const a = m ? lintAssets({ id, kind: kind as PieceManifest['kind'], assets: m.assets }, index, join(root, '..')) : { errs: [], shared: 0 };
    errs.push(...a.errs);
    const bytes = size(dir) + a.shared;
    if (bytes > PIECE_BYTES) errs.push(`${id}: ${(bytes / 1048576).toFixed(1)} MB with its assets (cap ${PIECE_BYTES / 1048576} MB)`);
  }
  return errs;
}
