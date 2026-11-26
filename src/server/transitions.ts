// Node side of the transition registry: reads lab/transitions/<id>/ from disk and installs it into
// core/transitions.ts when this module loads (the server, tests and the lab CLI). The browser
// bundles the same folders (src/web/transitions.ts); both build the registry the same way.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { installTransitions, type TransFile } from '../core/transitions.ts';

export const TRANSITIONS_DIR = resolve(import.meta.dirname, '../../lab/transitions');

/** Every folder as found (unparseable JSON comes back as an error string in `def`). */
export function readTransitionFiles(dir = TRANSITIONS_DIR): { files: TransFile[]; errors: string[] } {
  const files: TransFile[] = [], errors: string[] = [];
  if (!existsSync(dir)) return { files, errors: [`no ${dir}`] };
  for (const folder of readdirSync(dir).sort()) {
    const d = join(dir, folder), jf = join(d, 'transition.json'), wf = join(d, 'mix.wgsl');
    if (!existsSync(jf)) { if (!folder.startsWith('.')) errors.push(`transitions/${folder}: missing transition.json`); continue; }
    let def: unknown;
    try { def = JSON.parse(readFileSync(jf, 'utf8')); } catch (e) { errors.push(`transitions/${folder}: transition.json: ${(e as Error).message}`); continue; }
    files.push({ folder, def, wgsl: existsSync(wf) ? readFileSync(wf, 'utf8') : undefined });
  }
  return { files, errors };
}

/** Load and install; returns every problem found (invalid folders are left out of the registry). */
export function loadTransitions(dir = TRANSITIONS_DIR): string[] {
  const { files, errors } = readTransitionFiles(dir);
  return [...errors, ...installTransitions(files)];
}

/** What the install at module load found wrong (the server logs it). */
export const TRANSITION_PROBLEMS = loadTransitions();
