// The lab CLI's transition commands: validate lab/transitions/ (schema + the assembled shader
// compiles), scaffold a new one, and the render/gate runs (a transition between two fixed scenes).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readTransitionFiles, TRANSITIONS_DIR } from '../../src/server/transitions.ts';
import { buildTransitions, CURVES, type TransDef } from '../../src/core/transitions.ts';
import { assembleTransitions, mixLine } from '../../src/core/transwgsl.ts';
import { compileWgsl } from './wgsl.ts';
import { LAB } from './load.ts';

const COMMON = join(LAB, '../src/web/gpu/shaders/common.wgsl');
const PRELUDE = join(LAB, 'pieces/utility/core-transition/prelude.wgsl');

/** The two scenes every transition is rendered between (v1 scenes: cheap, distinct, always there). */
export const TRANS_FROM = 'radial', TRANS_TO = 'tunnel';
/** A transition may cost this much more than core-blend per 1080p frame. */
export const TRANS_BUDGET_MS = 2;

/** Schema problems of every folder, plus the WGSL compile of the assembled shader (skipped, with a note, without Chrome). */
export async function validateTransitions(opts: { compile: boolean; note: (s: string) => void }): Promise<{ ids: string[]; errors: string[] }> {
  const { files, errors } = readTransitionFiles();
  const built = buildTransitions(files);
  errors.push(...built.errors);
  if (opts.compile) {
    const common = readFileSync(COMMON, 'utf8'), a = assembleTransitions(readFileSync(PRELUDE, 'utf8'), built.list);
    const skip = common.split('\n').length; // shader() puts common + '\n' before the code
    try {
      const [msgs] = await compileWgsl([common + '\n' + a.code]);
      for (const m of msgs.filter((x) => x.type === 'error')) {
        const at = mixLine(a.spans, m.line - skip);
        errors.push(at ? `transitions/${at.id}/mix.wgsl:${at.line}:${m.col} ${m.message}` : `transition shader (prelude or generated) ${m.line - skip}:${m.col} ${m.message}`);
      }
    } catch (e) { opts.note(`note: transition WGSL not compiled here (${(e as Error).message})`); }
  }
  return { ids: built.list.map((e) => e.id), errors };
}

/** Scaffold lab/transitions/<id>/ with a working mix (a soft radial wipe on beat steps). */
export function newTransition(id: string): string {
  if (!/^(claude|codex|agy)-[a-z0-9]+(-[a-z0-9]+)*$/.test(id)) throw new Error('usage: new transition <vendor>-<slug>   (vendor: claude, codex or agy)');
  const dir = join(TRANSITIONS_DIR, id);
  if (existsSync(dir)) throw new Error(`${dir} exists`);
  mkdirSync(dir, { recursive: true });
  const def: TransDef = {
    id, name: id.split('-').slice(1).join(' '), vendor: id.split('-')[0], model: 'TODO',
    description: 'TODO: one sentence on what the switch looks like.',
    curve: { type: 'smoothstep' },
    params: { soft: { default: 0.06, min: 0, max: 0.5, doc: 'edge softness' } },
    budget: { ms: 0.2 },
  };
  writeFileSync(join(dir, 'transition.json'), JSON.stringify(def, null, 2) + '\n');
  writeFileSync(join(dir, 'mix.wgsl'), `// ${id}: TODO describe it. The prelude gives T (p, seed, flash, roll, aspect, time, center, res, bands),
// sa(uv) / sb(uv) (old / new scene), inside, rnd, band, bandv, rot, h32. Return linear HDR rgb.
fn trans(uv: vec2f) -> vec3f {
  let p = T.p;
  let d = length((uv - 0.5) * vec2f(T.aspect, 1.0));
  let far = length(vec2f(0.5 * T.aspect, 0.5));
  let r = p * (far + p_soft());
  return mix(sa(uv), sb(uv), 1.0 - smoothstep(r - p_soft(), r, d));
}
`);
  return dir;
}

export const curveList = () => Object.entries(CURVES).map(([k, v]) => (Object.keys(v).length ? `${k}(${Object.keys(v).join(', ')})` : k)).join(', ');
