// Vite plugin: `virtual:lab-assets` holds the bytes of every asset a piece declares in piece.json (base64, keyed by
// path relative to lab/), so GpuInit.asset() is synchronous and only used files ship. Used by vite.config.ts and
// scripts/build-live.ts. A changed manifest or asset needs a reload (the module is rebuilt on demand).
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Plugin } from 'vite';
import type { PieceManifest } from '../../lab/api/index.ts';
import { assetFile } from '../../src/core/graph/types.ts';

const ID = 'virtual:lab-assets', RID = '\0' + ID;
const LAB = join(import.meta.dirname, '../../lab');

/** Declared asset files (relative to lab/) of every piece. */
export function declaredAssets(lab = LAB): { manifests: string[]; files: string[] } {
  const manifests: string[] = [], files = new Set<string>(), root = join(lab, 'pieces');
  for (const kind of readdirSync(root)) for (const id of readdirSync(join(root, kind))) {
    const mf = join(root, kind, id, 'piece.json');
    if (!existsSync(mf)) continue;
    manifests.push(mf);
    let m: PieceManifest;
    try { m = JSON.parse(readFileSync(mf, 'utf8')); } catch { continue; }
    for (const a of m.assets ?? []) if (typeof a.path === 'string') files.add(assetFile({ kind: kind as PieceManifest['kind'], id }, a.path));
  }
  return { manifests, files: [...files].sort() };
}

export function labAssets(): Plugin {
  return {
    name: 'einklang-lab-assets',
    resolveId: (id) => (id === ID ? RID : undefined),
    load(id) {
      if (id !== RID) return;
      const { manifests, files } = declaredAssets(), out: Record<string, string> = {};
      for (const m of manifests) this.addWatchFile(m);
      for (const f of files) {
        const p = join(LAB, f);
        if (!existsSync(p)) continue; // lint reports it; asset() throws at runtime
        this.addWatchFile(p);
        out[f] = readFileSync(p).toString('base64');
      }
      return `export default ${JSON.stringify(out)};`;
    },
  };
}
