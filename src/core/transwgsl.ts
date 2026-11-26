// Assembles the transition shader: core-transition's prelude.wgsl (uniforms, helpers, fs_trans)
// plus every registered mix.wgsl, each in its own namespace, plus a generated switch on T.kind.
// Pure string work, shared by the browser registry and the lab CLI (which compiles it to check).
import type { TransEntry } from './transitions.ts';

/** Where one transition's mix.wgsl landed in the assembled code (1-based lines). */
export interface MixSpan { id: string; start: number; lines: number }
export interface Assembled { code: string; spans: MixSpan[] }

const ident = (id: string) => id.replace(/-/g, '_');

/** Comments blanked out (line breaks kept, so line numbers still match). */
const uncomment = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' ')).replace(/\/\/[^\n]*/g, (m) => ' '.repeat(m.length));

/** Names declared at module scope (fn, const, override, alias, struct, var<private>). */
export function topLevelNames(src: string): string[] {
  const s = uncomment(src), names: string[] = [];
  let depth = 0;
  const re = /\b(?:fn|const|override|alias|struct|var(?:\s*<[^>]*>)?)\s+([A-Za-z_]\w*)/y;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '{') depth++;
    else if (ch === '}') depth--;
    else if (depth === 0 && /[a-z]/.test(ch) && (i === 0 || !/\w/.test(s[i - 1]))) {
      re.lastIndex = i;
      const m = re.exec(s);
      if (m) { names.push(m[1]); i = re.lastIndex - 1; }
    }
  }
  return [...new Set(names)];
}

/** Float literal for WGSL (always with a point or exponent). */
const lit = (v: number) => { const s = String(v); return /[.e]/.test(s) ? s : `${s}.0`; };

/** One transition's code in its own namespace: every module-scope name gets a `__<id>` suffix. */
export function namespaced(e: Pick<TransEntry, 'id' | 'wgsl' | 'params'>): string {
  const params = Object.entries(e.params ?? {}).map(([k, p]) => `fn p_${k}() -> f32 { return ${lit(p.default)}; }`);
  const src = e.wgsl.replace(/\s+$/, '') + '\n' + (params.length ? params.join('\n') + '\n' : '');
  const names = topLevelNames(src), suf = `__${ident(e.id)}`;
  if (!names.length) return src;
  const re = new RegExp(`(?<![\\w.])(${names.map((n) => n.replace(/\$/g, '\\$')).join('|')})(?!\\w)`, 'g');
  return src.replace(re, (n) => n + suf);
}

/** prelude + each transition (kind order) + `fn trans_mix(uv) -> vec3f`, the switch the prelude calls. */
export function assembleTransitions(prelude: string, list: readonly Pick<TransEntry, 'id' | 'wgsl' | 'params' | 'kind'>[]): Assembled {
  const parts: string[] = [prelude.replace(/\s+$/, ''), ''], spans: MixSpan[] = [];
  let line = parts[0].split('\n').length + 2; // the first head (after a blank line)
  for (const e of list) {
    const head = `// ---- ${e.id} (kind ${e.kind}): lab/transitions/${e.id}/mix.wgsl`;
    const body = namespaced(e);
    parts.push(head, body);
    spans.push({ id: e.id, start: line + 1, lines: e.wgsl.split('\n').length });
    line += 1 + body.split('\n').length;
  }
  const cases = list.map((e) => `    case ${e.kind}u: { c = trans__${ident(e.id)}(uv); }`);
  parts.push('// ---- generated dispatch', 'fn trans_mix(uv: vec2f) -> vec3f {', '  var c: vec3f;', '  switch (T.kind) {',
    ...cases, '    default: { c = select(sa(uv), sb(uv), T.p >= 0.5); }', '  }', '  return c;', '}', '');
  return { code: parts.join('\n'), spans };
}

/** Map a line of the assembled code back to a mix.wgsl (null = prelude or generated code). */
export function mixLine(spans: MixSpan[], line: number): { id: string; line: number } | null {
  for (const s of spans) if (line >= s.start && line < s.start + s.lines) return { id: s.id, line: line - s.start + 1 };
  return null;
}
