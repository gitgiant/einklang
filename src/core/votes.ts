// Owner votes on scenes and transitions: the record format (data/votes.jsonl), scores, rotation weights and the
// retire rule. Shared by the server (live list) and `einklang-lab feedback` (digest). Spec: docs/prd-lab.md "Voting".

/** Reason tags the gallery offers. Tags are recorded and counted in the digest; they don't change the score. */
export const VOTE_TAGS = [
  'great colors', 'great motion', 'fits the music', 'calm', 'intense',
  'too busy', 'boring', 'too dark', 'too bright', 'ugly colors', 'off-beat', 'glitchy',
] as const;

/** Reason tags for a vote on a transition. */
export const TRANS_TAGS = [
  'love it', 'smooth', 'fits the music', 'too slow', 'too fast', 'jarring', 'boring', 'glitchy',
] as const;

interface VoteBase {
  /** Server time, ISO 8601. */
  at: string;
  vote: 1 | -1;
  tags: string[];
  /** Voted while the scene was playing in the room (keys or pad chord), not in the gallery. */
  live?: boolean;
  /** Live votes: the room tick and that tick's raw feature bytes (musical context). */
  tick?: number;
  features?: number[];
}
export interface SceneVote extends VoteBase { scene: string; transition?: undefined }
/** A vote on a transition (registered id), with the switch it was seen in: scene ids and length. */
export interface TransVote extends VoteBase { transition: string; scene?: undefined; from?: string; to?: string; beats?: number }
/** One line of data/votes.jsonl: `scene` or `transition` says which kind. */
export type Vote = SceneVote | TransVote;

/**
 * At this net score or below a scene is retired: off the live list, kept in git, still remixable. A
 * retired transition is left out of `random`, but can still be selected by name.
 */
export const RETIRE_AT = -2;

export interface Tally { up: number; down: number; tags: Record<string, number> }
export const score = (t: Tally | undefined): number => (t ? t.up - t.down : 0);

/** Count one vote into `t`. */
export function count(t: Tally, v: Vote): Tally {
  if (v.vote > 0) t.up++; else t.down++;
  for (const g of v.tags) t.tags[g] = (t.tags[g] ?? 0) + 1;
  return t;
}

/** Tallies per scene id, or per transition id. Votes of the other kind are skipped. */
export function tally(votes: Iterable<Vote>, kind: 'scene' | 'transition' = 'scene'): Map<string, Tally> {
  const out = new Map<string, Tally>();
  for (const v of votes) {
    const id = v[kind];
    if (id !== undefined) out.set(id, count(out.get(id) ?? { up: 0, down: 0, tags: {} }, v));
  }
  return out;
}

/** Rotation weight: 2^score, so a 👍 doubles it and a 👎 halves it (clamped to 1/8 .. 16). */
export const weight = (s: number): number => 2 ** Math.max(-3, Math.min(4, s));

/** Pick by weight from `ids` (excluding `not` when there is another choice). `r` in [0, 1). */
export function pickWeighted(ids: string[], scores: Record<string, number>, r: number, not?: string): string | undefined {
  const pool = ids.length > 1 && not !== undefined ? ids.filter((i) => i !== not) : ids;
  if (!pool.length) return undefined;
  const ws = pool.map((i) => weight(scores[i] ?? 0)), total = ws.reduce((a, b) => a + b, 0);
  let x = r * total;
  for (let i = 0; i < pool.length; i++) { x -= ws[i]; if (x < 0) return pool[i]; }
  return pool[pool.length - 1];
}

/** Parse votes.jsonl text, skipping malformed lines. */
export function parseVotes(text: string): Vote[] {
  const out: Vote[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const v = JSON.parse(line) as Vote;
      // exactly one of `scene` / `transition`
      if ((typeof v.scene === 'string') !== (typeof v.transition === 'string') && (v.vote === 1 || v.vote === -1)) out.push({ ...v, tags: Array.isArray(v.tags) ? v.tags.filter((t) => typeof t === 'string') : [] });
    } catch { /* a torn last line: skip */ }
  }
  return out;
}

/** Clean up untrusted tags: known ones only, no duplicates. */
export const cleanTags = (tags: unknown, known: readonly string[] = VOTE_TAGS): string[] =>
  Array.isArray(tags) ? [...new Set(tags.filter((t): t is string => known.includes(t as string)))] : [];
