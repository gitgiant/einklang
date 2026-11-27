// Decoding + analysis of playlist tracks on the host that picked them. Each track is decoded here,
// analyzed in a worker and kept (the current and the next one); the app then uploads its sound,
// the gallery plays it locally. A video's sound is re-encoded as WAV, so the video file itself
// never leaves the device.
import type { AnalyzeIn, AnalyzeOut } from './analyze.worker.ts';
// inlined: the single-file gallery build (build:live) has nowhere to load a separate worker from
import AnalyzeWorker from './analyze.worker.ts?worker&inline';
import { MEDIA_ACCEPT, isImage, isVideo } from './media.ts';
import type { ItemKind } from './playlist.ts';

/** Formats Chrome can decode; the browser has the final word (decode errors are reported). */
const MIME: Record<string, string> = {
  mp3: 'audio/mpeg', wav: 'audio/wav', wave: 'audio/wav', flac: 'audio/flac', ogg: 'audio/ogg', oga: 'audio/ogg',
  opus: 'audio/ogg', m4a: 'audio/mp4', aac: 'audio/aac', weba: 'audio/webm',
  aif: 'audio/aiff', aiff: 'audio/aiff', caf: 'audio/x-caf',
};
/** The one file chooser: audio, video, images, plus .lrc lyrics that go with a track of the same name. */
export const ACCEPT = ['audio/*', ...Object.keys(MIME).map((e) => `.${e}`), MEDIA_ACCEPT, '.lrc'].join(',');
const ext = (name: string) => name.slice(name.lastIndexOf('.') + 1).toLowerCase();
const stem = (path: string) => path.replace(/\.[^./]+$/, '').toLowerCase();
export const isAudio = (f: { name: string; type: string }) => (ext(f.name) in MIME || f.type.startsWith('audio/')) && !isVideo(f);
export const isLrc = (f: { name: string }) => ext(f.name) === 'lrc';
/** What a picked file is in the playlist, or null (not playable here). */
export const kindOf = (f: { name: string; type: string }): ItemKind | null => (isVideo(f) ? 'video' : isAudio(f) ? 'audio' : isImage(f) ? 'image' : null);
export const pathOf = (f: File) => f.webkitRelativePath || f.name;
/** A file's name for the UI: without its extension. */
export const title = (name: string) => name.replace(/\.[^.]+$/, '');

export interface Prepared { feat: Uint8Array<ArrayBuffer>; frames: number; bytes: ArrayBuffer; type: string }

/** 16-bit PCM WAV of decoded channels. */
export function wav(channels: Float32Array[], rate: number): ArrayBuffer {
  const nc = Math.max(1, channels.length), n = channels[0]?.length ?? 0, buf = new ArrayBuffer(44 + n * nc * 2), dv = new DataView(buf);
  const str = (o: number, s: string) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); dv.setUint32(4, 36 + n * nc * 2, true); str(8, 'WAVEfmt '); dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true); dv.setUint16(22, nc, true); dv.setUint32(24, rate, true); dv.setUint32(28, rate * nc * 2, true);
  dv.setUint16(32, nc * 2, true); dv.setUint16(34, 16, true); str(36, 'data'); dv.setUint32(40, n * nc * 2, true);
  let o = 44;
  for (let i = 0; i < n; i++) for (let c = 0; c < nc; c++, o += 2) dv.setInt16(o, Math.max(-1, Math.min(1, channels[c]?.[i] ?? 0)) * 32767, true);
  return buf;
}

/** Videos larger than this aren't read whole to decode their sound (they show as pictures). */
const MAX_VIDEO_DECODE = 768 * 1024 * 1024;

export class Player {
  /** .lrc files by path without extension ("album/01 song"). */
  private lrc = new Map<string, File>();
  private cache = new Map<File, Promise<Prepared>>();
  private worker = new AnalyzeWorker();
  private jobs = new Map<number, { ok: (o: Uint8Array<ArrayBuffer>) => void; progress: (p: number) => void }>();
  private nextJob = 1;

  constructor() {
    this.worker.onmessage = (e: MessageEvent<AnalyzeOut>) => {
      const j = this.jobs.get(e.data.id); if (!j) return;
      if ('out' in e.data) { this.jobs.delete(e.data.id); j.ok(e.data.out); } else j.progress(e.data.progress);
    };
  }

  /** Remember the .lrc files among `list` (they pair with a track of the same path). */
  addLyrics(list: Iterable<File>): void {
    for (const f of list) if (isLrc(f)) this.lrc.set(stem(pathOf(f)), f);
  }

  /** The text of the .lrc next to `f` (same name), or null. */
  async lyrics(f: File): Promise<string | null> {
    const l = this.lrc.get(stem(pathOf(f)));
    return l ? l.text() : null;
  }

  /** Decode + analyze `f` (cached; only `f` and `next` are kept). Rejects for a video without sound. */
  prepare(f: File, progress: (p: number) => void = () => {}, next?: File): Promise<Prepared> {
    let p = this.cache.get(f);
    if (!p) {
      p = this.load(f, progress);
      p.catch(() => this.cache.delete(f));
      this.cache.set(f, p);
    }
    for (const k of this.cache.keys()) if (k !== f && k !== next) this.cache.delete(k);
    return p;
  }

  private async load(f: File, progress: (p: number) => void): Promise<Prepared> {
    const video = isVideo(f);
    if (video && f.size > MAX_VIDEO_DECODE) throw new SilentError(`"${f.name}" is too big to analyze its sound here`);
    const bytes = await f.arrayBuffer();
    const ac = new AudioContext();
    let ab: AudioBuffer;
    try { ab = await ac.decodeAudioData(video ? bytes : bytes.slice(0)); }
    catch { throw video ? new SilentError(`no sound in "${f.name}" this browser can decode`) : new Error(`can't decode "${f.name}" (format not supported by this browser)`); }
    finally { ac.close(); }
    const channels = Array.from({ length: ab.numberOfChannels }, (_, c) => ab.getChannelData(c).slice());
    // a video's sound goes out as WAV (the video stays here)
    const out = video ? wav(channels.slice(0, 2), ab.sampleRate) : bytes;
    const id = this.nextJob++;
    const feat = await new Promise<Uint8Array<ArrayBuffer>>((ok) => {
      this.jobs.set(id, { ok, progress });
      this.worker.postMessage({ id, rate: ab.sampleRate, channels } satisfies AnalyzeIn, channels.map((c) => c.buffer));
    });
    return { feat, frames: new DataView(feat.buffer).getUint32(1, true), bytes: out, type: video ? 'audio/wav' : MIME[ext(f.name)] ?? (f.type || 'application/octet-stream') };
  }
}

/** A video whose sound can't be used: it plays as a picture instead. */
export class SilentError extends Error { readonly silent = true; }
