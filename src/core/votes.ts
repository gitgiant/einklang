// Owner votes on scenes: the record format (data/votes.jsonl), scores, rotation weights and the
// retire rule. Shared by the server (live list) and `einklang-lab feedback` (digest). Spec: docs/prd-lab.md "Voting".

/** Reason tags the gallery offers. Tags are recorded and counted in the digest; they don't change the score. */
export const VOTE_TAGS = [
  'great colors', 'great motion', 'fits the music', 'calm', 'intense',
  'too busy', 'boring', 'too dark', 'too bright', 'ugly colors', 'off-beat', 'glitchy',
] as const;

/** One line of data/votes.jsonl. */
export interface Vote {
  scene: string;
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

/** At this net score or below a scene is retired: off the live list, kept in git, still remixable. */
export const RETIRE_AT = -2;

export interface Tally { up: number; down: number; tags: Record<string, number> }
export const score = (t: Tally | undefined): number => (t ? t.up - t.down : 0);

export function tally(votes: Iterable<Vote>): Map<string, Tally> {
  const out = new Map<string, Tally>();
  for (const v of votes) {
    const t = out.get(v.scene) ?? { up: 0, down: 0, tags: {} };
    if (v.vote > 0) t.up++; else t.down++;
    for (const g of v.tags) t.tags[g] = (t.tags[g] ?? 0) + 1;
    out.set(v.scene, t);
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
      if (typeof v.scene === 'string' && (v.vote === 1 || v.vote === -1)) out.push({ ...v, tags: Array.isArray(v.tags) ? v.tags.filter((t) => typeof t === 'string') : [] });
    } catch { /* a torn last line: skip */ }
  }
  return out;
}

/** Clean up untrusted tags: known ones only, no duplicates. */
export const cleanTags = (tags: unknown): string[] =>
  Array.isArray(tags) ? [...new Set(tags.filter((t): t is string => (VOTE_TAGS as readonly string[]).includes(t as string)))] : [];
