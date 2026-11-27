// The "file" input's playlist (pure, unit-tested; the DOM is playlistui.ts). Picked audio, video
// and image files in the user's order, grouped into slots: a slot is one audio / video track plus
// the images listed right before it, which show as media while that track plays (its video too).
// Images after the last track, and every image of an image-only list, are slots of their own that
// show for `imageBars` bars each while the page's current audio keeps playing. A video whose sound
// can't be decoded counts as an image (markSilent). Files can't survive a reload: save() keeps the
// order and settings, restore() brings the entries back without files until they are added again
// (matched by path + size).

export type ItemKind = 'audio' | 'video' | 'image';
export type Repeat = 'all' | 'one' | 'off';

export interface Entry<F> {
  id: number;
  name: string;
  /** webkitRelativePath or the name: what a re-added file is matched on, with the size. */
  path: string;
  kind: ItemKind;
  size: number;
  /** null: restored from a save, waiting for the file to be added again. */
  file: F | null;
  /** A video without decodable sound: shown like an image. */
  silent?: boolean;
}

export interface Slot {
  /** The track's entry id, null for an image shown alone. */
  track: number | null;
  /** Images shown with it (ids, list order). An image slot has exactly one. */
  pics: number[];
}
/** The entry a slot is known by (stable while the list is edited around it). */
export const slotKey = (s: Slot): number => s.track ?? s.pics[0];

export interface Saved {
  v: 1;
  items: { name: string; path: string; kind: ItemKind; size: number; silent?: boolean }[];
  /** List index of the current slot's key entry, -1 for none. */
  at: number;
  shuffle: boolean;
  repeat: Repeat;
  imageBars: number;
}

export const IMAGE_BARS = [1, 2, 4, 8, 16, 32] as const;
export const REPEATS: Repeat[] = ['all', 'one', 'off'];

/** Seconds an image shown alone stays, at `tpb` ticks per beat (4 beats a bar). */
export const imageSeconds = (bars: number, tpb: number, fps = 60): number => (bars * 4 * tpb) / fps;

/** Natural path order (folders keep their track numbering). */
export const byPath = (a: { path: string }, b: { path: string }) => a.path.localeCompare(b.path, undefined, { numeric: true, sensitivity: 'base' });

export class Playlist<F> {
  items: Entry<F>[] = [];
  shuffle = false;
  repeat: Repeat = 'all';
  imageBars = 8;
  /** Key of the current slot (see slotKey), null before anything played. */
  cur: number | null = null;
  /** Slot keys in shuffled play order (only while shuffle is on). */
  private order: number[] = [];
  private nextId = 1;
  /** Random numbers in [0, 1) for shuffling (tests replace it). */
  rand: () => number = Math.random;
  /** Any change (the UI redraws, the page saves). */
  onChange: () => void = () => {};

  get(id: number): Entry<F> | undefined { return this.items.find((e) => e.id === id); }

  /** Slots in list order. */
  slots(): Slot[] {
    const out: Slot[] = [];
    let pics: number[] = [];
    for (const e of this.items) {
      if (e.kind === 'image' || e.silent) pics.push(e.id);
      else { out.push({ track: e.id, pics }); pics = []; }
    }
    for (const p of pics) out.push({ track: null, pics: [p] });
    return out;
  }

  /** Slots in play order (shuffled or list order). */
  playOrder(): Slot[] {
    const slots = this.slots();
    if (!this.shuffle) return slots;
    this.syncOrder(slots);
    const byKey = new Map(slots.map((s) => [slotKey(s), s]));
    return this.order.map((k) => byKey.get(k)!);
  }

  /** Keep the shuffled order in step with the slots: drop gone keys, put new ones at random places after the current. */
  private syncOrder(slots: Slot[]): void {
    const keys = new Set(slots.map(slotKey));
    this.order = this.order.filter((k) => keys.has(k));
    const have = new Set(this.order);
    for (const s of slots) {
      const k = slotKey(s);
      if (have.has(k)) continue;
      const from = this.cur === null ? 0 : this.order.indexOf(this.cur) + 1;
      this.order.splice(from + Math.floor(this.rand() * (this.order.length - from + 1)), 0, k);
      have.add(k);
    }
  }

  private reshuffle(first: number | null): void {
    const keys = this.slots().map(slotKey).filter((k) => k !== first);
    for (let i = keys.length - 1; i > 0; i--) { const j = Math.floor(this.rand() * (i + 1)); [keys[i], keys[j]] = [keys[j], keys[i]]; }
    this.order = first === null ? keys : [first, ...keys];
  }

  /** The current slot, or null. */
  current(): Slot | null {
    if (this.cur === null) return null;
    return this.slots().find((s) => slotKey(s) === this.cur) ?? null;
  }

  /** Its files are all here (a restored entry without a file isn't). */
  playable(s: Slot): boolean {
    return s.track !== null ? !!this.get(s.track)?.file : s.pics.every((p) => !!this.get(p)?.file);
  }

  /** Only images (no track at all): the page's own audio input keeps running. */
  get picturesOnly(): boolean { return this.items.length > 0 && this.items.every((e) => e.kind === 'image' || e.silent); }
  get hasTracks(): boolean { return this.items.some((e) => e.kind !== 'image' && !e.silent); }
  get missing(): number { return this.items.filter((e) => !e.file).length; }

  /**
   * Move to the next playable slot. `auto`: the current one ended by itself, so repeat applies
   * ("one" stays, "off" stops at the end: null, and the current stays put). A manual step wraps.
   */
  next(auto = false): Slot | null {
    const order = this.playOrder();
    if (!order.length) return null;
    const cur = this.current();
    if (auto && this.repeat === 'one' && cur && this.playable(cur)) return cur;
    let i = cur ? order.findIndex((s) => slotKey(s) === this.cur) : -1;
    for (let n = 0; n < order.length; n++) {
      i++;
      if (i >= order.length) {
        if (auto && this.repeat === 'off') return null;
        if (this.shuffle) { this.reshuffle(null); return this.firstPlayable(cur); }
        i = 0;
      }
      if (this.playable(order[i])) return this.set(order[i]);
    }
    return null;
  }

  /** After a reshuffle: the first playable slot, not the one that just played if there is another. */
  private firstPlayable(last: Slot | null): Slot | null {
    const order = this.playOrder(), ok = order.filter((s) => this.playable(s));
    if (!ok.length) return null;
    if (last && ok.length > 1 && slotKey(ok[0]) === slotKey(last)) {
      const k = this.order.indexOf(slotKey(ok[1])); this.order.splice(k, 1); this.order.unshift(slotKey(ok[1]));
      return this.set(ok[1]);
    }
    return this.set(ok[0]);
  }

  /** The previous playable slot (wraps). */
  prev(): Slot | null {
    const order = this.playOrder();
    if (!order.length) return null;
    let i = Math.max(0, order.findIndex((s) => slotKey(s) === this.cur));
    for (let n = 0; n < order.length; n++) {
      i = (i - 1 + order.length) % order.length;
      if (this.playable(order[i])) return this.set(order[i]);
    }
    return null;
  }

  /** Make the slot holding entry `id` current (any entry of it: a track or one of its images). */
  jump(id: number): Slot | null {
    const s = this.slots().find((x) => x.track === id || x.pics.includes(id));
    return s && this.playable(s) ? this.set(s) : null;
  }

  /** The first playable slot in play order (to start from), or the current when it is playable. */
  start(): Slot | null {
    const cur = this.current();
    if (cur && this.playable(cur)) return cur;
    const s = this.playOrder().find((x) => this.playable(x));
    return s ? this.set(s) : null;
  }

  private set(s: Slot): Slot { this.cur = slotKey(s); this.onChange(); return s; }

  /**
   * Images to show with slot `s`: its own images (a video's picture first). A track without images
   * keeps the pictures of the nearest slot before it in play order that had some (not a video).
   */
  pictures(s: Slot): number[] {
    const video = s.track !== null && this.get(s.track)?.kind === 'video' ? [s.track] : [];
    if (s.pics.length || video.length) return [...video, ...s.pics];
    const order = this.playOrder(), i = order.findIndex((x) => slotKey(x) === slotKey(s));
    for (let j = i - 1; j >= 0; j--) if (order[j].pics.length) return order[j].pics;
    return [];
  }

  /**
   * Add files at the end, in natural path order. One matching a restored entry without a file
   * (same path and size) fills that in instead. Returns the ids of the entries that got files.
   */
  add(files: { name: string; path: string; kind: ItemKind; size: number; file: F }[]): number[] {
    const ids: number[] = [];
    for (const f of [...files].sort(byPath)) {
      const gap = this.items.find((e) => !e.file && e.path === f.path && e.size === f.size);
      if (gap) { gap.file = f.file; ids.push(gap.id); continue; }
      const e: Entry<F> = { id: this.nextId++, name: f.name, path: f.path, kind: f.kind, size: f.size, file: f.file };
      this.items.push(e); ids.push(e.id);
    }
    this.onChange();
    return ids;
  }

  /** Move entry `id` to list index `to` (the current slot stays current). */
  move(id: number, to: number): void {
    const i = this.items.findIndex((e) => e.id === id);
    if (i < 0) return;
    const [e] = this.items.splice(i, 1);
    this.items.splice(Math.max(0, Math.min(this.items.length, to)), 0, e);
    this.fixCur(); this.onChange();
  }

  /** Remove entry `id`. Returns whether it was part of the current slot. */
  remove(id: number): boolean {
    const was = this.current(), inCur = !!was && (was.track === id || was.pics.includes(id));
    this.items = this.items.filter((e) => e.id !== id);
    this.fixCur(); this.onChange();
    return inCur;
  }

  clear(): void { this.items = []; this.cur = null; this.order = []; this.onChange(); }

  /** A video turned out to have no sound: it shows like an image from now on. */
  markSilent(id: number): void {
    const e = this.get(id);
    if (!e || e.silent) return;
    e.silent = true; this.fixCur(); this.onChange();
  }

  setShuffle(on: boolean): void {
    if (on === this.shuffle) return;
    this.shuffle = on;
    if (on) this.reshuffle(this.cur);
    this.onChange();
  }
  setRepeat(r: Repeat): void { this.repeat = r; this.onChange(); }
  setImageBars(b: number): void { this.imageBars = Math.max(1, b | 0); this.onChange(); }

  /** After an edit the current key may name no slot (an image now grouped with a track): follow its entry. */
  private fixCur(): void {
    if (this.cur === null) return;
    const slots = this.slots(), id = this.cur;
    if (slots.some((s) => slotKey(s) === id)) return;
    const s = slots.find((x) => x.track === id || x.pics.includes(id));
    this.cur = s ? slotKey(s) : null;
  }

  save(): Saved {
    return {
      v: 1, shuffle: this.shuffle, repeat: this.repeat, imageBars: this.imageBars,
      at: this.cur === null ? -1 : this.items.findIndex((e) => e.id === this.cur),
      items: this.items.map((e) => ({ name: e.name, path: e.path, kind: e.kind, size: e.size, ...(e.silent ? { silent: true } : {}) })),
    };
  }

  /** Entries come back without files; anything malformed is dropped. */
  static restore<F>(s: unknown): Playlist<F> {
    const p = new Playlist<F>(), o = s as Partial<Saved> | null;
    if (!o || o.v !== 1 || !Array.isArray(o.items)) return p;
    for (const it of o.items) {
      if (!it || typeof it.name !== 'string' || typeof it.path !== 'string' || !['audio', 'video', 'image'].includes(it.kind) || !(it.size >= 0)) continue;
      p.items.push({ id: p.nextId++, name: it.name, path: it.path, kind: it.kind, size: +it.size, file: null, ...(it.silent ? { silent: true } : {}) });
    }
    p.shuffle = o.shuffle === true;
    p.repeat = REPEATS.includes(o.repeat as Repeat) ? o.repeat! : 'all';
    p.imageBars = typeof o.imageBars === 'number' && o.imageBars >= 1 ? o.imageBars | 0 : 8;
    const at = typeof o.at === 'number' ? p.items[o.at] : undefined;
    if (at) { p.cur = at.id; p.fixCur(); }
    if (p.shuffle) p.reshuffle(p.cur);
    return p;
  }
}

// ---------------------------------------------------------------- same-file matching across hosts

/** What identifies a file across devices without sending it: name, size and a hash of its ends. */
export interface Fingerprint { name: string; size: number; hash: string }

/** cyrb53: a fast 53-bit string-free hash of bytes (not cryptographic; crypto.subtle needs https). */
export function hashBytes(b: Uint8Array, seed = 0): string {
  let h1 = 0xdeadbeef ^ seed, h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < b.length; i++) { const c = b[i]; h1 = Math.imul(h1 ^ c, 2654435761); h2 = Math.imul(h2 ^ c, 1597334677); }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, '0');
}

const ENDS = 64 * 1024;
/** Hash of a file's first and last 64 KiB plus its size: quick even for a large video. */
export async function quickHash(f: { size: number; slice(a: number, b?: number): { arrayBuffer(): Promise<ArrayBuffer> } }): Promise<string> {
  const head = new Uint8Array(await f.slice(0, ENDS).arrayBuffer());
  const tail = f.size > ENDS ? new Uint8Array(await f.slice(Math.max(ENDS, f.size - ENDS)).arrayBuffer()) : new Uint8Array(0);
  const all = new Uint8Array(head.length + tail.length + 8);
  all.set(head); all.set(tail, head.length);
  new DataView(all.buffer).setFloat64(head.length + tail.length, f.size, true);
  return hashBytes(all);
}

export const sameFile = (a: Fingerprint, b: Fingerprint): boolean => a.size === b.size && a.hash === b.hash && a.name === b.name;

/**
 * Keep a video on a clock: seek when it is more than `seekOver` seconds off, else nudge its rate
 * (at most ±5 %) so it drifts back. Returns the seek target (or null) and the rate to set.
 */
export function videoSync(target: number, current: number, seekOver = 0.5): { seek: number | null; rate: number } {
  const d = current - target;
  if (Math.abs(d) > seekOver) return { seek: target, rate: 1 };
  if (Math.abs(d) < 0.02) return { seek: null, rate: 1 };
  return { seek: null, rate: Math.max(0.95, Math.min(1.05, 1 - d * 0.5)) };
}
