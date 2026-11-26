// Default settings of both pages, and how URL params and a device's remembered choices override them.
import { DEFAULT_AUTO_BARS, DEFAULT_TRANS_BEATS, TRANSITIONS, type AutoRot, type ClientMsg, type TransType } from '../core/protocol.ts';

type Get = (key: string) => string | null;

/** The app's transition and length selectors: the remembered choice, else random. */
export function mainTrans(remembered: Get): { type: TransType | 'random'; beats: number } {
  const type = remembered('trans'), beats = remembered('tlen');
  return {
    type: type === 'random' || (TRANSITIONS as readonly (string | null)[]).includes(type) ? (type as TransType) : 'random',
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
  return v === 'all' || (TRANSITIONS as readonly string[]).includes(v) ? (v as GalleryTrans) : 'random';
}
