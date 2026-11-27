// Default settings of both pages, and how URL params and a device's remembered choices override them.
import { DEFAULT_AUTO_BARS, DEFAULT_TRANS_BEATS, type AutoRot, type ClientMsg, type TransType } from '../core/protocol.ts';
import { resolveTrans } from '../core/transitions.ts';

type Get = (key: string) => string | null;

/** The app's transition and length selectors: the remembered choice, else random. */
export function mainTrans(remembered: Get): { type: TransType | 'random'; beats: number } {
  const type = remembered('trans'), beats = remembered('tlen');
  return {
    type: type === 'random' ? 'random' : resolveTrans(type) ?? 'random',
    beats: beats === null || !Number.isFinite(+beats) ? DEFAULT_TRANS_BEATS : +beats,
  };
}

/**
 * Auto-rotation is the room's, and starts on. While nobody in the room has chosen (`preset`), a device
 * that remembers its own rotation or transition settings sends them; otherwise there's nothing to send.
 */
export function restoreAuto(room: AutoRot | null, remembered: Get): ClientMsg | null {
  if (!room?.preset || ['auto', 'trans', 'tlen'].every((k) => remembered(k) === null)) return null;
  const bars = remembered('auto');
  return { t: 'auto', bars: bars === null ? DEFAULT_AUTO_BARS : +bars, trans: mainTrans(remembered) };
}

/** The gallery's transitions: '' = off, 'random' per switch, 'all' in order, or one effect. */
export type GalleryTrans = '' | 'random' | 'all' | TransType;

/** `trans=` wins. Without it: random, but off for stills (`at=` / `stop=`), as they were. */
export function galleryTrans(qs: URLSearchParams): GalleryTrans {
  const v = qs.get('trans');
  if (v === null) return qs.has('at') || qs.has('stop') ? '' : 'random';
  if (['', 'off', 'none', '0'].includes(v)) return '';
  return v === 'all' ? 'all' : resolveTrans(v) ?? 'random';
}

/** Which scene the gallery's cycle goes to next: weighted by votes, list order, liked ones only, or none. */
export const GALLERY_ROTS = ['weighted', 'order', 'liked', 'stay'] as const;
export type GalleryRot = (typeof GALLERY_ROTS)[number];

/** `rot=` wins. Without it: `stay` when transitions are off, list order for stills, else weighted. */
export function galleryRot(qs: URLSearchParams): GalleryRot {
  const v = GALLERY_ROTS.find((r) => r === qs.get('rot'));
  return v ?? (!galleryTrans(qs) ? 'stay' : qs.has('at') || qs.has('stop') ? 'order' : 'weighted');
}

/** The gallery's transition length: `len=` wins, then the remembered choice (not for `at=` / `stop=` stills). */
export function galleryBeats(qs: URLSearchParams, remembered: string | null): number {
  const v = qs.get('len') ?? (qs.has('at') || qs.has('stop') ? null : remembered);
  return Math.max(0.5, Math.min(16, +(v ?? DEFAULT_TRANS_BEATS) || DEFAULT_TRANS_BEATS));
}

/** `hold=`: bars each scene of the gallery cycle shows alone; undefined (also if invalid) = the default. */
export function galleryHold(qs: URLSearchParams): number | undefined {
  const v = qs.get('hold'), n = Number(v);
  return v && n >= 0 ? Math.min(64, n) : undefined;
}
