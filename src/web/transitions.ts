// Browser side of the transition registry: every lab/transitions/<id>/ folder, bundled by Vite and
// installed into core/transitions.ts when this module loads (import it before evaluating a schedule).
// The server installs the same folders from disk (src/server/transitions.ts): same order, same kinds.
import { installTransitions, transitions, type TransFile } from '../core/transitions.ts';
import { assembleTransitions, mixLine, type Assembled } from '../core/transwgsl.ts';

const defs = import.meta.glob<unknown>('../../lab/transitions/*/transition.json', { eager: true, import: 'default' });
const mixes = import.meta.glob<string>('../../lab/transitions/*/mix.wgsl', { eager: true, query: '?raw', import: 'default' });

const folderOf = (p: string) => p.split('/').at(-2)!;
const files: TransFile[] = Object.entries(defs).map(([p, def]) => ({ folder: folderOf(p), def, wgsl: mixes[p.replace(/transition\.json$/, 'mix.wgsl')] }));
for (const e of installTransitions(files)) console.error(`transition skipped: ${e}`);

/** The transition shader: core-transition's prelude plus every registered mix. */
export function transitionShader(prelude: string): Assembled { return assembleTransitions(prelude, transitions()); }
export { mixLine };
