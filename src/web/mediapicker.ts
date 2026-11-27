// The media picker: image / video files and the camera, for this host only (src/web/media.ts; never
// uploaded). Both pages put it next to their audio inputs. With "video sound" ticked, a picked
// video's audio drives the music features: `sound` hands the page the playing element (the gallery
// analyzes it locally, the app leads the room live). Unticked, videos play muted and the current
// audio input stays.
import { MEDIA, MEDIA_ACCEPT, isImage, isVideo, openCamera, openImage, openVideo, type MediaItem } from './media.ts';
import { cameraError, insecure } from './capture.ts';

const SOUND_KEY = 'media.sound';
const lsGet = (k: string) => { try { return localStorage.getItem(k); } catch { return null; } };
const lsSet = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } };

export interface PickerOpts {
  /** A picked video's sound should drive the music. */
  sound(video: HTMLVideoElement, name: string): void;
  /** Status / error text. */
  note(text: string): void;
}

const byPath = (a: File, b: File) => (a.webkitRelativePath || a.name).localeCompare(b.webkitRelativePath || b.name, undefined, { numeric: true, sensitivity: 'base' });

export function mediaPicker(o: PickerOpts): HTMLElement {
  const el = document.createElement('span'); el.className = 'media';
  const file = document.createElement('input'); file.type = 'file'; file.accept = MEDIA_ACCEPT; file.multiple = true; file.hidden = true;
  const btn = (text: string, title: string) => { const b = document.createElement('button'); b.textContent = text; b.title = title; return b; };
  const pickB = btn('image / video', 'show images or videos (png, jpg, webp, gif, mp4, webm, mov) on this screen; several cycle on the bar. They stay on this device.');
  const camB = btn('camera', 'show this device\'s camera');
  const offB = btn('no media', 'back to the fallback picture');
  const box = document.createElement('input'); box.type = 'checkbox'; box.checked = lsGet(SOUND_KEY) !== '0';
  const lab = document.createElement('label'); lab.title = 'a picked video\'s sound drives the music (off: videos play muted, the current audio input stays)';
  lab.append(box, ' video sound');
  el.append(pickB, camB, offB, lab, file);
  box.onchange = () => lsSet(SOUND_KEY, box.checked ? '1' : '0');

  let asked = 0, kind = '';
  const show = (items: MediaItem[], k: string) => {
    MEDIA.set(items); kind = items.length ? k : '';
    offB.hidden = !items.length;
    pickB.setAttribute('aria-pressed', String(kind === 'file')); camB.setAttribute('aria-pressed', String(kind === 'camera'));
  };
  show([], '');

  pickB.onclick = () => file.click();
  file.onchange = async () => {
    const list = [...(file.files ?? [])].filter((f) => isImage(f) || isVideo(f)).sort(byPath);
    file.value = '';
    if (!list.length) { o.note('no image or video there'); return; }
    const mine = ++asked, soundAt = box.checked ? list.findIndex(isVideo) : -1;
    o.note(`opening ${list.length > 1 ? `${list.length} files` : list[0].name}`);
    const res = await Promise.allSettled(list.map((f, i) => (isVideo(f) ? openVideo(f, i === soundAt, () => o.note('tap to start the video')) : openImage(f))));
    const items = res.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []));
    if (mine !== asked) { items.forEach((it) => it.stop()); return; }
    const errs = res.flatMap((r) => (r.status === 'rejected' ? [(r.reason as Error).message] : []));
    if (!items.length) { o.note(errs.join('; ')); return; }
    show(items, 'file');
    const audio = soundAt >= 0 && res[soundAt].status === 'fulfilled' ? (res[soundAt] as PromiseFulfilledResult<MediaItem>).value : null;
    if (audio?.video) { audio.audio = true; o.sound(audio.video, audio.name); }
    o.note([items.length > 1 ? `${items.length} pictures, cycling` : items[0].name, ...errs].join('; '));
  };

  camB.onclick = async () => {
    const mine = ++asked;
    let cam: MediaItem | null = null;
    try {
      cam = await openCamera(() => { if (cam && MEDIA.items.includes(cam)) { show([], ''); o.note('camera ended'); } });
      if (mine !== asked) { cam.stop(); return; }
      show([cam], 'camera'); o.note('camera');
    } catch (e) { if (mine === asked) o.note(cameraError(e as Error, insecure(), navigator)); }
  };
  offB.onclick = () => { ++asked; show([], ''); o.note(''); };
  return el;
}
