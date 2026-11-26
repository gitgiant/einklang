// Browser registry: every lab piece and scene, bundled by Vite (a new piece needs a rebuild).
import type { PieceDriver, PieceManifest } from '../../../lab/api/index.ts';
import { assetFile, type PieceDef, type Registry, type SceneGraph } from '../../core/graph/types.ts';
import assetFiles from 'virtual:lab-assets';
import { validatePiece } from '../../core/graph/validate.ts';
import { applyStyle, type StylePack } from '../../core/graph/style.ts';

const manifests = import.meta.glob<PieceManifest>('../../../lab/pieces/*/*/piece.json', { eager: true, import: 'default' });
const drivers = import.meta.glob<PieceDriver>('../../../lab/pieces/*/*/driver.ts', { eager: true, import: 'default' });
const shaders = import.meta.glob<string>('../../../lab/pieces/*/*/*.wgsl', { eager: true, query: '?raw', import: 'default' });
const libFiles = import.meta.glob<string>('../../../lab/api/*.wgsl', { eager: true, query: '?raw', import: 'default' });
const sceneFiles = import.meta.glob<SceneGraph>('../../../lab/scenes/*.json', { eager: true, import: 'default' });
const styleFiles = import.meta.glob<StylePack>('../../../lab/styles/*.json', { eager: true, import: 'default' });

const dirOf = (p: string) => p.slice(0, p.lastIndexOf('/'));
const unb64 = (s: string) => { const b = atob(s), u = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i); return u; };
const decoded = new Map<string, Uint8Array>();
/** A piece's declared assets by manifest path (decoded once, shared between pieces). */
function assetsOf(m: PieceManifest): Record<string, Uint8Array> {
  const out: Record<string, Uint8Array> = {};
  for (const a of m.assets ?? []) {
    const f = assetFile(m, a.path), b64 = assetFiles[f];
    if (b64 === undefined) continue;
    if (!decoded.has(f)) decoded.set(f, unb64(b64));
    out[a.path] = decoded.get(f)!;
  }
  return out;
}

function build(): Registry {
  const reg: Registry = new Map();
  for (const [path, manifest] of Object.entries(manifests)) {
    const dir = dirOf(path), wgsl: Record<string, string> = {};
    for (const [sp, src] of Object.entries(shaders)) if (dirOf(sp) === dir) wgsl[sp.slice(dir.length + 1)] = src;
    const def: PieceDef = { manifest, driver: drivers[`${dir}/driver.ts`], wgsl, assets: assetsOf(manifest) };
    const errs = validatePiece(def, dir.slice(dir.lastIndexOf('/') + 1));
    if (errs.length) { console.error(`lab piece skipped:\n${errs.join('\n')}`); continue; }
    reg.set(manifest.id, def);
  }
  return reg;
}

export const REGISTRY: Registry = build();
/** Shared WGSL in lab/api by file name (GpuInit.lib). */
export const LIB: Record<string, string> = Object.fromEntries(Object.entries(libFiles).map(([p, src]) => [p.slice(p.lastIndexOf('/') + 1), src]));
/** Style packs by id. */
export const STYLES = new Map(Object.values(styleFiles).map((s) => [s.id, s]));
/** Lab scenes not retired, in file order, style packs expanded (a scene with a broken style is logged and skipped). */
export const LAB_SCENES: SceneGraph[] = Object.values(sceneFiles).filter((s) => s.status !== 'retired').flatMap((g) => {
  try { return [applyStyle(g, STYLES, REGISTRY)]; } catch (e) { console.error(`lab scene skipped: ${(e as Error).message}`); return []; }
});
