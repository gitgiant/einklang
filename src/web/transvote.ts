// The "transition: <name>" vote row of both pages: 👍/👎 and reason tags for the transition in
// progress, or else the last one that ran. Hidden until one has.
import type { RanTrans } from '../core/protocol.ts';
import { transName } from '../core/transitions.ts';
import { RETIRE_AT, TRANS_TAGS } from '../core/votes.ts';

/** Keys for the transition vote (`+` / `-` vote on the scene, and are shift + `=` / `-`). */
export const TRANS_KEYS = { up: '.', down: ',' } as const;

export interface TransRow {
  el: HTMLElement;
  /** A transition is running or has run; null (a cut, nothing yet) keeps the last one. */
  ran(t: RanTrans | null): void;
  /** Redraw with the current scores; `online` false disables voting. */
  show(scores: Record<string, number>, online: boolean): void;
  /** Vote on the transition shown, with the picked tags. Nothing before one has run, or offline. */
  vote(v: 1 | -1): void;
  /** The confirmation after a vote; clears the picked tags. */
  saved(text: string): void;
  note(text: string): void;
}

export function transRow(post: (t: RanTrans, vote: 1 | -1, tags: string[]) => void): TransRow {
  const el = document.createElement('div'); el.className = 'trow hide';
  const label = document.createElement('span'), up = document.createElement('button'), down = document.createElement('button');
  const tags = document.createElement('div'); tags.className = 'ttags';
  const note = document.createElement('span'); note.className = 'tnote';
  up.textContent = '👍'; up.title = `vote the transition up (${TRANS_KEYS.up})`; down.textContent = '👎'; down.title = `vote the transition down (${TRANS_KEYS.down})`;
  const picked = new Set<string>();
  const unpick = () => { picked.clear(); for (const b of tags.querySelectorAll('button')) b.setAttribute('aria-pressed', 'false'); };
  for (const t of TRANS_TAGS) {
    const b = document.createElement('button'); b.textContent = t; b.setAttribute('aria-pressed', 'false');
    b.onclick = () => { picked.has(t) ? picked.delete(t) : picked.add(t); b.setAttribute('aria-pressed', String(picked.has(t))); };
    tags.append(b);
  }
  el.append(label, up, down, note, tags);
  let shown: RanTrans | null = null, scores: Record<string, number> = {}, online = false;
  const draw = () => {
    el.classList.toggle('hide', !shown);
    if (!shown) return;
    const s = scores[shown.type] ?? 0;
    label.textContent = `transition: ${transName(shown.type)}${online ? `  ${s > 0 ? '+' : ''}${s}${s > RETIRE_AT ? '' : ' · retired'}` : ''}`;
    label.title = online ? `${shown.from} → ${shown.to}, ${shown.beats} beats` : 'voting needs the server (npm run server)';
    up.disabled = down.disabled = !online;
  };
  const vote = (v: 1 | -1) => { if (shown && online) post(shown, v, [...picked]); };
  up.onclick = () => vote(1); down.onclick = () => vote(-1);
  return {
    el, vote,
    ran(t) {
      if (!t || (shown && t.at === shown.at && t.type === shown.type && t.from === shown.from && t.to === shown.to)) return;
      if (t.type !== shown?.type) unpick(); // tags picked for another effect don't carry over
      shown = t; note.textContent = ''; draw();
    },
    show(s, o) { scores = s; online = o; draw(); },
    saved(text) { note.textContent = text; unpick(); },
    note(text) { note.textContent = text; },
  };
}
