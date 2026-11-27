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
  /** A style pack id (lab/styles/<id>.json): palette, FX chain, post and font, expanded before compiling. */
  style?: string;
  /** Settings for the show's post node (trails, bloom, exposure); unset keys use POST_DEFAULT. */
  post?: Partial<PostParams>;
  /** Variants of this graph keyed to song structure, a signal or an input (see sections.ts, lab/AGENTS.md "Sections"). */
  sections?: Sections;
  /** Filled in by applyStyle for a scene with sections: every variant, expanded and styled (not in files). */
  expanded?: SceneGraph[];
  /** Slots that swap pieces over time, steered by votes (see evolve.ts, lab/AGENTS.md "Evolving scenes"). */
  evolve?: Evolve;
  /** Filled in by resolveEvolve: the pools expanded and weighted by the scores in effect (not in files). */
  evolved?: import('./evolve.ts').ResolvedEvolve;
}

/** One candidate of an evolve slot: a piece, its fixed params, ranges params are drawn from, its own bindings. */
export interface EvolveCandidate {
  piece: string;
  params?: Record<string, ParamValue>;
  /** Drawn uniformly at each step that brings this candidate in: float, int or enum params. */
  ranges?: Record<string, [number, number]>;
  bind?: Record<string, Binding>;
}

/** A node of the base graph whose piece is swapped for candidates that fit the same ports. */
export interface EvolveSlot {
  node: string;
  /** Explicit candidates (piece ids or full entries); the base node is always candidate 0. */
  pool?: (string | EvolveCandidate)[];
  /** Candidates from the registry: kind (default the base piece's), any of the tags, vendors, exclusions. */
  filter?: { kind?: string; tags?: string[]; vendor?: string[]; exclude?: string[] };
  /** Pool cap, base included (default and max 6). */
  max?: number;
  /** Float params without a range move by up to this share of their span (default 0.08; 0 = off). */
  jitter?: number;
}

export interface Evolve {
  /** Cadence: a step every bar, every phrase (default), every N bars (1..16), or on song-section changes. */
  every?: 'bar' | 'phrase' | 'section' | number;
  /** With every "section": phrases without a change before it steps anyway (1..16, default 4). */
  most?: number;
  /** The blend into the swapped piece: a registered id or "random" (default core-blend), over `beats` (default 4). */
  transition?: string;
  beats?: number;
  slots: EvolveSlot[];
}

/** When a section variant is active, checked at each boundary; every key given must hold. */
export interface SectionWhen {
  /** Song structure from the features (src/core/songform.ts): one name or a list. */
  section?: string | string[];
  /** A signal output of a base-graph node, sampled at the boundary, against above / below. */
  signal?: PortRef;
  /** A MIDI CC param 0..3 (mod wheel, cutoff, resonance, pan; 0..1), against above / below. */
  cc?: number;
  above?: number; below?: number;
  /** A MIDI note-on (pitch, or [lo, hi]) within the last `hold` units before the boundary. */
  note?: number | [number, number];
  /** Units a note keeps its section (default 1). */
  hold?: number;
  /** The room's cue (keyboard 1-9, pad Select + D-pad): this value. */
  cue?: number;
}

/** A variant of the base graph: changes relative to it, applied in this order. */
export interface SectionVariant {
  /** lower_snake, not "base". */
  id: string;
  when: SectionWhen;
  /** Nodes removed (with their edges). */
  remove?: string[];
  /** Nodes added; one with an existing id replaces that node (its edges stay). */
  nodes?: GraphNode[];
  /** Param values merged into nodes: { nodeId: { param: value } }. */
  params?: Record<string, Record<string, ParamValue>>;
  /** Bindings merged into nodes; null drops one: { nodeId: { param: Binding | null } }. */
  bind?: Record<string, Record<string, Binding | null>>;
  /** Inputs left unconnected ("node.port", optional inputs only). */
  unwire?: PortRef[];
  /** Edges added; one into an input that is already fed replaces that edge. */
  edges?: { from: PortRef; to: PortRef }[];
  out?: PortRef;
  post?: Partial<PostParams>;
  /** How this variant comes in (else the sections' transition / beats). */
  transition?: string; beats?: number;
}

export interface Sections {
  /** Boundaries: every bar, every phrase (4 bars, the default), or every N bars (1..16). */
  on?: 'bar' | 'phrase' | number;
  /** The transition between variants: a registered id or "random" (default core-blend). */
  transition?: string;
  /** Its length in beats, clamped to the unit (default 4). */
  beats?: number;
  /** Checked in order at each boundary: the first whose `when` holds is shown, none = the base graph. */
  variants: SectionVariant[];
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
