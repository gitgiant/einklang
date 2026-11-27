// Visual media picked on this host: image files, video files, the camera. Per host and never
// hashed or sent anywhere (no upload): pieces read it through GpuInit.media (lab/api/media.ts),
// which this module serves. Images upload to the GPU once; a video or the camera copies a frame
// into its texture only when a new one exists (requestVideoFrameCallback).
import type { MediaFrame, MediaInput, MediaKind } from '../../lab/api/media.ts';

type Source = ImageBitmap | HTMLVideoElement | HTMLCanvasElement | OffscreenCanvas;

export interface MediaItem {
  kind: MediaKind;
  name: string;
  /** What copyExternalImageToTexture reads. */
  source: Source;
  /** Selfie camera: shown mirrored by default. */
  mirror: boolean;
  /** Bumps whenever the source shows a new frame (images: never). */
  gen: number;
  size(): [number, number];
  /** It has a frame to copy. */
  ready(): boolean;
  /** Sources without frame callbacks: check for a new frame (bumps gen). */
  poll?(): void;
  /** A video: playing while it shows (or always, when `audio`), paused while it doesn't. */
  video?: HTMLVideoElement;
  /** Its sound drives the music features: keeps playing when another item shows. */
  audio?: boolean;
  /** When frame() last asked for it (ms). */
  used?: number;
  stop(): void;
}

// GPUTextureUsage.TEXTURE_BINDING | COPY_DST | RENDER_ATTACHMENT (copyExternalImageToTexture needs the last two)
const USAGE = 0x04 | 0x02 | 0x10;
/** A video not shown for this long pauses (unless its sound drives the music). */
const IDLE_MS = 1500;

interface Tex { tex: GPUTexture; gen: number; w: number; h: number }

export class MediaHost {
  private list: MediaItem[] = [];
  private caches: { device: GPUDevice; map: Map<MediaItem, Tex> }[] = [];
  private failed = new Set<MediaItem>();
  /** Pauses videos while no scene asks for them (no media scene on screen). */
  private timer: ReturnType<typeof setInterval> | null = null;
  readonly listeners = new Set<() => void>();
  /** The clock for play/pause bookkeeping (tests replace it). */
  now = () => performance.now();

  get items(): readonly MediaItem[] { return this.list; }

  /** Replace what is picked (the old items stop, their textures go). */
  set(items: MediaItem[]): void {
    const keep = new Set(items);
    for (const it of this.list) if (!keep.has(it)) it.stop();
    for (const c of this.caches) for (const [it, t] of c.map) if (!keep.has(it)) { t.tex.destroy(); c.map.delete(it); }
    this.list = items;
    this.failed.clear();
    const videos = items.some((it) => it.video);
    if (videos && !this.timer) this.timer = setInterval(() => this.sweep(null, this.now()), 1000);
    else if (!videos && this.timer) { clearInterval(this.timer); this.timer = null; }
    for (const f of this.listeners) f();
  }
  clear(): void { this.set([]); }

  /** The piece API view of this host's media on `device`. */
  input(device: GPUDevice): MediaInput {
    return { count: () => this.list.length, frame: (i) => this.frame(device, i) };
  }

  private cache(device: GPUDevice): Map<MediaItem, Tex> {
    let c = this.caches.find((x) => x.device === device);
    if (!c) this.caches.push((c = { device, map: new Map() }));
    return c.map;
  }

  frame(device: GPUDevice, i: number): MediaFrame | null {
    const n = this.list.length;
    if (!n) return null;
    const it = this.list[((i % n) + n) % n], now = this.now();
    it.used = now;
    this.sweep(it, now);
    it.poll?.();
    const cache = this.cache(device);
    let c = cache.get(it);
    const frameOf = (t: Tex): MediaFrame => ({ texture: t.tex, width: t.w, height: t.h, kind: it.kind, mirror: it.mirror });
    if (!it.ready() || this.failed.has(it)) return c ? frameOf(c) : null;
    const [w, h] = it.size();
    if (!(w > 0 && h > 0)) return c ? frameOf(c) : null;
    if (!c || c.w !== w || c.h !== h) {
      c?.tex.destroy();
      c = { tex: device.createTexture({ size: [w, h], format: 'rgba8unorm-srgb', usage: USAGE, label: `media ${it.name}` }), gen: -1, w, h };
      cache.set(it, c);
    }
    if (c.gen !== it.gen) {
      try { device.queue.copyExternalImageToTexture({ source: it.source }, { texture: c.tex }, [w, h]); c.gen = it.gen; }
      catch (e) { this.failed.add(it); console.warn(`media ${it.name}: can't upload (${(e as Error).message})`); }
    }
    return frameOf(c);
  }

  /** Play the shown video; pause the others that haven't shown for a while (their sound aside). */
  private sweep(shown: MediaItem | null, now: number): void {
    for (const it of this.list) {
      const v = it.video;
      if (!v || it.kind === 'camera') continue;
      if (it === shown || it.audio) { if (v.paused) v.play().catch(() => {}); }
      else if (!v.paused && now - (it.used ?? 0) > IDLE_MS) v.pause();
    }
  }
}

/** This page's media (one per page: the engines on it share it). */
export const MEDIA = new MediaHost();

// ---------------------------------------------------------------- opening

const IMAGE_EXT = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'avif', 'bmp'], VIDEO_EXT = ['mp4', 'webm', 'mov', 'm4v', 'ogv', 'mkv'];
/** File picker filter for the media picker. */
export const MEDIA_ACCEPT = ['image/*', 'video/*', ...[...IMAGE_EXT, ...VIDEO_EXT].map((e) => `.${e}`)].join(',');
const ext = (name: string) => name.slice(name.lastIndexOf('.') + 1).toLowerCase();
export const isImage = (f: { name: string; type: string }) => f.type.startsWith('image/') || IMAGE_EXT.includes(ext(f.name));
export const isVideo = (f: { name: string; type: string }) => f.type.startsWith('video/') || VIDEO_EXT.includes(ext(f.name));

/** Longest side an image is kept at (a 48 MP photo would be 190 MB of texture). */
const MAX_SIDE = 4096;

/** Decode an image file (an animated GIF shows its first frame). */
export async function openImage(f: File): Promise<MediaItem> {
  let bmp: ImageBitmap;
  try { bmp = await createImageBitmap(f); } catch { throw new Error(`can't open "${f.name}" (not an image this browser can decode)`); }
  const big = Math.max(bmp.width, bmp.height);
  if (big > MAX_SIDE) {
    const k = MAX_SIDE / big, small = await createImageBitmap(bmp, { resizeWidth: Math.round(bmp.width * k), resizeHeight: Math.round(bmp.height * k), resizeQuality: 'high' });
    bmp.close(); bmp = small;
  }
  const b = bmp;
  return { kind: 'image', name: f.name, source: b, mirror: false, gen: 0, size: () => [b.width, b.height], ready: () => true, stop: () => b.close() };
}

/** A video element kept in the page (iOS only decodes frames of attached elements), invisible. */
function videoElement(): HTMLVideoElement {
  const v = document.createElement('video');
  v.playsInline = true; v.setAttribute('playsinline', ''); v.preload = 'auto';
  v.style.cssText = 'position:fixed;left:0;top:0;width:2px;height:2px;opacity:0;pointer-events:none';
  document.body.append(v);
  return v;
}

/** A MediaItem over a playing video element; `gen` follows its frames. */
function videoItem(v: HTMLVideoElement, kind: MediaKind, name: string, mirror: boolean, stop: () => void): MediaItem {
  let live = true, last = -1;
  const it: MediaItem = {
    kind, name, source: v, mirror, gen: 0, video: v,
    size: () => [v.videoWidth, v.videoHeight],
    ready: () => v.readyState >= 2 && v.videoWidth > 0,
    stop: () => { live = false; stop(); },
  };
  if (typeof (v as Partial<HTMLVideoElement>).requestVideoFrameCallback === 'function') {
    const loop = () => { it.gen++; if (live) v.requestVideoFrameCallback(loop); };
    v.requestVideoFrameCallback(loop);
  } else it.poll = () => { if (v.currentTime !== last) { last = v.currentTime; it.gen++; } };
  return it;
}

/**
 * Open a video file, looping. With `sound` its audio plays here (the caller routes it into the
 * analysis); without, it plays muted. `blocked`: the browser wants a tap before it plays.
 */
export async function openVideo(f: File, sound: boolean, blocked: () => void = () => {}): Promise<MediaItem> {
  const v = videoElement(), url = URL.createObjectURL(f);
  v.loop = true; v.muted = !sound; v.src = url;
  const stop = () => { v.pause(); v.removeAttribute('src'); v.load(); v.remove(); URL.revokeObjectURL(url); };
  try {
    await new Promise<void>((ok, no) => {
      v.onloadeddata = () => ok();
      v.onerror = () => no(new Error(`can't play "${f.name}" (format not supported by this browser)`));
    });
  } catch (e) { stop(); throw e; }
  const play = () => v.play().then(() => removeEventListener('pointerup', play), () => { blocked(); addEventListener('pointerup', play, { once: true }); });
  play();
  return videoItem(v, 'video', f.name, false, () => { removeEventListener('pointerup', play); stop(); });
}

/** The front camera (selfie, mirrored). Call from a user gesture (iOS). `ended`: the camera went away. */
export async function openCamera(ended: () => void = () => {}): Promise<MediaItem> {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('no camera access here');
  const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
  const v = videoElement();
  v.muted = true; v.srcObject = stream;
  const stop = () => { stream.getTracks().forEach((t) => t.stop()); v.srcObject = null; v.remove(); };
  for (const t of stream.getVideoTracks()) t.onended = ended;
  try { await v.play(); } catch (e) { stop(); throw e; }
  return videoItem(v, 'camera', stream.getVideoTracks()[0]?.label || 'camera', true, stop);
}

/** A canvas the caller redraws (the lab's generated test media): call `touch()` after each draw. */
export function canvasItem(c: HTMLCanvasElement | OffscreenCanvas, kind: MediaKind, name: string): MediaItem & { touch(): void } {
  const it = { kind, name, source: c, mirror: false, gen: 0, size: (): [number, number] => [c.width, c.height], ready: () => true, stop: () => {}, touch: () => { it.gen++; } };
  return it;
}
