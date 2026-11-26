// Node-side loader for lab/pieces and lab/scenes (tests, and the einklang-lab CLI in #22).
// The browser loads the same files through Vite globs (src/web/graph/registry.ts).
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { PieceDriver, PieceManifest } from '../../lab/api/index.ts';
import type { PieceDef, Registry, SceneGraph } from '../../src/core/graph/types.ts';
import { validatePiece } from '../../src/core/graph/validate.ts';

export const LAB = resolve(import.meta.dirname, '../../lab');

export interface Loaded { reg: Registry; errors: string[] }

/** Load every piece; collects validation errors (folder layout included) instead of throwing. */
export async function loadPieces(root = join(LAB, 'pieces')): Promise<Loaded> {
  const reg: Registry = new Map(), errors: string[] = [];
  for (const kind of readdirSync(root)) {
    for (const id of readdirSync(join(root, kind))) {
      const dir = join(root, kind, id), mf = join(dir, 'piece.json');
      if (!existsSync(mf)) { errors.push(`${kind}/${id}: missing piece.json`); continue; }
      let manifest: PieceManifest;
      try { manifest = JSON.parse(readFileSync(mf, 'utf8')); } catch (e) { errors.push(`${kind}/${id}: piece.json: ${(e as Error).message}`); continue; }
      const wgsl: Record<string, string> = {};
      for (const f of readdirSync(dir)) if (f.endsWith('.wgsl')) wgsl[f] = readFileSync(join(dir, f), 'utf8');
      let driver: PieceDriver | undefined;
      const drv = join(dir, 'driver.ts');
      if (existsSync(drv)) {
        try { driver = (await import(pathToFileURL(drv).href)).default; } catch (e) { errors.push(`${id}: driver.ts: ${(e as Error).message}`); continue; }
      }
      const def: PieceDef = { manifest, driver, wgsl };
      const errs = validatePiece(def, id);
      if (manifest.kind !== kind) errs.push(`${id}: lives in ${kind}/ but kind is ${manifest.kind}`);
      if (reg.has(manifest.id)) errs.push(`${id}: duplicate id`);
      errors.push(...errs);
      if (!errs.length) reg.set(manifest.id, def);
    }
  }
  return { reg, errors };
}

export function loadScenes(root = join(LAB, 'scenes')): SceneGraph[] {
  return readdirSync(root).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(readFileSync(join(root, f), 'utf8')));
}
