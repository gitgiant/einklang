// Piece harness: a small scene that shows one piece on its own, so the lab can render and gate a
// piece before any scene uses it. Image inputs are fed a plasma, mask and field inputs the luma and
// edges of core-media (the lab's generated test media), palette inputs a harmony palette, signal and
// trigger inputs a band follower and the onsets; a second image input gets bars. Signal outputs drive
// a plasma.
import type { PieceManifest } from '../../../lab/api/index.ts';
import type { GraphNode, Registry, SceneGraph } from './types.ts';

export const harnessId = (pieceId: string) => `lab-harness-${pieceId}`;

/** The harness scene for a piece, or the reason there isn't one. `base`: the same harness without the piece (its cost baseline). */
export function harness(pieceId: string, reg: Registry, base = false): SceneGraph | string {
  const def = reg.get(pieceId);
  if (!def) return `unknown piece ${pieceId}`;
  const m: PieceManifest = def.manifest;
  const nodes: GraphNode[] = [{ id: 'pal', piece: 'core-harmony', params: { scheme: 4 } }];
  const edges: SceneGraph['edges'] = [];
  let out = '';
  const src = () => {
    if (!nodes.some((n) => n.id === 'src')) {
      nodes.push({ id: 'src', piece: 'core-plasma', params: { gain: 0.6 } });
      edges.push({ from: 'pal.palette', to: 'src.palette' });
    }
    return 'src.out';
  };
  // a second image input sees bars, so switches and crossfades show a change
  const src2 = () => {
    if (!nodes.some((n) => n.id === 'src2')) {
      nodes.push({ id: 'src2', piece: 'core-bars' });
      edges.push({ from: 'pal.palette', to: 'src2.palette' });
    }
    return 'src2.out';
  };
  const mod = (port: 'out' | 'onset') => {
    if (port === 'out' && !nodes.some((n) => n.id === 'fol')) nodes.push({ id: 'fol', piece: 'core-follow' });
    if (port === 'onset' && !nodes.some((n) => n.id === 'aud')) nodes.push({ id: 'aud', piece: 'core-audio' });
    return port === 'out' ? 'fol.out' : 'aud.onset';
  };
  const media = (port: 'luma' | 'edges') => {
    if (!nodes.some((n) => n.id === 'media')) nodes.push({ id: 'media', piece: 'core-media' });
    return `media.${port}`;
  };
  const outs = Object.entries(m.ports.out);
  const texOut = outs.find(([, p]) => p.type === 'tex');
  if (texOut) {
    if (base) {
      // the inputs alone: what the harness costs without the piece
      let k = 0;
      for (const p of Object.values(m.ports.in ?? {})) if (p.type === 'tex') { if (k++ === 1) src2(); else src(); } else if (p.type === 'mask' || p.type === 'field') media('luma');
      if (!nodes.some((n) => n.id === 'src')) nodes.push({ id: 'src', piece: 'core-bars', params: { glow: 0 } }), edges.push({ from: 'pal.palette', to: 'src.palette' });
      out = 'src.out';
    } else {
      nodes.push({ id: 'p', piece: pieceId });
      let k = 0;
      for (const [name, p] of Object.entries(m.ports.in ?? {})) {
        if (p.type === 'tex') edges.push({ from: k++ === 1 ? src2() : src(), to: `p.${name}` });
        else if (p.type === 'signal') edges.push({ from: mod('out'), to: `p.${name}` });
        else if (p.type === 'trigger') edges.push({ from: mod('onset'), to: `p.${name}` });
        else if (p.type === 'mask') edges.push({ from: media('luma'), to: `p.${name}` });
        else if (p.type === 'field') edges.push({ from: media('edges'), to: `p.${name}` });
        else if (p.type === 'palette') edges.push({ from: 'pal.palette', to: `p.${name}` });
        else if (!p.optional) return `the harness can't feed ${p.type} input ${name}: render it in a scene`;
      }
      out = `p.${texOut[0]}`;
    }
  } else if (outs.some(([, p]) => p.type === 'palette')) {
    const pal = outs.find(([, p]) => p.type === 'palette')![0];
    if (!base) nodes.push({ id: 'p', piece: pieceId });
    nodes.push({ id: 'show', piece: 'core-plasma', params: { gain: 0.7 } }, { id: 'bars', piece: 'core-bars' }, { id: 'mix', piece: 'core-blend' });
    const from = base ? 'pal.palette' : `p.${pal}`;
    edges.push({ from, to: 'show.palette' }, { from, to: 'bars.palette' }, { from: 'show.out', to: 'mix.a' }, { from: 'bars.out', to: 'mix.b' });
    out = 'mix.out';
  } else if (outs.some(([, p]) => p.type === 'signal')) {
    const sig = outs.find(([, p]) => p.type === 'signal')![0];
    if (!base) {
      nodes.push({ id: 'p', piece: pieceId });
      for (const [name, p] of Object.entries(m.ports.in ?? {})) {
        if (p.type === 'signal') edges.push({ from: mod('out'), to: `p.${name}` });
        else if (p.type === 'trigger') edges.push({ from: mod('onset'), to: `p.${name}` });
        else if (!p.optional) return `the harness can't feed ${p.type} input ${name}: render it in a scene`;
      }
    }
    nodes.push({ id: 'show', piece: 'core-plasma', params: { gain: 0.5 }, bind: base ? undefined : { warp: { from: `p.${sig}` }, gain: { from: `p.${sig}`, range: [0.1, 1.2] } } });
    edges.push({ from: 'pal.palette', to: 'show.palette' });
    out = 'show.out';
  } else return `the harness can't show a piece with outputs ${outs.map(([, p]) => p.type).join(', ')}: render it in a scene`;
  return {
    format: 1, id: harnessId(pieceId) + (base ? '-base' : ''), name: `${m.name} (harness)`, version: 1,
    author: { vendor: 'lab' }, nodes, edges, out,
  };
}
