// The gallery picker's scene list (pure, unit-tested): tags, search, filter chips, sorting.
import type { SceneGraph } from '../core/graph/types.ts';

export interface SceneItem {
  id: string; name: string; vendor: string;
  tags: string[];
  /** yyyy-mm-dd ('' = unknown). */
  created: string;
  score: number;
}
export type SceneSort = 'score' | 'newest' | 'name';
export interface SceneFilter {
  query: string;
  /** Any of these vendors (none picked = all). */
  vendors: ReadonlySet<string>;
  /** All of these tags. */
  tags: ReadonlySet<string>;
  sort: SceneSort;
}

/** Chips shown first, in this order; the others follow by how many scenes carry them. */
const FIRST_TAGS = ['media', 'evolve', 'sections', 'pixel', 'vapor'];
const ALIAS: Record<string, string> = { vaporwave: 'vapor' };
/** Tags that say nothing about a scene. */
const NOISE = new Set(['core', 'input']);
/** Words of a scene id or style that count as tags even when no piece carries them. */
const ID_TAGS = new Set([...FIRST_TAGS, 'vaporwave', 'glitch', 'retro']);

/** A scene's tags: its pieces' (sections' variants too), `evolve` / `sections`, and telling words of its id and style. */
export function sceneTags(g: SceneGraph, pieceTags: (piece: string) => readonly string[]): string[] {
  const pieces = [...g.nodes, ...(g.sections?.variants ?? []).flatMap((v) => v.nodes ?? [])].map((n) => n.piece);
  const words = `${g.id}-${g.style ?? ''}`.split('-').filter((w) => ID_TAGS.has(w));
  const all = [...pieces.flatMap(pieceTags), ...words, ...(g.evolve ? ['evolve'] : []), ...(g.sections ? ['sections'] : [])];
  return [...new Set(all.map((t) => ALIAS[t] ?? t).filter((t) => !NOISE.has(t)))].sort();
}

/** The filter chips: every vendor, and the tags on at least `min` scenes (the first tags on any). */
export function facets(items: readonly SceneItem[], min = 3): { vendors: string[]; tags: string[] } {
  const n = new Map<string, number>();
  for (const it of items) for (const t of it.tags) n.set(t, (n.get(t) ?? 0) + 1);
  const rest = [...n].filter(([t, c]) => c >= min && !FIRST_TAGS.includes(t)).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([t]) => t);
  return { vendors: [...new Set(items.map((i) => i.vendor))].sort(), tags: [...FIRST_TAGS.filter((t) => n.has(t)), ...rest] };
}

/** The scenes matching the filter, sorted; every word of the query must occur in the name, id, vendor or a tag. */
export function filterScenes(items: readonly SceneItem[], f: SceneFilter): SceneItem[] {
  const words = f.query.toLowerCase().split(/\s+/).filter(Boolean);
  const byName = (a: SceneItem, b: SceneItem) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
  const order: Record<SceneSort, (a: SceneItem, b: SceneItem) => number> = {
    score: (a, b) => b.score - a.score || byName(a, b),
    newest: (a, b) => b.created.localeCompare(a.created) || byName(a, b),
    name: byName,
  };
  return items.filter((it) => {
    if (f.vendors.size && !f.vendors.has(it.vendor)) return false;
    if (![...f.tags].every((t) => it.tags.includes(t))) return false;
    const hay = `${it.name} ${it.id} ${it.vendor} ${it.tags.join(' ')}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  }).sort(order[f.sort]);
}

/** The next / previous entry of `list` from `current`, wrapping; an unlisted `current` counts as the first. */
export function stepChoice<T>(list: readonly T[], current: T, by: number): T {
  const i = Math.max(0, list.indexOf(current));
  return list[(((i + by) % list.length) + list.length) % list.length];
}
