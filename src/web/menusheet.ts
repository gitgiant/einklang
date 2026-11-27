// The menu of both pages (the gallery and the app): a sheet (bottom on a phone, centered on a desktop) with
// tabs for scenes, playback, input, the shown scene's variants (gallery), the page's own tabs (the app's
// room) and the display. A tap outside it or Esc closes it. menuButton() is the ☰ button and status line
// top left that opens it.
import { transName, transitions } from '../core/transitions.ts';
import type { EvolveInfo } from '../core/graph/evolve.ts';
import type { GalleryRot } from './defaults.ts';
import type { Settings } from './cycle.ts';
import { facets, filterScenes, type SceneItem, type SceneSort } from './pickerlist.ts';

/** What the playback tab offers: the gallery's cycle runs in the page, the app's rotation is the room's. */
export interface PlaybackChoices {
  /** The rotations offered, in order, and names replacing the default ones. */
  rots: readonly GalleryRot[];
  rotNames?: Partial<Record<GalleryRot, string>>;
  /** Transition lengths in beats (0 = a cut). */
  beats: readonly number[];
  /** The hold choice (bars between switches); undefined = automatic. */
  hold: { title: string; values: readonly (number | undefined)[] };
  /** Offer "all, in order" among the transitions. */
  all: boolean;
  transTitle: string;
  /** When a switch lands (the app's beat / bar / now). */
  quant?: { values: readonly string[]; value(): string; set(v: string): void };
}

/** The shown scene's sections or evolve state, which the menu can hold. */
export interface Variants {
  now(): { id: string; name: string; sections: string[]; section: { id: string; from: string | null } | null; evolve: EvolveInfo | null; held: boolean };
  nextStep(): void;
  forceSection(id: string): void;
  release(): void;
}

export interface SheetHost {
  /** Every scene, with the current vote scores. */
  scenes(): SceneItem[];
  /** Whether those scores come from the server. */
  online(): boolean;
  transScore(id: string): number;
  shown(): string;
  /** Switch to a scene now. */
  go(id: string): void;
  /** The settings chosen (maybe still waiting for the next switch). */
  settings(): Settings;
  change(patch: Partial<Settings>): void;
  playback: PlaybackChoices;
  /** The input menu, kept here. */
  input: HTMLElement;
  /** The server restart control, kept here too (it may be waiting for the server). */
  restart: HTMLElement;
  /** The variant tab; left out where the room keeps the scenes in step (the app). */
  variants?: Variants;
  /** The page's own tabs (the app's room), shown before the display tab. Live elements, never rebuilt. */
  extra?: { name: string; el: HTMLElement }[];
  info(): boolean;
  setInfo(on: boolean): void;
  /** The frame-time histogram panel. */
  debug(): boolean;
  setDebug(on: boolean): void;
  /** The grid of four (the gallery). */
  grid?: { on(): boolean; toggle(): void };
  /** The link the display tab copies, and its button's label. */
  link(): string;
  linkLabel: string;
  /** How taps on the picture work, said under the display options. */
  hint: string;
}

export interface Sheet {
  open(): void;
  close(): void;
  readonly isOpen: boolean;
  /** Redraw what is on screen (scores, settings or the scene changed). */
  refresh(): void;
}

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = ''): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag); if (cls) e.className = cls; if (text) e.textContent = text;
  return e;
};
const button = (text: string, run: () => void, pressed?: boolean, cls = '') => {
  const b = el('button', cls, text); b.type = 'button'; b.onclick = run;
  if (pressed !== undefined) b.setAttribute('aria-pressed', String(pressed));
  return b;
};
/** The sheet's and the ☰ button's look, the same on both pages (a page may place them differently). */
const MENU_CSS = `
#sheet, #vote, #tools { --fg: #d8d8d8; --dim: #8a8a8a; --line: #ffffff1f; }
#tools { position: fixed; left: 10px; top: 10px; max-width: calc(100vw - 20px); display: flex; align-items: center; gap: 8px; }
#tools button { min-height: 40px; padding: 6px 14px; color: var(--fg); background: #000b; border: 1px solid var(--line); border-radius: 6px; cursor: pointer; backdrop-filter: blur(6px); }
#tools > span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--dim); text-shadow: 0 0 4px #000; }
#sheet { position: fixed; inset: 0; z-index: 10; display: flex; align-items: center; justify-content: center; background: #0008; cursor: pointer; }
#sheet .box { cursor: auto; display: flex; flex-direction: column; width: min(620px, 100%); height: min(720px, 86vh); height: min(720px, 86dvh); background: #0d0d0df2; border: 1px solid var(--line); border-radius: 10px; font-size: 13px; outline: none; }
#sheet .tabs { display: flex; gap: 2px; padding: 6px; border-bottom: 1px solid var(--line); }
#sheet .tabs button { flex: 1 1 auto; min-width: 0; padding: 4px 2px; border-color: transparent; font-size: 12px; }
#sheet .tabs .close { flex: 0 0 40px; }
#sheet .body { flex: 1; overflow: auto; overscroll-behavior: contain; padding: 8px 10px max(10px, env(safe-area-inset-bottom)); }
#sheet button { min-height: 40px; padding: 6px 10px; color: var(--fg); background: none; border: 1px solid var(--line); border-radius: 6px; cursor: pointer; }
#sheet button[aria-pressed=true] { color: #000; background: var(--fg); }
#sheet button[aria-pressed=true] .dim { color: #333; }
#sheet button:disabled { opacity: .35; cursor: default; }
/* 16px: iOS zooms into smaller fields */
#sheet :is(input[type=search], input[readonly], select) { font-size: 16px; min-height: 40px; color: var(--fg); background: #000; border: 1px solid var(--line); border-radius: 6px; padding: 4px 8px; user-select: text; -webkit-user-select: text; }
#sheet .search { display: flex; gap: 6px; }
#sheet .search input { flex: 1; min-width: 0; }
#sheet .chips { display: flex; flex-wrap: nowrap; gap: 4px; overflow-x: auto; padding: 8px 0; }
#sheet .chip { flex: none; border-radius: 20px; }
#sheet .chip.vendor { border-style: dashed; }
#sheet .list { display: flex; flex-direction: column; gap: 3px; }
#sheet .row { display: grid; grid-template-columns: 1fr auto; column-gap: 10px; align-items: center; text-align: left; }
#sheet .row .name { overflow-wrap: anywhere; }
#sheet .options { display: flex; flex-wrap: wrap; gap: 6px; }
#sheet .field { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-top: 10px; }
#sheet .restart { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; margin-top: 24px; padding-top: 10px; border-top: 1px solid var(--line); }
#sheet .restart label { display: flex; align-items: center; gap: 6px; min-height: 40px; }
#sheet .restart .out { width: 100%; max-height: 30vh; overflow: auto; margin: 0; color: #f88; font-family: monospace; white-space: pre-wrap; user-select: text; -webkit-user-select: text; }
#sheet h3 { margin: 12px 0 6px; font-size: 13px; }
#sheet h3:first-child { margin-top: 0; }
#sheet .dim { color: var(--dim); }
#sheet .key { overflow-wrap: anywhere; user-select: text; -webkit-user-select: text; }
#sheet .said:empty { display: none; }
#sheet .said { display: flex; flex-direction: column; gap: 4px; padding: 6px 10px; }
#input { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
#input .note { width: 100%; color: var(--dim); }
#input .inmenu { width: 100%; }
#input .playlist .items { max-height: none; }
#input select { font-size: 16px; min-height: 40px; color: var(--fg); background: #000; border: 1px solid var(--line); border-radius: 6px; padding: 4px 8px; }
@media (max-width: 640px) {
  /* a phone: the picker is a bottom sheet */
  #sheet { align-items: flex-end; }
  #sheet .box { border-radius: 12px 12px 0 0; border-width: 1px 0 0; }
}
#tools { transition: opacity .4s; }
body.idle #tools { opacity: 0; pointer-events: none; }
/* hidden by double-tap: stays hidden until the next one */
body.ui-off #tools { opacity: 0; visibility: hidden; pointer-events: none; }
body.idle:not(.sheet-open) { cursor: none; }
`;
let styled = false;
const style = () => { if (!styled) { styled = true; const st = el('style'); st.textContent = MENU_CSS; document.head.prepend(st); } };
const signed = (s: number) => `${s > 0 ? '+' : ''}${s}`;
const ROT_NAMES: Record<GalleryRot, string> = { weighted: 'random, weighted by votes', order: 'in order', liked: 'liked only', stay: 'stay on this scene' };

export function pickerSheet(host: SheetHost): Sheet {
  style();
  const back = el('div', 'hide'); back.id = 'sheet';
  const box = el('div', 'box'); box.setAttribute('role', 'dialog'); box.setAttribute('aria-label', 'menu'); box.tabIndex = -1;
  const tabs = el('nav', 'tabs'), body = el('div', 'body'), said = el('div', 'dim said');
  back.append(box); box.append(tabs, said, body); document.body.append(back);

  /** Put `text` on the clipboard; where there is none (plain http), show it selected to copy by hand. */
  const copy = async (text: string, what: string) => {
    said.replaceChildren();
    try { await navigator.clipboard.writeText(text); said.textContent = `${what} copied`; return; } catch { /* no clipboard */ }
    const f = el('input'); f.readOnly = true; f.value = text; f.setAttribute('aria-label', what);
    said.append(`copy the ${what}:`, f); f.focus(); f.select();
  };

  // ---- scenes ----
  const vendors = new Set<string>(), tags = new Set<string>();
  let sort: SceneSort = 'score';
  const search = el('input'); search.type = 'search'; search.placeholder = 'search scenes'; search.autocomplete = 'off'; search.spellcheck = false;
  search.setAttribute('autocapitalize', 'off');
  const sortSel = el('select'); sortSel.title = 'sort';
  for (const s of ['score', 'newest', 'name'] as const) sortSel.add(new Option(`by ${s}`, s));
  const chips = el('div', 'chips'), list = el('div', 'list');
  const drawList = () => {
    const found = filterScenes(host.scenes(), { query: search.value, vendors, tags, sort }), shown = host.shown(), online = host.online();
    list.replaceChildren(...found.map((s) => {
      const b = button('', () => { host.go(s.id); close(); }, s.id === shown, 'row');
      const name = el('span', 'name', s.name), id = el('span', 'dim', s.id), score = el('span', 'score', online ? signed(s.score) : '—');
      b.append(name, score, id);
      return b;
    }));
    if (!found.length) list.append(el('p', 'dim', 'no scene matches'));
  };
  const drawChips = () => {
    const f = facets(host.scenes());
    const chip = (set: Set<string>, v: string, cls: string) => button(v, () => { set.has(v) ? set.delete(v) : set.add(v); drawChips(); drawList(); }, set.has(v), `chip ${cls}`);
    chips.replaceChildren(...f.vendors.map((v) => chip(vendors, v, 'vendor')), ...f.tags.map((t) => chip(tags, t, 'by-tag')));
  };
  search.oninput = drawList;
  search.onkeydown = (e) => { if (e.key === 'Enter') search.blur(); }; // puts the phone keyboard away
  sortSel.onchange = () => { sort = sortSel.value as SceneSort; drawList(); };

  // ---- playback ----
  const drawPlayback = (pane: HTMLElement) => {
    const s = host.settings(), all = host.scenes(), pb = host.playback;
    const rot = el('div', 'options');
    for (const r of pb.rots) rot.append(button(pb.rotNames?.[r] ?? ROT_NAMES[r], () => { host.change({ rot: r }); draw(); }, s.rot === r));
    const likedNone = s.rot === 'liked' && !all.some((x) => x.score > 0);
    const select = (title: string, values: string[], value: string, text: (v: string) => string, set: (v: string) => void) => {
      const lab = el('label', 'field', title), sel = el('select');
      for (const v of values) sel.add(new Option(text(v), v));
      sel.value = value;
      sel.onchange = () => { set(sel.value); sel.blur(); };
      lab.append(sel);
      return lab;
    };
    const num = (title: string, values: (number | undefined)[], value: number | undefined, text: (v: number | undefined) => string, set: (v: number | undefined) => void) =>
      select(title, values.map((v) => (v === undefined ? '' : String(v))), value === undefined ? '' : String(value), (v) => text(v === '' ? undefined : +v), (v) => set(v === '' ? undefined : +v));
    const sorted = (xs: number[]) => [...new Set(xs)].sort((a, b) => a - b);
    const speed = num('speed (beats per transition)', sorted([...pb.beats, s.beats]), s.beats, (b) => (b === 0 ? 'cut' : b === 0.5 ? '½' : String(b)), (v) => host.change({ beats: v! }));
    const holds = pb.hold.values.filter((v) => v !== undefined);
    const hold = num(pb.hold.title, [...(pb.hold.values.includes(undefined) ? [undefined] : []), ...sorted([...holds, ...(s.hold === undefined ? [] : [s.hold])])], s.hold,
      (v) => (v === undefined ? 'auto' : String(v)), (v) => host.change({ hold: v }));
    const quant = pb.quant ? [select('switch on', [...pb.quant.values], pb.quant.value(), (v) => v, (v) => pb.quant!.set(v))] : [];
    const trans = el('div', 'list');
    const row = (id: string, name: string, score: string) => {
      const b = button('', () => { host.change({ trans: id }); draw(); }, s.trans === id, 'row');
      b.append(el('span', 'name', name), el('span', 'score', score));
      return b;
    };
    trans.append(row('random', 'random', ''), ...(pb.all ? [row('all', 'all, in order', '')] : []), ...transitions().map((t) => row(t.id, transName(t.id), host.online() ? signed(host.transScore(t.id)) : '')));
    pane.append(el('h3', '', 'rotation'), rot, ...(likedNone ? [el('p', 'dim', 'no liked scenes yet: picking from all')] : []),
      speed, hold, ...quant, el('h3', '', pb.transTitle), trans);
  };

  // ---- the shown scene's variants ----
  const drawVariant = (v: Variants) => (pane: HTMLElement) => {
    const n = v.now();
    pane.append(el('h3', '', n.name));
    if (n.evolve) {
      const key = n.evolve.key, step = n.evolve.step;
      const row = el('div', 'options');
      row.append(button('next step now', () => { v.nextStep(); draw(); }));
      // freezing writes a scene file, which only the lab CLI does: hand over what it takes
      row.append(button('freeze this variant (copy state key)', () => { copy(key, 'state key'); }));
      row.append(button('copy freeze command', () => { copy(`npm run lab -- evolve freeze ${n.id} s${step}`, 'command'); }));
      pane.append(el('p', '', `step s${step}${n.section?.from ? ` (from ${n.section.from})` : ''}${n.held ? ' · held' : ''}`), el('p', 'dim key', key), row);
    } else if (n.sections.length) {
      const row = el('div', 'options');
      for (const id of n.sections) row.append(button(id, () => { v.forceSection(id); draw(); }, n.section?.id === id));
      pane.append(el('p', '', `section ${n.section?.id ?? '?'}${n.section?.from ? ` (from ${n.section.from})` : ''}${n.held ? ' · held' : ''}`), el('p', 'dim', 'force a section:'), row);
    } else pane.append(el('p', 'dim', 'this scene neither evolves nor has sections'));
    if (n.held) { const b = button('back to automatic', () => { v.release(); draw(); }); pane.append(b); }
  };

  // ---- display ----
  let lock: WakeLockSentinel | null = null, wanted = false;
  const awake = async () => {
    try {
      lock = await navigator.wakeLock.request('screen');
      lock.addEventListener('release', () => { lock = null; draw(); });
    } catch (e) { wanted = false; said.textContent = `cannot keep the screen awake: ${(e as Error).message}`; }
    draw();
  };
  // the browser drops the lock when the page is hidden
  document.addEventListener('visibilitychange', () => { if (wanted && !lock && document.visibilityState === 'visible') awake(); });
  const root = document.documentElement as HTMLElement & { webkitRequestFullscreen?: () => void };
  const doc = document as Document & { webkitFullscreenElement?: Element; webkitExitFullscreen?: () => void };
  const fullscreen = () => !!(document.fullscreenElement ?? doc.webkitFullscreenElement);
  document.addEventListener('fullscreenchange', () => draw());
  const drawDisplay = (pane: HTMLElement) => {
    const row = el('div', 'options');
    row.append(button('info + frame time (i)', () => { host.setInfo(!host.info()); draw(); }, host.info()));
    // turning it on closes the sheet, which would cover it
    row.append(button('debug: frame times (d)', () => { const on = !host.debug(); host.setDebug(on); if (on) close(); else draw(); }, host.debug()));
    const grid = host.grid;
    if (grid) row.append(button('grid of four (g)', () => { grid.toggle(); draw(); }, grid.on()));
    const canFull = !!(root.requestFullscreen ?? root.webkitRequestFullscreen);
    const fs = button('fullscreen', () => {
      if (fullscreen()) (document.exitFullscreen ?? doc.webkitExitFullscreen)?.call(document);
      else (root.requestFullscreen ?? root.webkitRequestFullscreen)?.call(root);
    }, fullscreen());
    fs.disabled = !canFull;
    const wake = button('keep screen awake', () => {
      wanted = !wanted;
      if (wanted) awake(); else { lock?.release(); lock = null; draw(); }
    }, wanted);
    wake.disabled = !('wakeLock' in navigator);
    row.append(fs, wake, button(host.linkLabel, () => { copy(host.link(), 'link'); }));
    pane.append(row);
    if (!canFull) pane.append(el('p', 'dim', 'this browser has no fullscreen (iPhone)'));
    if (wake.disabled) pane.append(el('p', 'dim', `keeping the screen awake needs ${isSecureContext ? 'a newer browser' : 'https or localhost'}`));
    pane.append(el('p', 'dim', host.hint));
    pane.append(host.restart);
  };

  // ---- shell ----
  const TABS: Record<string, (pane: HTMLElement) => void> = {
    scenes: (pane: HTMLElement) => { const top = el('div', 'search'); top.append(search, sortSel); pane.append(top, chips, list); drawChips(); drawList(); },
    playback: drawPlayback,
    input: (pane: HTMLElement) => { pane.append(host.input); },
  };
  if (host.variants) TABS.variant = drawVariant(host.variants);
  for (const x of host.extra ?? []) TABS[x.name] = (pane) => { pane.append(x.el); };
  TABS.display = drawDisplay;
  // live elements stay in the document while out of sight (a file picker, a waiting restart; scripts find them)
  const live = [host.input, host.restart, ...(host.extra ?? []).map((x) => x.el)];
  const park = el('div', 'hide'); back.append(park); park.append(...live);
  const liveTabs = new Set(['input', ...(host.extra ?? []).map((x) => x.name)]);
  let tab = 'scenes', seen = '';
  const tabButtons = Object.keys(TABS).map((t) => button(t, () => { tab = t; said.replaceChildren(); body.scrollTop = 0; draw(); }, false));
  const closeB = button('✕', () => close(), undefined, 'close'); closeB.setAttribute('aria-label', 'close');
  tabs.append(...tabButtons, closeB);
  const nowKey = () => { const n = host.variants?.now(); return n ? [n.id, n.section?.id, n.section?.from, n.evolve?.step, n.held].join() : ''; };
  function draw() {
    if (back.classList.contains('hide')) return;
    tabButtons.forEach((b) => b.setAttribute('aria-pressed', String(b.textContent === tab)));
    const y = body.scrollTop;
    park.append(...live);
    body.replaceChildren();
    seen = nowKey();
    TABS[tab](body);
    body.scrollTop = y;
  }
  // the variant tab follows the scene while it is open
  let timer = 0;
  const close = () => {
    if (back.classList.contains('hide')) return;
    back.classList.add('hide'); document.body.classList.remove('sheet-open');
    clearInterval(timer);
    (document.activeElement as HTMLElement | null)?.blur(); // keys go back to the page
  };
  back.onclick = (e) => { if (e.target === back) close(); };
  addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
  return {
    open() {
      back.classList.remove('hide'); document.body.classList.add('sheet-open'); said.replaceChildren();
      draw(); box.focus();
      clearInterval(timer);
      timer = window.setInterval(() => { if (tab === 'variant' && seen !== nowKey()) draw(); }, 250);
    },
    close,
    get isOpen() { return !back.classList.contains('hide'); },
    // the input and page tabs hold live elements (a running file picker): never rebuilt from outside
    refresh() { if (!liveTabs.has(tab)) draw(); },
  };
}

/** The ☰ button (key `o` on both pages) and the status line next to it, top left. */
export function menuButton(open: () => void, statusId = 'status'): { el: HTMLElement; status: HTMLElement } {
  style();
  const tools = el('div'); tools.id = 'tools';
  const menu = button('☰', open); menu.id = 'menu'; menu.title = 'menu: scenes, transitions, input, display (o)'; menu.setAttribute('aria-label', 'menu');
  const status = el('span'); status.id = statusId;
  tools.append(menu, status);
  document.body.append(tools);
  return { el: tools, status };
}
