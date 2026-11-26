// Scene graph format (lab/scenes/<id>.json) and the loaded piece registry.
import type { ParamValue, PieceDriver, PieceManifest } from '../../../lab/api/index.ts';
import type { PostParams } from '../post.ts';

/** "node.port" */
export type PortRef = string;

/** A param driven by a signal: v (0..1 by convention) maps to lo + v * (hi - lo). */
export interface Binding { from: PortRef; range?: [number, number] }

export interface GraphNode {
  id: string;
  piece: string;
  params?: Record<string, ParamValue>;
  bind?: Record<string, Binding>;
}

export interface SceneGraph {
  format: 1;
  id: string;
  name: string;
  /** Bumped on every edit (it joins the hash). */
  version: number;
  author: { vendor: string; model?: string };
  parent?: string;
  status?: 'live' | 'retired';
  created?: string;
  nodes: GraphNode[];
  edges: { from: PortRef; to: PortRef }[];
  /** The scene's image output, a tex port. */
  out: PortRef;
  /** Settings for the show's post node (trails, bloom, exposure); unset keys use POST_DEFAULT. */
  post?: Partial<PostParams>;
}

/** A loaded piece: manifest, optional driver, WGSL sources by file name. */
export interface PieceDef {
  manifest: PieceManifest; driver?: PieceDriver; wgsl: Record<string, string>;
  /** Bytes of the declared assets by manifest path (absent ones are missing on disk: lint reports them). */
  assets?: Record<string, Uint8Array>;
}
export type Registry = Map<string, PieceDef>;

/** Where a declared asset lives, relative to lab/: `assets/...` is shared, anything else is in the piece folder. */
export const assetFile = (m: Pick<PieceManifest, 'kind' | 'id'>, path: string): string =>
  path.startsWith('assets/') ? path : `pieces/${m.kind}/${m.id}/${path}`;

export const splitRef = (r: PortRef): [string, string] => {
  const i = r.indexOf('.');
  return i < 0 ? [r, ''] : [r.slice(0, i), r.slice(i + 1)];
};
