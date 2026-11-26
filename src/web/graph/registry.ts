// Browser registry: every lab piece and scene, bundled by Vite (a new piece needs a rebuild).
import type { PieceDriver, PieceManifest } from '../../../lab/api/index.ts';
import type { PieceDef, Registry, SceneGraph } from '../../core/graph/types.ts';
import { validatePiece } from '../../core/graph/validate.ts';

const manifests = import.meta.glob<PieceManifest>('../../../lab/pieces/*/*/piece.json', { eager: true, import: 'default' });
const drivers = import.meta.glob<PieceDriver>('../../../lab/pieces/*/*/driver.ts', { eager: true, import: 'default' });
const shaders = import.meta.glob<string>('../../../lab/pieces/*/*/*.wgsl', { eager: true, query: '?raw', import: 'default' });
const libFiles = import.meta.glob<string>('../../../lab/api/*.wgsl', { eager: true, query: '?raw', import: 'default' });
const sceneFiles = import.meta.glob<SceneGraph>('../../../lab/scenes/*.json', { eager: true, import: 'default' });

const dirOf = (p: string) => p.slice(0, p.lastIndexOf('/'));

function build(): Registry {
  const reg: Registry = new Map();
  for (const [path, manifest] of Object.entries(manifests)) {
    const dir = dirOf(path), wgsl: Record<string, string> = {};
    for (const [sp, src] of Object.entries(shaders)) if (dirOf(sp) === dir) wgsl[sp.slice(dir.length + 1)] = src;
    const def: PieceDef = { manifest, driver: drivers[`${dir}/driver.ts`], wgsl };
    const errs = validatePiece(def, dir.slice(dir.lastIndexOf('/') + 1));
    if (errs.length) { console.error(`lab piece skipped:\n${errs.join('\n')}`); continue; }
    reg.set(manifest.id, def);
  }
  return reg;
}

export const REGISTRY: Registry = build();
/** Shared WGSL in lab/api by file name (GpuInit.lib). */
export const LIB: Record<string, string> = Object.fromEntries(Object.entries(libFiles).map(([p, src]) => [p.slice(p.lastIndexOf('/') + 1), src]));
/** Lab scenes not retired, in file order. */
export const LAB_SCENES: SceneGraph[] = Object.values(sceneFiles).filter((s) => s.status !== 'retired');
