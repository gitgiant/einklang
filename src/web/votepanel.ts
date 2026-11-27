// The vote panel of both pages, bottom right: 👍/👎 and prev / next for the scene shown, and under it the
// transition row (transvote.ts). How a vote travels is the page's: the gallery posts to /vote, the app
// sends it through the room (so every host toasts it).
import type { RanTrans } from '../core/protocol.ts';
import { stepButton, transRow, type TransRow } from './transvote.ts';

export interface VoteHost {
  /** The scene voted on (the one on screen), or null to hide the panel (the UI is off, the grid). */
  scene(): { id: string; name: string } | null;
  /** The current scores, and whether voting works (the server answers). */
  scores(): { scenes: Record<string, number>; trans: Record<string, number>; online: boolean };
  /** A scene the votes retired (shown with its score). */
  retired(id: string): boolean;
  /** Cast a scene vote; the page confirms it with said(). */
  vote(scene: { id: string; name: string }, v: 1 | -1): void;
  /** Cast a transition vote; the page confirms it with trans.saved(). */
  voteTrans(t: RanTrans, v: 1 | -1): void;
  /** ‹ › of the scene row and of the transition row. */
  stepScene(by: -1 | 1): void;
  stepTrans(by: -1 | 1): void;
  /** The keys of the scene ‹ ›, for their titles. */
  stepKeys: [string, string];
}

export interface VotePanel {
  el: HTMLElement;
  trans: TransRow;
  /** Redraw (the scene, the scores or the online state changed). */
  show(): void;
  /** Vote on the scene shown (keys + / -). Nothing while hidden or offline. */
  vote(v: 1 | -1): void;
  /** Vote on the transition shown (keys . / ,). Nothing while hidden. */
  voteTrans(v: 1 | -1): void;
  /** The confirmation after a scene vote, or why it failed. */
  said(text: string): void;
}

const VOTE_CSS = `
#vote { position: fixed; right: 10px; bottom: 10px; max-width: min(360px, calc(100vw - 36px)); display: flex; flex-direction: column; align-items: flex-end; gap: 4px; padding: 6px 8px; background: #000b; border: 1px solid var(--line); border-radius: 6px; }
#vote .srow, #vote .tvoted, #vote .tpick { display: flex; flex-wrap: wrap; align-items: center; justify-content: flex-end; gap: 4px; }
#vote .trow { display: flex; flex-direction: column; align-items: flex-end; gap: 4px; width: 100%; padding-top: 4px; border-top: 1px solid var(--line); }
#vote button { font-size: 18px; color: var(--fg); background: none; border: 0; cursor: pointer; min-width: 40px; min-height: 40px; padding: 2px 6px; }
#vote button:disabled { opacity: .3; cursor: default; }
#vote :is(button.prev, button.next) { border: 1px solid var(--line); border-radius: 6px; }
#vote .tpick span { min-width: 12em; text-align: center; }
#vote :is(.note, .tnote) { color: var(--dim); }
#vote { transition: opacity .4s; }
body.idle #vote { opacity: 0; pointer-events: none; }
body.ui-off #vote { opacity: 0; visibility: hidden; pointer-events: none; }
`;
let styled = false;

export function votePanel(host: VoteHost): VotePanel {
  if (!styled) { styled = true; const st = document.createElement('style'); st.textContent = VOTE_CSS; document.head.prepend(st); }
  const el = document.createElement('div'); el.id = 'vote';
  const row = document.createElement('div'); row.className = 'srow';
  const label = document.createElement('span'), up = document.createElement('button'), down = document.createElement('button');
  const note = document.createElement('span'); note.className = 'note';
  up.className = 'up'; up.textContent = '👍'; up.title = 'vote the scene up (+)'; down.className = 'down'; down.textContent = '👎'; down.title = 'vote the scene down (-)';
  const prev = stepButton(-1, `previous scene (${host.stepKeys[0]})`, (by) => host.stepScene(by));
  const next = stepButton(1, `next scene (${host.stepKeys[1]})`, (by) => host.stepScene(by));
  prev.id = 'prev'; next.id = 'next';
  const trans = transRow((t, v) => host.voteTrans(t, v), (by) => host.stepTrans(by));
  row.append(label, up, down, prev, next, note);
  el.append(row, trans.el);
  document.body.append(el);
  let shownId = '';
  const show = () => {
    const { scenes, trans: ts, online } = host.scores();
    trans.show(ts, online);
    const sc = host.scene();
    el.classList.toggle('hide', sc === null);
    if (sc === null) return;
    if (sc.id !== shownId) { shownId = sc.id; note.textContent = ''; }
    const s = scenes[sc.id] ?? 0;
    label.textContent = sc.name + (online ? `  ${s > 0 ? '+' : ''}${s}${host.retired(sc.id) ? ' · retired' : ''}` : '');
    label.title = online ? '' : 'voting needs the server (npm run server)';
    up.disabled = down.disabled = !online;
  };
  const vote = (v: 1 | -1) => {
    const sc = host.scene();
    if (sc && host.scores().online) host.vote(sc, v);
  };
  up.onclick = () => vote(1); down.onclick = () => vote(-1);
  return {
    el, trans, show, vote,
    voteTrans: (v) => { if (host.scene()) trans.vote(v); },
    said: (text) => { note.textContent = text; },
  };
}
