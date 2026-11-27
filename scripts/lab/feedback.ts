// The vote digest agents read (they have no network): `einklang-lab feedback` turns data/votes.jsonl into
// lab/feedback.json + lab/FEEDBACK.md and retires scenes at net <= RETIRE_AT. Transitions are scored too; their
// retirement (left out of `random`) follows from the votes alone, so no transition file changes. The caller (the
// delegator) commits them. Spec: docs/prd-lab.md "Voting".
import type { Registry, SceneGraph } from '../../src/core/graph/types.ts';
import { CUT_ID } from '../../src/core/transitions.ts';
import { RETIRE_AT, count, score, tally, type EvolveVote, type SceneVote, type Tally, type TransVote, type Vote } from '../../src/core/votes.ts';

export interface Score { up: number; down: number; score: number; tags: Record<string, number> }
export interface SceneScore extends Score { name: string; vendor: string; live: number; status: 'live' | 'retired'; pieces: string[] }
export interface TransScore extends Score {
  name: string; vendor: string; live: number;
  /** retired: left out of `random`, still selectable by name. */
  status: 'live' | 'retired';
  /** Where it was voted on: scene pair and length, with the votes cast there. */
  contexts: { from: string; to: string; beats: number | null; up: number; down: number }[];
}
/** A state of an evolving scene that was voted on: its step when last liked (or seen) and the pieces + params shown. */
export interface StateScore extends Score { step: number; slots: EvolveVote['slots'] }
/** Votes cast while an evolving scene showed: per slot and piece, and per state (key = "slot=piece,..."). */
export interface EvolveScore { slots: Record<string, Record<string, Score>>; states: Record<string, StateScore> }
export interface Digest {
  votes: number;
  /** Date of the newest vote (ISO), or null. */
  latest: string | null;
  scenes: Record<string, SceneScore>;
  /** Credit flows to every piece a scene uses (once per scene). */
  pieces: Record<string, Score & { vendor: string; scenes: number }>;
  /** By the vendor that authored the scene, and by the vendor of each piece. */
  vendors: Record<string, { scenes: Score; pieces: Score; transitions: Score }>;
  /** Reason tags on scene votes. */
  tags: Record<string, number>;
  /** Every transition but cut, and the reason tags on transition votes. */
  transitions: Record<string, TransScore>;
  transitionTags: Record<string, number>;
  /** Scenes this run moved to retired. */
  retired: string[];
  /** Evolving scenes: which mutations the votes liked (their slot scores weight the pools, with the piece scores). */
  evolve: Record<string, EvolveScore>;
}

const zero = (): Score => ({ up: 0, down: 0, score: 0, tags: {} });
function add(into: Score, t: Tally | Score): void {
  into.up += t.up; into.down += t.down; into.score = into.up - into.down;
  for (const [k, n] of Object.entries(t.tags)) into.tags[k] = (into.tags[k] ?? 0) + n;
}

function contexts(votes: TransVote[]): TransScore['contexts'] {
  const out = new Map<string, TransScore['contexts'][number]>();
  for (const v of votes) {
    if (!v.from || !v.to) continue;
    const key = `${v.from} ${v.to} ${v.beats}`, c = out.get(key) ?? { from: v.from, to: v.to, beats: v.beats ?? null, up: 0, down: 0 };
    if (v.vote > 0) c.up++; else c.down++;
    out.set(key, c);
  }
  return [...out.values()];
}

/** Pure: the digest of `votes` over `scenes`. Scenes at net <= RETIRE_AT come back with status retired. */
export function digest(votes: Vote[], scenes: SceneGraph[], reg: Registry, transitions: readonly { id: string; name: string; vendor: string }[] = []): Digest {
  const t = tally(votes), d: Digest = { votes: votes.length, latest: null, scenes: {}, pieces: {}, vendors: {}, tags: {}, transitions: {}, transitionTags: {}, retired: [], evolve: {} };
  for (const v of votes) if (!d.latest || v.at > d.latest) d.latest = v.at;
  const vendor = (name: string) => (d.vendors[name] ??= { scenes: zero(), pieces: zero(), transitions: zero() });
  for (const g of scenes) {
    const tl = t.get(g.id) ?? { up: 0, down: 0, tags: {} }, pieces = [...new Set(g.nodes.map((n) => n.piece))].sort();
    const was = g.status ?? 'live', status = score(tl) <= RETIRE_AT ? 'retired' : was;
    if (status === 'retired' && was !== 'retired') d.retired.push(g.id);
    const s: SceneScore = { ...zero(), name: g.name, vendor: g.author.vendor, live: votes.filter((v) => v.scene === g.id && v.live).length, status, pieces };
    add(s, tl);
    d.scenes[g.id] = s;
    const mine = votes.filter((v): v is SceneVote => v.scene === g.id), slots = new Set((g.evolve?.slots ?? []).map((x) => x.node));
    if (g.evolve) d.evolve[g.id] = evolveScore(mine.filter((v) => v.evolve && Object.keys(v.evolve.slots).every((n) => slots.has(n))));
    if (!tl.up && !tl.down) continue;
    add(vendor(g.author.vendor).scenes, tl);
    // credit goes to the pieces on screen: an evolving scene's slots to the piece the vote saw there
    const credit = new Map<string, Tally>();
    for (const v of mine) {
      const seen = v.evolve?.slots ?? {}, on = new Set(g.nodes.filter((n) => !(slots.has(n.id) && seen[n.id])).map((n) => n.piece));
      for (const [n, x] of Object.entries(seen)) if (slots.has(n)) on.add(x.piece);
      for (const p of on) credit.set(p, count(credit.get(p) ?? { up: 0, down: 0, tags: {} }, v));
    }
    for (const [p, ct] of [...credit].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      const pv = reg.get(p)?.manifest.author.vendor ?? '?';
      const ps = (d.pieces[p] ??= { ...zero(), vendor: pv, scenes: 0 });
      add(ps, ct); ps.scenes++;
      add(vendor(pv).pieces, ct);
    }
    for (const [k, n] of Object.entries(tl.tags)) d.tags[k] = (d.tags[k] ?? 0) + n;
  }
  const tt = tally(votes, 'transition');
  for (const e of transitions) {
    if (e.id === CUT_ID) continue;
    const tl = tt.get(e.id) ?? { up: 0, down: 0, tags: {} }, mine = votes.filter((v): v is TransVote => v.transition === e.id);
    const s: TransScore = { ...zero(), name: e.name, vendor: e.vendor, live: mine.filter((v) => v.live).length, status: score(tl) <= RETIRE_AT ? 'retired' : 'live', contexts: contexts(mine) };
    add(s, tl);
    d.transitions[e.id] = s;
    if (!tl.up && !tl.down) continue;
    add(vendor(e.vendor).transitions, tl);
    for (const [k, n] of Object.entries(tl.tags)) d.transitionTags[k] = (d.transitionTags[k] ?? 0) + n;
  }
  return d;
}

function evolveScore(votes: SceneVote[]): EvolveScore {
  const e: EvolveScore = { slots: {}, states: {} }, one = (v: Vote) => count({ up: 0, down: 0, tags: {} }, v);
  for (const v of votes) {
    const ev = v.evolve!;
    for (const [node, x] of Object.entries(ev.slots)) add(((e.slots[node] ??= {})[x.piece] ??= zero()), one(v));
    const st = (e.states[ev.key] ??= { ...zero(), step: ev.step, slots: ev.slots });
    add(st, one(v));
    // freeze uses the params of the latest thumbs-up
    if (v.vote > 0) { st.step = ev.step; st.slots = ev.slots; }
  }
  return e;
}

const signed = (n: number) => (n > 0 ? `+${n}` : String(n));
const topTags = (tags: Record<string, number>, n = 3) => Object.entries(tags).sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, c]) => `${k} ×${c}`).join(', ');

/** The readable digest for agents. */
export function feedbackMd(d: Digest): string {
  const voted = Object.entries(d.scenes).filter(([, s]) => s.up || s.down).sort((a, b) => b[1].score - a[1].score || b[1].up - a[1].up);
  const row = ([id, s]: [string, SceneScore]) => `| ${id} | ${s.name} | ${s.vendor} | ${signed(s.score)} (${s.up}↑ ${s.down}↓) | ${topTags(s.tags) || '-'} | ${s.pieces.join(', ')} |`;
  const head = '| scene | name | vendor | score | tags | pieces |\n|---|---|---|---|---|---|';
  const pieces = Object.entries(d.pieces).sort((a, b) => b[1].score - a[1].score);
  const liked = pieces.filter(([, p]) => p.score > 0), avoid = pieces.filter(([, p]) => p.score < 0).reverse();
  const trans = Object.entries(d.transitions);
  const tVoted = trans.filter(([, s]) => s.up || s.down).sort((a, b) => b[1].score - a[1].score || b[1].up - a[1].up);
  const where = (s: TransScore, up: boolean) => s.contexts.filter((c) => (up ? c.up > c.down : c.down > c.up)).slice(-3)
    .map((c) => `${c.from}→${c.to}${c.beats ? ` @${c.beats}` : ''}`).join(', ') || '-';
  const tHead = '| transition | name | vendor | score | tags | liked on (from→to @beats) | disliked on |\n|---|---|---|---|---|---|---|';
  const tRow = ([id, s]: [string, TransScore]) => `| ${id} | ${s.name} | ${s.vendor} | ${signed(s.score)} (${s.up}↑ ${s.down}↓) | ${topTags(s.tags) || '-'} | ${where(s, true)} | ${where(s, false)} |`;
  const tTop = tVoted.filter(([, s]) => s.score > 0).slice(0, 8), tBottom = tVoted.filter(([, s]) => s.score < 0).reverse().slice(0, 8);
  const tUnvoted = trans.filter(([, s]) => !s.up && !s.down).map(([id]) => id);
  const tRetired = trans.filter(([, s]) => s.status === 'retired');
  const unvoted = Object.entries(d.scenes).filter(([, s]) => !s.up && !s.down && s.status === 'live').map(([id]) => id);
  return [
    '# Lab feedback',
    '',
    `Generated by \`npm run lab -- feedback\` from ${d.votes} owner vote(s)${d.latest ? `, newest ${d.latest.slice(0, 10)}` : ''}. Score = ups − downs; at ${RETIRE_AT} a scene is retired (a transition leaves \`random\`). Read this before picking work: build more of what is liked, fix or avoid what is not.`,
    '',
    '## Top scenes', '', voted.length ? [head, ...voted.filter(([, s]) => s.score > 0).slice(0, 8).map(row)].join('\n') : 'No votes yet.',
    '',
    '## Bottom scenes', '', voted.some(([, s]) => s.score < 0) ? [head, ...voted.filter(([, s]) => s.score < 0).reverse().slice(0, 8).map(row)].join('\n') : 'None.',
    '',
    '## Pieces liked', '', liked.length ? liked.slice(0, 10).map(([id, p]) => `- **${id}** ${signed(p.score)} over ${p.scenes} scene(s)${topTags(p.tags) ? ` · ${topTags(p.tags)}` : ''}`).join('\n') : 'None yet.',
    '',
    '## Pieces to avoid or fix', '', avoid.length ? avoid.slice(0, 10).map(([id, p]) => `- **${id}** ${signed(p.score)} over ${p.scenes} scene(s)${topTags(p.tags) ? ` · ${topTags(p.tags)}` : ''}`).join('\n') : 'None.',
    '',
    '## Top transitions', '', tVoted.length ? (tTop.length ? [tHead, ...tTop.map(tRow)].join('\n') : 'None.') : 'No votes yet.',
    '',
    '## Bottom transitions', '', tBottom.length ? [tHead, ...tBottom.map(tRow)].join('\n') : 'None.',
    '',
    '## Evolving scenes', '', evolveMd(d),
    '',
    '## Vendors', '', '| vendor | scenes | pieces | transitions |\n|---|---|---|---|',
    ...Object.entries(d.vendors).sort().map(([v, s]) => `| ${v} | ${[s.scenes, s.pieces, s.transitions].map((x) => `${signed(x.score)} (${x.up}↑ ${x.down}↓)`).join(' | ')} |`),
    '',
    '## Reason tags', '', Object.keys(d.tags).length ? topTags(d.tags, 20) : 'None yet.',
    '',
    '## Transition reason tags', '', Object.keys(d.transitionTags).length ? topTags(d.transitionTags, 20) : 'None yet.',
    '',
    '## Retired transitions', '', tRetired.map(([id, s]) => `- ${id} (${signed(s.score)}): out of \`random\`, still selectable`).join('\n') || 'None.',
    '',
    '## Transitions not voted on yet', '', tUnvoted.join(', ') || 'None.',
    '',
    '## Retired', '', Object.entries(d.scenes).filter(([, s]) => s.status === 'retired').map(([id, s]) => `- ${id} (${signed(s.score)})`).join('\n') || 'None.',
    '',
    '## Not voted on yet', '', unvoted.join(', ') || 'None.',
    '',
  ].join('\n');
}

/** Liked and disliked states of evolving scenes, and per-slot picks. */
function evolveMd(d: Digest): string {
  const rows = Object.entries(d.evolve).flatMap(([scene, e]) => Object.entries(e.states).map(([key, s]) => ({ scene, key, s })));
  if (!rows.length) return 'No votes on evolving scenes yet. A vote cast while one shows records its state (the pieces and params in its slots).';
  const head = '| scene | state | score | step | tags |\n|---|---|---|---|---|';
  const row = (r: (typeof rows)[number]) => `| ${r.scene} | \`${r.key}\` | ${signed(r.s.score)} (${r.s.up}↑ ${r.s.down}↓) | s${r.s.step} | ${topTags(r.s.tags) || '-'} |`;
  const liked = rows.filter((r) => r.s.score > 0).sort((a, b) => b.s.score - a.s.score).slice(0, 10);
  const disliked = rows.filter((r) => r.s.score < 0).sort((a, b) => a.s.score - b.s.score).slice(0, 10);
  const slots = Object.entries(d.evolve).flatMap(([scene, e]) => Object.entries(e.slots).map(([node, ps]) => {
    const list = Object.entries(ps).sort((a, b) => b[1].score - a[1].score).map(([p, s]) => `${p} ${signed(s.score)}`).join(', ');
    return `- ${scene} · ${node}: ${list}`;
  }));
  return [
    'Liked states can become scenes of their own: `npm run lab -- evolve freeze <scene> "<state>"` (writes a scene with `parent`). Slot scores add to the piece scores when the pool is weighted.',
    '', '### Liked mutations', '', liked.length ? [head, ...liked.map(row)].join('\n') : 'None yet.',
    '', '### Disliked mutations', '', disliked.length ? [head, ...disliked.map(row)].join('\n') : 'None.',
    '', '### Per slot', '', slots.join('\n') || 'None.',
  ].join('\n');
}
