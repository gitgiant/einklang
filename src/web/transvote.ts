// The transition row of both pages: 👍/👎 for the transition in progress, or else the last one that ran
// (hidden until one has), and prev / next for the transition the next switch uses.
import type { RanTrans } from '../core/protocol.ts';
import { transName } from '../core/transitions.ts';
import { RETIRE_AT } from '../core/votes.ts';

/** Keys for the transition vote (`+` / `-` vote on the scene, and are shift + `=` / `-`). */
export const TRANS_KEYS = { up: '.', down: ',' } as const;

export interface TransRow {
  el: HTMLElement;
  /** A transition is running or has run; null (a cut, nothing yet) keeps the last one. */
  ran(t: RanTrans | null): void;
  /** Redraw with the current scores; `online` false disables voting. */
  show(scores: Record<string, number>, online: boolean): void;
  /** Show the name of the transition the next switch uses. */
  next(name: string): void;
  /** Vote on the transition shown. Nothing before one has run, or offline. */
  vote(v: 1 | -1): void;
  /** The confirmation after a vote. */
  saved(text: string): void;
  note(text: string): void;
}

/** A ‹ or › button. */
export function stepButton(by: -1 | 1, title: string, run: (by: -1 | 1) => void): HTMLButtonElement {
  const b = document.createElement('button'); b.className = by < 0 ? 'prev' : 'next';
  b.textContent = by < 0 ? '‹' : '›'; b.title = title; b.setAttribute('aria-label', title);
  b.onclick = () => run(by);
  return b;
}

export function transRow(post: (t: RanTrans, vote: 1 | -1) => void, step: (by: -1 | 1) => void): TransRow {
  const el = document.createElement('div'); el.className = 'trow';
  const voted = document.createElement('div'); voted.className = 'tvoted hide';
  const label = document.createElement('span'), up = document.createElement('button'), down = document.createElement('button');
  const note = document.createElement('span'); note.className = 'tnote';
  up.textContent = '👍'; up.title = `vote the transition up (${TRANS_KEYS.up})`; down.textContent = '👎'; down.title = `vote the transition down (${TRANS_KEYS.down})`;
  voted.append(label, up, down, note);
  const pickRow = document.createElement('div'); pickRow.className = 'tpick';
  const name = document.createElement('span');
  name.title = 'the transition the next switch uses';
  pickRow.append(stepButton(-1, 'previous transition for the next switch', step), name, stepButton(1, 'next transition for the next switch', step));
  el.append(voted, pickRow);
  let shown: RanTrans | null = null, scores: Record<string, number> = {}, online = false;
  const draw = () => {
    voted.classList.toggle('hide', !shown);
    if (!shown) return;
    const s = scores[shown.type] ?? 0;
    label.textContent = `transition: ${transName(shown.type)}${online ? `  ${s > 0 ? '+' : ''}${s}${s > RETIRE_AT ? '' : ' · retired'}` : ''}`;
    label.title = online ? `${shown.from} → ${shown.to}, ${shown.beats} beats` : 'voting needs the server (npm run server)';
    up.disabled = down.disabled = !online;
  };
  const vote = (v: 1 | -1) => { if (shown && online) post(shown, v); };
  up.onclick = () => vote(1); down.onclick = () => vote(-1);
  return {
    el, vote,
    ran(t) {
      if (!t || (shown && t.at === shown.at && t.type === shown.type && t.from === shown.from && t.to === shown.to)) return;
      shown = t; note.textContent = ''; draw();
    },
    show(s, o) { scores = s; online = o; draw(); },
    next(n) { name.textContent = `next: ${n}`; },
    saved(text) { note.textContent = text; },
    note(text) { note.textContent = text; },
  };
}
