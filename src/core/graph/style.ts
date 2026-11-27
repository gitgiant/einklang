// Style packs (lab/styles/<id>.json): a reusable look (palette + FX chain + post + font) a scene opts into
// with `"style": "<id>"`. Expanded into plain graph nodes before compiling, so the hash, the gate and the
// digest see an ordinary scene.
import type { PieceManifest } from '../../../lab/api/index.ts';
import { hexToOklab } from '../../../lab/api/index.ts';
import { POST_KEYS, type PostParams } from '../post.ts';
import { splitRef, type Registry, type SceneGraph } from './types.ts';
import { sectionGraphs } from './sections.ts';

export interface StylePack {
  format: 1;
  id: string;
  name: string;
  doc?: string;
  author: { vendor: string; model?: string };
  /** 2-8 '#rrggbb' colours: every palette input in the scene gets them (via core-swatch). */
  palette: string[];
  /** Effects appended after the scene output, in order (pieces with one tex input and a tex output). */
  fx?: { piece: string; params?: Record<string, number | boolean | string> }[];
  /** Post settings; the scene's own post keys win. */
  post?: Partial<PostParams>;
  /** A font name: nodes with a `font` enum param that offers it use it unless they set one. */
  font?: string;
  /** Swatch cycling (steps per bar). */
  cycle?: number;
}
export type Styles = Map<string, StylePack>;

const ID = /^[a-z0-9]+(-[a-z0-9]+)+$/;
const texIn = (m: PieceManifest) => Object.entries(m.ports.in ?? {}).filter(([, p]) => p.type === 'tex');

export function validateStyle(s: StylePack, reg: Registry): string[] {
  const errs: string[] = [], err = (x: string) => errs.push(`style ${s.id ?? '?'}: ${x}`);
  if (s.format !== 1) err('format must be 1');
  if (typeof s.id !== 'string' || !ID.test(s.id)) err('id must be <vendor>-<slug>');
  if (!s.name) err('name required');
  if (!s.author?.vendor) err('author.vendor required');
  if (!Array.isArray(s.palette) || s.palette.length < 2 || s.palette.length > 8) err('palette: 2 to 8 colours');
  else for (const c of s.palette) if (!hexToOklab(c)) err(`palette: ${c} is not #rrggbb`);
  for (const [i, f] of (s.fx ?? []).entries()) {
    const m = reg.get(f.piece)?.manifest;
    if (!m) { err(`fx ${i}: unknown piece ${f.piece}`); continue; }
    if (texIn(m).length !== 1 || !Object.values(m.ports.out).some((p) => p.type === 'tex')) err(`fx ${i}: ${f.piece} needs exactly one tex input and a tex output`);
    for (const k of Object.keys(f.params ?? {})) if (!m.params?.[k]) err(`fx ${i}: ${f.piece} has no param ${k}`);
  }
  for (const [k, v] of Object.entries(s.post ?? {})) if (!(POST_KEYS as string[]).includes(k) || typeof v !== 'number') err(`post.${k}: unknown key or not a number`);
  if (s.font !== undefined && typeof s.font !== 'string') err('font must be a font name');
  return errs;
}

/**
 * The scene with its style expanded: a `style_palette` swatch feeds every palette input (replacing the
 * scene's own palette edges), the FX chain follows the output, post merges under the scene's, and the
 * font applies where a node offers it. A scene without `style` comes back unchanged.
 */
export function applyStyle(g: SceneGraph, styles: Styles, reg: Registry): SceneGraph {
  if (!g.style) return g;
  if (g.sections) {
    // every variant is expanded first, then styled, so its own nodes and out get the look too
    const graphs = sectionGraphs({ ...g, expanded: undefined }).map((x) => styleOne({ ...x, style: g.style }, styles, reg));
    return { ...graphs[0], sections: g.sections, expanded: graphs };
  }
  return styleOne(g, styles, reg);
}

function styleOne(g: SceneGraph, styles: Styles, reg: Registry): SceneGraph {
  const s = styles.get(g.style!);
  if (!s) throw new Error(`${g.id}: unknown style ${g.style}`);
  const nodes = g.nodes.map((n) => ({ ...n, params: { ...n.params } }));
  const pal = 'style_palette';
  if (nodes.some((n) => n.id === pal || n.id.startsWith('style_fx'))) throw new Error(`${g.id}: node ids style_* are reserved for the style`);
  nodes.push({ id: pal, piece: 'core-swatch', params: { colors: s.palette.join(' '), cycle: s.cycle ?? 0 } });
  const isPaletteIn = (ref: string) => { const [n, p] = splitRef(ref), m = reg.get(nodes.find((x) => x.id === n)?.piece ?? '')?.manifest; return m?.ports.in?.[p]?.type === 'palette'; };
  const edges = g.edges.filter((e) => !isPaletteIn(e.to));
  for (const n of nodes) {
    const m = reg.get(n.piece)?.manifest;
    for (const [p, spec] of Object.entries(m?.ports.in ?? {})) if (spec.type === 'palette' && n.id !== pal) edges.push({ from: `${pal}.palette`, to: `${n.id}.${p}` });
    const font = m?.params?.font;
    if (s.font && font?.type === 'enum' && n.params.font === undefined) {
      const i = font.options?.indexOf(s.font) ?? -1;
      if (i >= 0) n.params.font = i;
    }
  }
  let out = g.out;
  (s.fx ?? []).forEach((f, i) => {
    const m = reg.get(f.piece)?.manifest;
    if (!m) throw new Error(`style ${s.id}: unknown piece ${f.piece}`);
    const id = `style_fx${i}`, [inPort] = texIn(m)[0], outPort = Object.entries(m.ports.out).find(([, p]) => p.type === 'tex')![0];
    nodes.push({ id, piece: f.piece, params: { ...f.params } });
    edges.push({ from: out, to: `${id}.${inPort}` });
    for (const [p, spec] of Object.entries(m.ports.in ?? {})) if (spec.type === 'palette') edges.push({ from: `${pal}.palette`, to: `${id}.${p}` });
    out = `${id}.${outPort}`;
  });
  return { ...g, nodes, edges, out, post: { ...s.post, ...g.post } };
}
