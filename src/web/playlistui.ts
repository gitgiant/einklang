// The "file" input on both pages: one chooser (audio, video, images, .lrc; several at once, a
// folder, or dropped on the page), the playlist (playlist.ts) and its controls. Each page plays a
// slot's track through its own Deck (the gallery locally, the app through the room); the pictures
// of the slot (its images, a video's picture) show here as this host's media, never uploaded. A
// track's video is held on the deck's clock.
import { MEDIA, lockVideo, openImage, openVideo, type MediaItem } from './media.ts';
import { ACCEPT, Player, SilentError, kindOf, pathOf, title, type Prepared } from './player.ts';
import { IMAGE_BARS, Playlist, imageSeconds, quickHash, slotKey, type Entry, type Fingerprint, type Repeat, type Slot } from './playlist.ts';

export interface Deck {
  /**
   * Play track `e` as the music. `prepare` decodes + analyzes it (rejects with SilentError for a
   * video without sound); `progress` shows status text.
   */
  play(e: Entry<File>, prepare: (progress: (p: number) => void) => Promise<Prepared>, lyrics: () => Promise<string | null>): Promise<void>;
  /** No track: an image shows alone (`off` false) or the playlist was turned off (true). */
  idle(off: boolean): void;
  /** The track playing: position and length in seconds; null when none. */
  status(): { pos: number; dur: number; playing: boolean } | null;
  toggle(): void;
  seek(s: number): void;
  /** Where the track's video should be (lockVideo's target). */
  clock(): { at: number; playing: boolean } | null;
  /** The play order or the current slot changed (the app tells the room). */
  listed?(names: string[], index: number): void;
}

export interface FilesOpts {
  /** localStorage key for the saved playlist. */
  key: string;
  deck: Deck;
  note(text: string): void;
  /** Ticks per beat now (for "N bars" of an image shown alone). */
  tpb(): number;
  /** The page's own chooser inputs (the app's #file / #folder), else made here. */
  fileInput?: HTMLInputElement;
  folderInput?: HTMLInputElement;
  /** The playlist was turned on or off (the input menu shows it). */
  changed(on: boolean): void;
}

const lsGet = (k: string) => { try { return localStorage.getItem(k); } catch { return null; } };
const lsSet = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* private mode, full */ } };
const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = ''): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag); if (cls) e.className = cls; if (text) e.textContent = text;
  return e;
};
const button = (text: string, title: string, run: () => void, cls = '') => {
  const b = el('button', cls, text); b.type = 'button'; b.title = title; b.onclick = run;
  return b;
};
const fmt = (s: number) => (Number.isFinite(s) ? `${Math.floor(Math.max(0, s) / 60)}:${String(Math.floor(Math.max(0, s) % 60)).padStart(2, '0')}` : '–:––');
/** iOS (iPadOS reports as a Mac): no folder picking, no dragging files in. */
const ios = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
const ICON: Record<string, string> = { audio: '♪', video: '▶', image: '▢' };
const REPEAT_TEXT: Record<Repeat, string> = { all: 'repeat all', one: 'repeat one', off: 'repeat off' };

export class FilePlaylist {
  readonly pl: Playlist<File>;
  readonly el = el('div', 'playlist');
  /** Playing (the file option is chosen). */
  on = false;
  private player = new Player();
  private hashes = new Map<File, Promise<string>>();
  /** Pictures of the current slot, open, by entry id. */
  private shown = new Map<number, MediaItem>();
  private unlock: (() => void) | null = null;
  /** Bumps on every slot change: late results of an older one are dropped. */
  private gen = 0;
  /** An image shown alone: when it started, how long it shows, and the timer. */
  private still: { t0: number; ms: number; left: number | null; timer: number } | null = null;
  private fileIn: HTMLInputElement;
  private folderIn: HTMLInputElement;
  private list = el('div', 'items');
  private now = el('div', 'now');
  private bar = el('input', 'seek');
  private time = el('span', 'dim time');
  private playB: HTMLButtonElement;
  private shuffleB: HTMLButtonElement;
  private repeatB: HTMLButtonElement;
  private bars = el('select');
  private gone = el('p', 'dim');
  private seeking = false;
  /** Failed slots in a row (a list of undecodable files must not spin). */
  private fails = 0;

  private o: FilesOpts;

  constructor(o: FilesOpts) {
    this.o = o;
    let saved: (ReturnType<Playlist<File>['save']> & { on?: boolean }) | null = null;
    try { saved = JSON.parse(lsGet(o.key) ?? 'null'); } catch { /* corrupt: start empty */ }
    this.pl = Playlist.restore<File>(saved);
    this.on = !!saved?.on && this.pl.items.length > 0;
    this.pl.onChange = () => {
      this.save(); this.draw();
      if (this.on) { const l = this.listing(); this.o.deck.listed?.(l.names, l.index); }
    };

    this.fileIn = o.fileInput ?? el('input');
    this.fileIn.type = 'file'; this.fileIn.multiple = true; this.fileIn.hidden = true; this.fileIn.accept = ACCEPT;
    this.folderIn = o.folderInput ?? el('input');
    this.folderIn.type = 'file'; this.folderIn.multiple = true; this.folderIn.hidden = true; this.folderIn.setAttribute('webkitdirectory', '');
    this.fileIn.onchange = () => { const l = [...(this.fileIn.files ?? [])]; this.fileIn.value = ''; this.addFiles(l); };
    this.folderIn.onchange = () => { const l = [...(this.folderIn.files ?? [])]; this.folderIn.value = ''; this.addFiles(l); };

    const add = button('+ add files', 'audio, video and images (several at once); .lrc lyrics pair with the track of the same name. Files stay on this device; the app uploads only a track\'s sound', () => this.pick());
    const folder = button('+ folder', 'every playable file in a folder, in path order', () => this.folderIn.click());
    folder.hidden = ios();
    const clear = button('clear', 'empty the playlist', () => { this.stop(); this.pl.clear(); this.o.changed(false); });
    this.playB = button('▶', 'play / pause', () => this.toggle());
    this.shuffleB = button('⇄ shuffle', 'shuffle the order', () => this.pl.setShuffle(!this.pl.shuffle));
    this.repeatB = button('', 'repeat: all / one / off', () => this.pl.setRepeat((['all', 'one', 'off'] as const)[(['all', 'one', 'off'].indexOf(this.pl.repeat) + 1) % 3]));
    for (const b of IMAGE_BARS) this.bars.add(new Option(`${b} bar${b > 1 ? 's' : ''}`, String(b)));
    this.bars.onchange = () => { this.pl.setImageBars(+this.bars.value); this.bars.blur(); };
    const barsL = el('label', 'field', 'an image alone shows for');
    barsL.title = 'images listed before a track show while it plays (a video shows its own picture); images after the last track, or a list of images only, show one at a time for this long';
    barsL.append(this.bars);
    this.bar.type = 'range'; this.bar.min = '0'; this.bar.max = '1000'; this.bar.value = '0'; this.bar.setAttribute('aria-label', 'position');
    this.bar.oninput = () => { this.seeking = true; };
    this.bar.onchange = () => { this.seeking = false; const s = this.o.deck.status(); if (s && s.dur > 0) this.o.deck.seek((+this.bar.value / 1000) * s.dur); this.bar.blur(); };
    const transport = el('div', 'transport');
    transport.append(button('⏮', 'previous (restarts the track past its first 3 s)', () => this.back()), this.playB, button('⏭', 'next', () => this.step(1)), this.shuffleB, this.repeatB);
    const seekRow = el('div', 'seekrow'); seekRow.append(this.bar, this.time);
    const adds = el('div', 'options'); adds.append(add, folder, clear);
    this.el.append(adds, this.now, seekRow, transport, barsL, this.gone, this.list, this.fileIn, this.folderIn);
    this.dropZone();
    setInterval(() => { if (this.el.isConnected) this.tickUi(); }, 250);
    this.draw();
  }

  private save(): void { lsSet(this.o.key, JSON.stringify({ ...this.pl.save(), on: this.on })); }

  /** Open the file chooser (from a tap). */
  pick(): void { this.fileIn.click(); }

  /** Files picked or dropped: added in path order, the playlist turns on (a new list starts playing). */
  addFiles(list: File[]): void {
    this.player.addLyrics(list);
    const files = list.flatMap((f) => { const kind = kindOf(f); return kind ? [{ name: f.name, path: pathOf(f), kind, size: f.size, file: f }] : []; });
    if (!files.length) { if (!list.some((f) => /\.lrc$/i.test(f.name))) this.o.note('nothing playable there (audio, video or images)'); return; }
    const was = this.pl.current(), wasPlayable = !!was && this.pl.playable(was) && this.on;
    this.pl.add(files);
    for (const f of files) this.hash(f.file);
    // already playing something: the new files just join the list
    if (wasPlayable) return;
    this.start();
  }

  /** The file's fingerprint (for the room: other hosts with the same file sync their video to it). */
  hash(f: File): Promise<string> {
    let h = this.hashes.get(f);
    if (!h) { h = quickHash(f); this.hashes.set(f, h); }
    return h;
  }
  async fingerprint(e: Entry<File>): Promise<Fingerprint | null> { return e.file ? { name: e.name, size: e.size, hash: await this.hash(e.file) } : null; }

  /** An entry of this list that is that file (any host's room track), or null. */
  async find(fp: Fingerprint): Promise<Entry<File> | null> {
    for (const e of this.pl.items) if (e.file && e.size === fp.size && e.name === fp.name && (await this.hash(e.file)) === fp.hash) return e;
    return null;
  }

  /** Turn on and play the current slot (or the first). */
  start(): void {
    const s = this.pl.start();
    if (!s) { this.o.note(this.pl.items.length ? 're-add the files to play them (they can\'t be kept over a reload)' : ''); if (!this.pl.items.length) this.pick(); return; }
    this.setOn(true);
    this.play(s);
  }

  /** Turn off: the pictures go, the deck stops its track. */
  stop(): void {
    if (!this.on) return;
    this.setOn(false);
    this.gen++;
    this.clearStill(); this.unlock?.(); this.unlock = null;
    this.shown.clear(); MEDIA.set([]);
    this.o.deck.idle(true);
    this.draw();
  }

  private setOn(on: boolean): void {
    if (this.on === on) return;
    this.on = on; this.save(); this.o.changed(on);
  }

  /** The deck's track ended by itself: on to the next (repeat applies). False at the end of the list. */
  ended(): boolean {
    if (!this.on) return false;
    const s = this.pl.next(true);
    if (s) { this.play(s); return true; }
    this.o.note('end of the playlist'); this.draw();
    return false;
  }

  step(by: 1 | -1): void {
    const s = by > 0 ? this.pl.next() : this.pl.prev();
    if (s) { this.setOn(true); this.play(s); }
  }

  /** ⏮: restart a track that has played for more than 3 s, else the previous slot. */
  back(): void {
    const st = this.o.deck.status();
    if (this.on && st && this.pl.current()?.track !== null && st.pos > 3) this.o.deck.seek(0);
    else this.step(-1);
  }

  /** Play the slot at `i` in play order (the room's track request). */
  playAt(i: number): void {
    const order = this.pl.playOrder(), s = order[((i % order.length) + order.length) % order.length];
    const got = s && this.pl.jump(slotKey(s));
    if (got) { this.setOn(true); this.play(got); }
  }

  toggle(): void {
    if (!this.on) { this.start(); return; }
    const s = this.pl.current();
    if (s && s.track === null && this.still) { this.pauseStill(); this.draw(); return; }
    this.o.deck.toggle();
  }

  /** Names in play order and the current slot's place (what the room's track bar lists). */
  listing(): { names: string[]; index: number } {
    const order = this.pl.playOrder();
    return {
      names: order.map((s) => title(this.pl.get(slotKey(s))!.name)),
      index: Math.max(0, order.findIndex((s) => slotKey(s) === this.pl.cur)),
    };
  }

  // ---------------------------------------------------------------- playing a slot

  private async play(s: Slot): Promise<void> {
    const mine = ++this.gen;
    this.clearStill(); this.unlock?.(); this.unlock = null;
    const l = this.listing();
    this.o.deck.listed?.(l.names, l.index);
    this.draw();
    const track = s.track === null ? null : this.pl.get(s.track)!;
    // pictures first (a video's element is ready to lock), the track meanwhile
    const pics = this.pictures(s, mine);
    if (!track) {
      await pics;
      if (mine !== this.gen) return;
      if (this.pl.hasTracks) this.o.deck.idle(false);
      const e = this.pl.get(s.pics[0]);
      this.o.note(e ? `${title(e.name)} (${this.pl.imageBars} bars)` : '');
      this.startStill(imageSeconds(this.pl.imageBars, this.o.tpb()) * 1000);
      this.fails = 0;
      return;
    }
    const file = track.file!, order = this.pl.playOrder(), at = order.findIndex((x) => slotKey(x) === slotKey(s));
    const nextS = order[(at + 1) % order.length], next = nextS?.track != null ? this.pl.get(nextS.track)?.file ?? undefined : undefined;
    try {
      await this.o.deck.play(track,
        (progress) => this.player.prepare(file, progress, next),
        () => this.player.lyrics(file));
      if (mine !== this.gen) return;
      this.fails = 0;
      await pics;
      if (mine !== this.gen) return;
      if (track.kind === 'video') {
        const it = this.shown.get(track.id);
        if (it) this.unlock = lockVideo(it, () => this.o.deck.clock());
      }
      if (next) this.player.prepare(next).catch(() => {}); // ready before this one ends
    } catch (e) {
      if (mine !== this.gen) return;
      if (e instanceof SilentError) {
        // a video without sound: from now on a picture (it groups with the next track or shows alone)
        this.o.note((e as Error).message + ': shown as a picture');
        this.pl.markSilent(track.id);
        const cur = this.pl.current();
        if (cur) this.play(cur);
        return;
      }
      this.o.note((e as Error).message);
      if (++this.fails < this.pl.slots().length) { const n = this.pl.next(); if (n) this.play(n); }
      else this.fails = 0;
    }
  }

  /** Show slot `s`'s pictures (keeps the ones already open). */
  private async pictures(s: Slot, mine: number): Promise<void> {
    const ids = this.pl.pictures(s).filter((id) => this.pl.get(id)?.file);
    if (ids.length === this.shown.size && ids.every((id) => this.shown.has(id))) return;
    const open = (id: number): Promise<MediaItem> => {
      const e = this.pl.get(id)!;
      const have = this.shown.get(id);
      if (have) return Promise.resolve(have);
      return e.kind === 'image' ? openImage(e.file!) : openVideo(e.file!, () => this.o.note('tap to start the video'));
    };
    const res = await Promise.allSettled(ids.map(open));
    const got = res.flatMap((r, i) => (r.status === 'fulfilled' ? [[ids[i], r.value] as const] : []));
    if (mine !== this.gen) { for (const [id, it] of got) if (!this.shown.has(id)) it.stop(); return; }
    const errs = res.flatMap((r) => (r.status === 'rejected' ? [(r.reason as Error).message] : []));
    if (errs.length) this.o.note(errs.join('; '));
    this.shown = new Map(got);
    MEDIA.set(got.map(([, it]) => it)); // stops the ones no longer shown
  }

  private startStill(ms: number): void {
    this.clearStill();
    this.still = { t0: performance.now(), ms, left: null, timer: window.setTimeout(() => { this.still = null; this.ended(); }, ms) };
  }
  private pauseStill(): void {
    const st = this.still;
    if (!st) return;
    if (st.left === null) { clearTimeout(st.timer); st.left = st.ms - (performance.now() - st.t0); }
    else { const left = st.left; st.t0 = performance.now() - (st.ms - left); st.left = null; st.timer = window.setTimeout(() => { this.still = null; this.ended(); }, left); }
  }
  private clearStill(): void { if (this.still) clearTimeout(this.still.timer); this.still = null; }

  // ---------------------------------------------------------------- UI

  /** Dropping files anywhere on the page adds them (desktop). */
  private dropZone(): void {
    if (ios()) return;
    const has = (e: DragEvent) => [...(e.dataTransfer?.types ?? [])].includes('Files');
    let depth = 0;
    addEventListener('dragenter', (e) => { if (has(e)) { depth++; document.body.classList.add('dropping'); } });
    addEventListener('dragleave', (e) => { if (has(e) && --depth <= 0) { depth = 0; document.body.classList.remove('dropping'); } });
    addEventListener('dragover', (e) => { if (has(e)) { e.preventDefault(); e.dataTransfer!.dropEffect = 'copy'; } });
    addEventListener('drop', (e) => {
      if (!has(e)) return;
      e.preventDefault(); depth = 0; document.body.classList.remove('dropping');
      this.addFiles([...(e.dataTransfer?.files ?? [])]);
    });
  }

  /** Position, play button, now-playing (4 times a second while shown). */
  private tickUi(): void {
    const s = this.pl.current(), st = s?.track != null ? this.o.deck.status() : null, still = this.still;
    let pos = 0, dur = 0, playing = false;
    if (this.on && st) ({ pos, dur, playing } = st);
    else if (this.on && still) { dur = still.ms / 1000; pos = (still.left === null ? performance.now() - still.t0 : still.ms - still.left) / 1000; playing = still.left === null; }
    this.playB.textContent = playing ? '❚❚' : '▶';
    this.bar.disabled = !(this.on && st && dur > 0);
    if (!this.seeking) this.bar.value = String(dur > 0 ? Math.round((Math.min(pos, dur) / dur) * 1000) : 0);
    this.time.textContent = this.on && (st || still) ? `${fmt(pos)} / ${fmt(dur)}` : '';
  }

  draw(): void {
    const pl = this.pl, cur = pl.current(), curIds = new Set(cur ? [cur.track, ...cur.pics] : []);
    this.shuffleB.setAttribute('aria-pressed', String(pl.shuffle));
    this.repeatB.textContent = `↻ ${REPEAT_TEXT[pl.repeat]}`;
    this.repeatB.setAttribute('aria-pressed', String(pl.repeat !== 'off'));
    this.bars.value = String(pl.imageBars);
    const name = cur ? pl.get(slotKey(cur))?.name ?? '' : '';
    this.now.textContent = !pl.items.length ? 'no files yet: add audio, video or images (or drop them here)' : cur && this.on ? `now: ${title(name)}` : cur ? `stopped: ${title(name)}` : 'stopped';
    const miss = pl.missing;
    this.gone.textContent = miss ? `${miss} file${miss > 1 ? 's' : ''} to re-add (files can't be kept over a reload): add them again, the list keeps its order` : '';
    this.gone.hidden = !miss;
    const rows = pl.items.map((e, i) => {
      const row = el('div', 'item');
      if (curIds.has(e.id)) row.setAttribute('aria-current', 'true');
      if (!e.file) row.classList.add('missing');
      row.draggable = !ios();
      row.ondragstart = (ev) => { ev.dataTransfer!.setData('text/x-einklang-item', String(e.id)); ev.dataTransfer!.effectAllowed = 'move'; };
      row.ondragover = (ev) => { if ([...(ev.dataTransfer?.types ?? [])].includes('text/x-einklang-item')) { ev.preventDefault(); row.classList.add('over'); } };
      row.ondragleave = () => row.classList.remove('over');
      row.ondrop = (ev) => {
        const id = +(ev.dataTransfer?.getData('text/x-einklang-item') ?? NaN);
        row.classList.remove('over');
        if (!Number.isFinite(id) || !id) return;
        ev.preventDefault(); ev.stopPropagation();
        pl.move(id, i);
      };
      const go = button('', e.file ? 'play this' : 're-add this file to play it', () => { const s = pl.jump(e.id); if (s) { this.setOn(true); this.play(s); } else if (!e.file) this.pick(); }, 'name');
      go.append(el('span', 'kind', e.silent ? ICON.image : ICON[e.kind]), ` ${title(e.name)}`);
      if (!e.file) go.append(el('span', 'dim', ' · re-add'));
      const up = button('▲', 'move up', () => pl.move(e.id, i - 1)), down = button('▼', 'move down', () => pl.move(e.id, i + 1));
      up.disabled = i === 0; down.disabled = i === pl.items.length - 1;
      const del = button('✕', 'remove', () => {
        const was = pl.remove(e.id);
        if (was && this.on) { const s = pl.current() ?? pl.start(); if (s) this.play(s); else this.stop(); }
        if (!pl.items.length) { this.stop(); this.o.changed(false); }
      });
      row.append(go, up, down, del);
      return row;
    });
    this.list.replaceChildren(...rows);
    this.tickUi();
  }
}

/** The CSS of the input menu and the playlist (both pages), injected once. */
export const PLAYLIST_CSS = `
.inmenu { display: flex; flex-direction: column; gap: 8px; }
.inmenu .opts { display: flex; flex-wrap: wrap; gap: 6px; }
.inmenu .opt { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 10px; }
.inmenu .opt.ext { display: inline-flex; gap: 4px 8px; padding-right: 4px; }
.inmenu .opt > label { display: flex; align-items: center; gap: 6px; min-height: 36px; color: var(--dim, #999); cursor: pointer; }
.inmenu .note:empty { display: none; }
.inmenu .note { color: var(--dim, #999); overflow-wrap: anywhere; }
.inmenu h4 { margin: 6px 0 0; font-size: inherit; font-weight: normal; color: var(--dim, #999); }
.inmenu [hidden] { display: none !important; }
.playlist { display: flex; flex-direction: column; gap: 6px; }
.playlist .options, .playlist .transport { display: flex; flex-wrap: wrap; gap: 6px; }
.playlist .now { overflow-wrap: anywhere; }
.playlist .seekrow { display: flex; align-items: center; gap: 8px; }
.playlist .seek { flex: 1; min-width: 0; accent-color: #7fe3ff; }
.playlist .time { min-width: 7em; text-align: right; font-variant-numeric: tabular-nums; }
.playlist .field { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.playlist .items { display: flex; flex-direction: column; gap: 2px; max-height: 40vh; overflow: auto; overscroll-behavior: contain; }
.playlist .item { display: flex; gap: 4px; align-items: stretch; border-radius: 6px; }
.playlist .item.over { outline: 1px dashed #7fe3ff; }
.playlist .item[aria-current=true] .name { border-color: #7fe3ff; color: #7fe3ff; }
.playlist .item.missing .name { opacity: .55; }
.playlist .item .name { flex: 1; min-width: 0; text-align: left; overflow-wrap: anywhere; }
.playlist .item[draggable=true] .name { cursor: grab; }
.playlist .item .kind { display: inline-block; width: 1.2em; text-align: center; color: var(--dim, #999); }
.playlist .item button:not(.name) { flex: none; min-width: 36px; }
body.dropping::after { content: 'drop to add to the playlist'; position: fixed; inset: 12px; z-index: 50; display: grid; place-items: center; border: 2px dashed #7fe3ff; border-radius: 12px; background: #000a; color: #7fe3ff; font: 18px system-ui, sans-serif; pointer-events: none; }
#resume { position: fixed; left: 50%; bottom: max(84px, env(safe-area-inset-bottom)); transform: translateX(-50%); z-index: 20; display: flex; gap: 4px; align-items: stretch; }
#resume[hidden] { display: none; }
#resume button { font: 15px system-ui, sans-serif; min-height: 44px; padding: 8px 16px; color: #000; background: #7fe3ff; border: 0; border-radius: 22px; cursor: pointer; }
#resume button.x { color: #ddd; background: #000c; padding: 8px 12px; }
`;
