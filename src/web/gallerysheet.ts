// The gallery's picker: a sheet (bottom on a phone, centered on a desktop) with tabs for scenes, playback,
// input, the shown scene's variants and the display. A tap outside it or Esc closes it.
import { TRANS_BEATS } from '../core/protocol.ts';
import { transName, transitions } from '../core/transitions.ts';
import type { EvolveInfo } from '../core/graph/evolve.ts';
import type { GalleryRot } from './defaults.ts';
import type { Settings } from './cycle.ts';
import { facets, filterScenes, type SceneItem, type SceneSort } from './pickerlist.ts';

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
  /** The input picker, kept here. */
  input: HTMLElement;
  /** The server restart control, kept here too (it may be waiting for the server). */
  restart: HTMLElement;
  /** The shown scene's variants: its sections or evolve state. */
  now(): { id: string; name: string; sections: string[]; section: { id: string; from: string | null } | null; evolve: EvolveInfo | null; held: boolean };
  nextStep(): void;
  forceSection(id: string): void;
  release(): void;
  info(): boolean;
  setInfo(on: boolean): void;
  /** The frame-time histogram panel. */
  debug(): boolean;
  setDebug(on: boolean): void;
  grid(): boolean;
  toggleGrid(): void;
  /** A link to the shown scene with these transition settings. */
  link(): string;
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
const signed = (s: number) => `${s > 0 ? '+' : ''}${s}`;
const ROT_NAMES: Record<GalleryRot, string> = { weighted: 'random, weighted by votes', order: 'in order', liked: 'liked only', stay: 'stay on this scene' };

export function pickerSheet(host: SheetHost): Sheet {
  const back = el('div', 'hide'); back.id = 'sheet';
  const box = el('div', 'box'); box.setAttribute('role', 'dialog'); box.setAttribute('aria-label', 'picker'); box.tabIndex = -1;
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
    const s = host.settings(), all = host.scenes();
    const rot = el('div', 'options');
    for (const r of Object.keys(ROT_NAMES) as GalleryRot[]) rot.append(button(ROT_NAMES[r], () => { host.change({ rot: r }); draw(); }, s.rot === r));
    const likedNone = s.rot === 'liked' && !all.some((x) => x.score > 0);
    const num = (title: string, values: (number | undefined)[], value: number | undefined, text: (v: number | undefined) => string, set: (v: number | undefined) => void) => {
      const lab = el('label', 'field', title), sel = el('select');
      for (const v of values) sel.add(new Option(text(v), v === undefined ? '' : String(v)));
      sel.value = value === undefined ? '' : String(value);
      sel.onchange = () => { set(sel.value === '' ? undefined : +sel.value); sel.blur(); };
      lab.append(sel);
      return lab;
    };
    const sorted = (xs: number[]) => [...new Set(xs)].sort((a, b) => a - b);
    const speed = num('speed (beats per transition)', sorted([...TRANS_BEATS.filter((b) => b > 0), s.beats]), s.beats, (b) => (b === 0.5 ? '½' : String(b)), (v) => host.change({ beats: v! }));
    const hold = num('hold (bars a scene shows alone)', [undefined, ...sorted([0, 1, 2, 4, 8, 16, 32, ...(s.hold === undefined ? [] : [s.hold])])], s.hold, (v) => (v === undefined ? 'auto' : String(v)), (v) => host.change({ hold: v }));
    const trans = el('div', 'list');
    const row = (id: string, name: string, score: string) => {
      const b = button('', () => { host.change({ trans: id }); draw(); }, s.trans === id, 'row');
      b.append(el('span', 'name', name), el('span', 'score', score));
      return b;
    };
    trans.append(row('random', 'random', ''), row('all', 'all, in order', ''), ...transitions().map((t) => row(t.id, transName(t.id), host.online() ? signed(host.transScore(t.id)) : '')));
    pane.append(el('h3', '', 'rotation'), rot, ...(likedNone ? [el('p', 'dim', 'no liked scenes yet: picking from all')] : []),
      speed, hold, el('h3', '', 'transition for the next switch'), trans);
  };

  // ---- the shown scene's variants ----
  const drawVariant = (pane: HTMLElement) => {
    const n = host.now();
    pane.append(el('h3', '', n.name));
    if (n.evolve) {
      const key = n.evolve.key, step = n.evolve.step;
      const row = el('div', 'options');
      row.append(button('next step now', () => { host.nextStep(); draw(); }));
      // freezing writes a scene file, which only the lab CLI does: hand over what it takes
      row.append(button('freeze this variant (copy state key)', () => { copy(key, 'state key'); }));
      row.append(button('copy freeze command', () => { copy(`npm run lab -- evolve freeze ${n.id} s${step}`, 'command'); }));
      pane.append(el('p', '', `step s${step}${n.section?.from ? ` (from ${n.section.from})` : ''}${n.held ? ' · held' : ''}`), el('p', 'dim key', key), row);
    } else if (n.sections.length) {
      const row = el('div', 'options');
      for (const id of n.sections) row.append(button(id, () => { host.forceSection(id); draw(); }, n.section?.id === id));
      pane.append(el('p', '', `section ${n.section?.id ?? '?'}${n.section?.from ? ` (from ${n.section.from})` : ''}${n.held ? ' · held' : ''}`), el('p', 'dim', 'force a section:'), row);
    } else pane.append(el('p', 'dim', 'this scene neither evolves nor has sections'));
    if (n.held) { const b = button('back to automatic', () => { host.release(); draw(); }); pane.append(b); }
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
    row.append(button('grid of four (g)', () => { host.toggleGrid(); draw(); }, host.grid()));
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
    row.append(fs, wake, button('copy link to this scene + transition', () => { copy(host.link(), 'link'); }));
    pane.append(row);
    if (!canFull) pane.append(el('p', 'dim', 'this browser has no fullscreen (iPhone)'));
    if (wake.disabled) pane.append(el('p', 'dim', `keeping the screen awake needs ${isSecureContext ? 'a newer browser' : 'https or localhost'}`));
    pane.append(el('p', 'dim', 'double-tap the picture hides the controls; tap its left / right third for the previous / next scene'));
    pane.append(host.restart);
  };

  // ---- shell ----
  const TABS = {
    scenes: (pane: HTMLElement) => { const top = el('div', 'search'); top.append(search, sortSel); pane.append(top, chips, list); drawChips(); drawList(); },
    playback: drawPlayback,
    input: (pane: HTMLElement) => { pane.append(host.input); },
    variant: drawVariant,
    display: drawDisplay,
  };
  let tab: keyof typeof TABS = 'scenes', seen = '';
  const tabButtons = (Object.keys(TABS) as (keyof typeof TABS)[]).map((t) => button(t, () => { tab = t; said.replaceChildren(); body.scrollTop = 0; draw(); }, false));
  const closeB = button('✕', () => close(), undefined, 'close'); closeB.setAttribute('aria-label', 'close');
  tabs.append(...tabButtons, closeB);
  const nowKey = () => { const n = host.now(); return [n.id, n.section?.id, n.section?.from, n.evolve?.step, n.held].join(); };
  function draw() {
    if (back.classList.contains('hide')) return;
    tabButtons.forEach((b) => b.setAttribute('aria-pressed', String(b.textContent === tab)));
    const y = body.scrollTop;
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
    // the input tab holds live elements (a running file picker): never rebuilt from outside
    refresh() { if (tab !== 'input') draw(); },
  };
}
