// The input menu on both pages: one row of options (demo or off, mic, external, file), the
// external option's "use its video too" box inside its own row, the file option's playlist, and the
// camera as a picture source. The choice is remembered per page: on a reload it comes back by
// itself where it can (demo, a mic already allowed in the gallery), else one tap-to-resume button
// asks for the gesture the browser wants (mic, a share, re-adding files).
import { canShare, cameraError, insecure } from './capture.ts';
import { MEDIA, openCamera, type MediaItem } from './media.ts';
import { PLAYLIST_CSS, type FilePlaylist } from './playlistui.ts';
import { readLast, restorePlan, resumeText } from './lastshare.ts';

export type InputKind = 'demo' | 'off' | 'mic' | 'external' | 'file';

export interface MenuOpts {
  /** localStorage key prefix ("gallery", "app"). */
  page: string;
  /** The options shown, in order (external is left out where tab / system audio capture doesn't exist). */
  kinds: InputKind[];
  /** Element ids for the option buttons (the app's e2e clicks #live and #stop). */
  ids?: Partial<Record<InputKind, string>>;
  /**
   * Open `kind` (from a tap, or on load). `video`: external's "use its video too". Resolves false
   * when it didn't take over (refused, cancelled, failed: the page has said why through note()).
   * 'file' is handled here (the playlist), never passed.
   */
  open(kind: Exclude<InputKind, 'file'>, video: boolean): Promise<boolean>;
  files: FilePlaylist;
  /** A mic that is already allowed reopens without a tap (the gallery; the app asks first, as it leads the room). */
  autoMic?: boolean;
  /** Status / error text. */
  note(text: string): void;
  /** More controls for the pictures row (the app's "use the room's stream"). */
  pictures?: HTMLElement[];
}

const LABEL: Record<InputKind, string> = { demo: 'demo', off: 'off', mic: 'mic', external: 'external', file: 'file' };
const TITLE: Record<InputKind, string> = {
  demo: 'the built-in demo track',
  off: 'no music input (the room goes idle)',
  mic: 'microphone or line-in',
  external: 'music already playing elsewhere: a browser tab ("Share tab audio") or the whole system ("Entire screen" + "Share system audio")',
  file: 'audio, video and image files from this device, as a playlist',
};
const VIDEO_KEY = 'share.video';

const lsGet = (k: string) => { try { return localStorage.getItem(k); } catch { return null; } };
const lsSet = (k: string, v: string) => { if (!leaving) try { localStorage.setItem(k, v); } catch { /* private mode */ } };
/** The page is going away (a refresh): a capture ending now must not overwrite the remembered choice. */
let leaving = false;
addEventListener('pagehide', () => { leaving = true; });
addEventListener('pageshow', () => { leaving = false; });

let styled = false;

export interface InputMenu {
  el: HTMLElement;
  /** The audio input chosen on this page. */
  readonly kind: InputKind;
  /** Mark `kind` as the audio input (pressed, remembered) without opening anything. */
  set(kind: InputKind): void;
  /** Open `kind` as if tapped. */
  choose(kind: InputKind): Promise<void>;
  /** Redraw the pressed states. */
  refresh(): void;
  /** The playlist turned on or off (a playlist with tracks is then the audio input). */
  filesChanged(on: boolean): void;
}

export function inputMenu(o: MenuOpts): InputMenu {
  if (!styled) { styled = true; const st = document.createElement('style'); st.textContent = PLAYLIST_CSS; document.head.append(st); }
  const root = document.createElement('div'); root.className = 'inmenu';
  const opts = document.createElement('div'); opts.className = 'opts';
  const video = document.createElement('input'); video.type = 'checkbox';
  video.checked = lsGet(VIDEO_KEY) !== '0';
  video.onchange = () => { lsSet(VIDEO_KEY, video.checked ? '1' : '0'); if (!resume.hidden && resumeKind === 'external') offerExternal(); };
  const videoL = document.createElement('label');
  videoL.title = 'also show the shared tab\'s / screen\'s picture in media scenes, in place of the playlist\'s pictures while sharing (this device only, never uploaded; applies to the next share)';
  videoL.append(video, ' use its video too');
  const fileRow = document.createElement('div'); fileRow.className = 'opt';
  const pics = document.createElement('div'); pics.className = 'opt';
  const h = document.createElement('h4'); h.textContent = 'pictures';

  const kinds = o.kinds.filter((k) => k !== 'external' || canShare());
  const saved = lsGet(`${o.page}.input`) as InputKind | null;
  let kind: InputKind = kinds.includes(saved as InputKind) ? saved! : kinds[0];
  const buttons = new Map<InputKind, HTMLButtonElement>();
  for (const k of kinds) {
    const b = document.createElement('button'); b.type = 'button'; b.textContent = LABEL[k]; b.title = TITLE[k];
    if (o.ids?.[k]) b.id = o.ids[k]!;
    b.onclick = () => { hideResume(); menu.choose(k); };
    buttons.set(k, b);
    if (k !== 'external') { opts.append(b); continue; }
    // its video box belongs to it (applies to the next share)
    const g = document.createElement('span'); g.className = 'opt ext'; g.append(b, videoL); opts.append(g);
  }
  fileRow.append(o.files.el);

  // ---- camera: a picture source over the playlist's pictures while on ----
  let cam: { item: MediaItem; release: () => void } | null = null, camAsked = 0;
  const camB = document.createElement('button'); camB.type = 'button'; camB.textContent = 'camera'; camB.title = 'show this device\'s front camera (over the playlist\'s pictures while on)';
  const camOff = () => { cam?.release(); cam = null; camB.setAttribute('aria-pressed', 'false'); };
  camB.onclick = async () => {
    if (cam) { ++camAsked; camOff(); return; }
    const mine = ++camAsked;
    try {
      let item: MediaItem | null = null;
      item = await openCamera(() => { if (cam?.item === item) { camOff(); o.note('camera ended'); } });
      if (mine !== camAsked) { item.stop(); return; }
      cam = { item, release: MEDIA.share(item) };
      camB.setAttribute('aria-pressed', 'true');
    } catch (e) { if (mine === camAsked) o.note(cameraError(e as Error, insecure(), navigator)); }
  };
  camB.setAttribute('aria-pressed', 'false');
  pics.append(camB, ...(o.pictures ?? []));
  root.append(opts, fileRow, h, pics);

  const draw = () => {
    for (const [k, b] of buttons) b.setAttribute('aria-pressed', String(k === 'file' ? o.files.on : k === kind && !(o.files.on && o.files.pl.hasTracks)));
    fileRow.hidden = !o.files.on && !o.files.pl.items.length;
  };
  const set = (k: InputKind) => { kind = k; lsSet(`${o.page}.input`, k); draw(); };

  // ---- the one tap-to-resume button ----
  const resume = document.createElement('div'); resume.id = 'resume'; resume.hidden = true;
  const go = document.createElement('button'), x = document.createElement('button');
  let resumeKind: InputKind | null = null;
  x.className = 'x'; x.textContent = '✕'; x.title = 'not now'; x.setAttribute('aria-label', 'dismiss');
  resume.append(go, x);
  document.body.append(resume);
  function hideResume() { resume.hidden = true; resumeKind = null; }
  const offer = (text: string, run: () => void, sub = '') => {
    go.textContent = `▶ ${text}`;
    if (sub) { const s = document.createElement('small'); s.textContent = sub; go.append(s); }
    resume.classList.toggle('big', !!sub);
    go.onclick = () => { hideResume(); run(); };
    x.onclick = () => { hideResume(); if (kind !== 'file' && kind !== kinds[0]) set(kinds[0]); };
    resume.hidden = false;
  };

  /** One tap brings the last external pick back: sound, and its picture when "use its video too" is on. */
  function offerExternal() {
    const t = resumeText(readLast(lsGet), video.checked);
    offer(t.text, () => { menu.choose('external'); }, t.sub);
    resumeKind = 'external';
  }

  const menu: InputMenu = {
    el: root,
    get kind() { return kind; },
    set,
    async choose(k) {
      if (k === 'file') {
        if (o.files.on && o.files.pl.current()) { draw(); return; }
        o.files.start(); // filesChanged marks it once it plays (maybe after the chooser)
        draw();
        return;
      }
      if (await o.open(k, video.checked)) {
        // a track-playing playlist gives way; pictures alone keep going under any audio
        if (o.files.on && o.files.pl.hasTracks) o.files.stop();
        set(k);
      }
      draw();
    },
    refresh: draw,
    filesChanged(on) { if (on && o.files.pl.hasTracks) set('file'); else draw(); },
  };

  // ---- on load: bring the remembered choice back ----
  const missing = o.files.pl.missing;
  const reAdd = () => offer(`re-add ${missing} file${missing > 1 ? 's' : ''} to resume the playlist`, () => o.files.pick());
  const back = async () => {
    let micGranted = false;
    if (kind === 'mic' && o.autoMic) {
      try { micGranted = (await navigator.permissions.query({ name: 'microphone' as PermissionName })).state === 'granted'; } catch { /* Safari: no such query */ }
    }
    const plan = restorePlan(kind, kinds[0], { micGranted, filesOn: o.files.on, missing, items: o.files.pl.items.length });
    if (plan.do === 'open') {
      await menu.choose(plan.kind as InputKind);
      if (plan.kind === 'mic' && menu.kind !== 'mic') offer('resume the mic', () => { menu.choose('mic'); });
    } else if (plan.do === 'offer') {
      if (plan.kind === 'mic') offer('resume the mic', () => { menu.choose('mic'); });
      else if (plan.kind === 'external') offerExternal();
      else reAdd();
    }
  };
  // the playlist restored "on" only plays again once its files are back
  if (o.files.on && o.files.pl.missing) o.files.on = false;
  draw();
  back();
  return menu;
}
