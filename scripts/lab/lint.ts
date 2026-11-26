// Piece rules the manifest schema can't express: imports and folder size.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve, relative, sep } from 'node:path';
import { LAB } from './load.ts';

/** Per-piece folder cap (assets included). */
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

/** Lint every piece folder (imports of every .ts file, folder size). */
export function lintPieces(root = join(LAB, 'pieces')): string[] {
  const errs: string[] = [];
  for (const kind of readdirSync(root)) for (const id of readdirSync(join(root, kind))) {
    const dir = join(root, kind, id);
    let core = false;
    try { core = JSON.parse(readFileSync(join(dir, 'piece.json'), 'utf8')).author?.vendor === 'core'; } catch { /* reported by the loader */ }
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.ts'))) for (const e of lintDriver(readFileSync(join(dir, f), 'utf8'), dir, core)) errs.push(`${id}/${f}: ${e}`);
    const bytes = size(dir);
    if (bytes > PIECE_BYTES) errs.push(`${id}: folder is ${(bytes / 1048576).toFixed(1)} MB (cap ${PIECE_BYTES / 1048576} MB)`);
  }
  return errs;
}
