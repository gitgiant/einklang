// The remembered input choice after a reload: what to bring back by itself and what to offer as the
// one tap-to-resume button (restorePlan), and for external the last pick: which kind of surface was
// shared (tab, window, screen) and what it was called, so the button can say "pick the window again"
// and the picker opens on that surface. No DOM here (unit-tested); capture.ts and inputmenu.ts use it.

/** getDisplayMedia's surface kinds (getSettings().displaySurface). */
export type Surface = 'browser' | 'window' | 'monitor';

export interface LastShare {
  surface?: Surface;
  /** A human name for the pick (the window's / tab's title), when the browser gives one. */
  label?: string;
}

export const LAST_KEY = 'share.last';
const SURFACES: Surface[] = ['browser', 'window', 'monitor'];

export const RAW_AUDIO = { echoCancellation: false, noiseSuppression: false, autoGainControl: false };

/** Read the remembered pick (null: none or unreadable). */
export function readLast(get: (k: string) => string | null): LastShare | null {
  try {
    const v = JSON.parse(get(LAST_KEY) ?? 'null') as LastShare | null;
    if (!v || typeof v !== 'object') return null;
    const out: LastShare = {};
    if (SURFACES.includes(v.surface as Surface)) out.surface = v.surface;
    if (typeof v.label === 'string' && v.label) out.label = v.label.slice(0, 120);
    return out.surface || out.label ? out : null;
  } catch { return null; }
}

export function saveLast(set: (k: string, v: string) => void, last: LastShare): void {
  set(LAST_KEY, JSON.stringify(last));
}

/**
 * A captured track's pick. Chrome names its video tracks by id ("window:1234:0", "screen:0:0",
 * "web-contents-media-stream://…"): those say nothing to a person and are dropped; Firefox gives titles.
 */
export function pickOf(track: { label: string; getSettings?(): { displaySurface?: string } } | undefined): LastShare {
  if (!track) return {};
  const out: LastShare = {};
  const s = track.getSettings?.().displaySurface;
  if (SURFACES.includes(s as Surface)) out.surface = s as Surface;
  const l = track.label.trim();
  if (l && !/^(window|screen|web-contents-media-stream):/i.test(l)) out.label = l;
  return out;
}

const WHAT: Record<Surface, string> = { browser: 'the tab', window: 'the window', monitor: 'the entire screen' };

const short = (s: string, n = 40) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** The resume button's text for a remembered external pick. */
export function resumeText(last: LastShare | null, video: boolean): { text: string; sub: string } {
  const what = last?.surface ? WHAT[last.surface] : 'the tab / window / screen';
  const named = last?.label ? `${what} "${short(last.label)}"` : what;
  return {
    text: `resume external${video ? ' (sound + picture)' : ' sound'}: pick ${named} again`,
    sub: `the browser always asks: its picker opens${last?.surface ? ` on ${PICKER_TAB[last.surface]}` : ''}, keep its audio box on`,
  };
}
const PICKER_TAB: Record<Surface, string> = { browser: 'tabs', window: 'windows', monitor: 'entire screen' };

/**
 * getDisplayMedia's options: audio asked for (Chrome's audio box then starts on for tabs, windows
 * and screens), a window bringing the system's sound (`windowAudio`, Chrome 141+; unknown keys are
 * ignored elsewhere), and the picker opened on the last surface.
 */
export function shareOptions(last: LastShare | null): DisplayMediaStreamOptions {
  return {
    // video is required by Chrome; capture.ts drops it unless wanted
    video: last?.surface ? { displaySurface: last.surface } : true,
    audio: { ...RAW_AUDIO, suppressLocalAudioPlayback: false },
    systemAudio: 'include', windowAudio: 'system', monitorTypeSurfaces: 'include',
    selfBrowserSurface: 'exclude', surfaceSwitching: 'include', preferCurrentTab: false,
  } as DisplayMediaStreamOptions;
}

/** What to say when a pick came back without sound. */
export function noAudioText(surface: Surface | undefined): string {
  if (surface === 'window') return 'no audio came with that window (a window\'s sound needs Chrome 141 or newer): pick Entire screen with "Share system audio" on, or the tab itself with "Share tab audio"';
  if (surface === 'monitor') return 'no audio was shared: pick Entire screen again with "Share system audio" on (Windows / ChromeOS), or a tab with "Share tab audio"';
  if (surface === 'browser') return 'no audio was shared: pick the tab again with "Share tab audio" on';
  return 'no audio was shared: pick a tab with "Share tab audio" on, or Entire screen with "Share system audio"';
}

/**
 * What a page does on load with its remembered input `kind` (`first`: the page's default, demo / off):
 * `open` it by itself, offer the tap-to-resume button for the mic / external / missing files, or
 * nothing. `micGranted`: the mic is already allowed and may reopen without a tap (gallery only).
 */
export type Plan = { do: 'open'; kind: string } | { do: 'offer'; kind: 'mic' | 'external' | 'files' } | { do: 'none' };
export function restorePlan(kind: string, first: string, s: { micGranted: boolean; filesOn: boolean; missing: number; items: number }): Plan {
  if (kind === 'mic') return s.micGranted ? { do: 'open', kind } : { do: 'offer', kind };
  if (kind === 'external') return { do: 'offer', kind }; // getDisplayMedia always needs a tap and its picker
  if ((kind === 'file' || s.filesOn) && s.missing && s.items) return { do: 'offer', kind: 'files' };
  return kind !== 'file' && kind !== first ? { do: 'open', kind } : { do: 'none' };
}
