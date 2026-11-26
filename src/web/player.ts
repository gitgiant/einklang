// Local track list for the host that loaded files or a folder. Each track is decoded here,
// analyzed in a worker, then uploaded; the next one is prepared while the current one plays.
import type { AnalyzeIn, AnalyzeOut } from './analyze.worker.ts';

/** Formats Chrome can decode; the browser has the final word (decode errors are reported). */
const MIME: Record<string, string> = {
  mp3: 'audio/mpeg', wav: 'audio/wav', wave: 'audio/wav', flac: 'audio/flac', ogg: 'audio/ogg', oga: 'audio/ogg',
  opus: 'audio/ogg', m4a: 'audio/mp4', mp4: 'audio/mp4', aac: 'audio/aac', webm: 'audio/webm', weba: 'audio/webm',
  aif: 'audio/aiff', aiff: 'audio/aiff', caf: 'audio/x-caf',
};
export const ACCEPT = ['audio/*', ...Object.keys(MIME).map((e) => `.${e}`)].join(',');
const ext = (name: string) => name.slice(name.lastIndexOf('.') + 1).toLowerCase();
export const isAudio = (f: File) => ext(f.name) in MIME || f.type.startsWith('audio/');

export interface Prepared { feat: Uint8Array<ArrayBuffer>; frames: number; bytes: ArrayBuffer; type: string }

export class Player {
  files: File[] = [];
  index = 0;
  private cache = new Map<File, Promise<Prepared>>();
  private worker = new Worker(new URL('./analyze.worker.ts', import.meta.url), { type: 'module' });
  private jobs = new Map<number, { ok: (o: Uint8Array<ArrayBuffer>) => void; progress: (p: number) => void }>();
  private nextJob = 1;

  constructor() {
    this.worker.onmessage = (e: MessageEvent<AnalyzeOut>) => {
      const j = this.jobs.get(e.data.id); if (!j) return;
      if ('out' in e.data) { this.jobs.delete(e.data.id); j.ok(e.data.out); } else j.progress(e.data.progress);
    };
  }

  /** Audio files only, in natural path order (folders keep their track numbering). */
  setFiles(list: Iterable<File>): number {
    const path = (f: File) => f.webkitRelativePath || f.name;
    this.files = [...list].filter(isAudio).sort((a, b) => path(a).localeCompare(path(b), undefined, { numeric: true, sensitivity: 'base' }));
    this.index = 0; this.cache.clear();
    return this.files.length;
  }

  get names(): string[] { return this.files.map((f) => f.name.replace(/\.[^.]+$/, '')); }

  /** Decode + analyze track i (cached; only the current and next are kept). */
  prepare(i: number, progress: (p: number) => void = () => {}): Promise<Prepared> {
    const f = this.files[i];
    let p = this.cache.get(f);
    if (!p) {
      p = this.load(f, progress);
      p.catch(() => this.cache.delete(f));
      this.cache.set(f, p);
    }
    const keep = new Set([this.files[i], this.files[(i + 1) % this.files.length]]);
    for (const k of this.cache.keys()) if (!keep.has(k)) this.cache.delete(k);
    return p;
  }

  private async load(f: File, progress: (p: number) => void): Promise<Prepared> {
    const bytes = await f.arrayBuffer();
    const ac = new AudioContext();
    let ab: AudioBuffer;
    try { ab = await ac.decodeAudioData(bytes.slice(0)); }
    catch { throw new Error(`can't decode "${f.name}" (format not supported by this browser)`); }
    finally { ac.close(); }
    const channels = Array.from({ length: ab.numberOfChannels }, (_, c) => ab.getChannelData(c).slice());
    const id = this.nextJob++;
    const feat = await new Promise<Uint8Array<ArrayBuffer>>((ok) => {
      this.jobs.set(id, { ok, progress });
      this.worker.postMessage({ id, rate: ab.sampleRate, channels } satisfies AnalyzeIn, channels.map((c) => c.buffer));
    });
    return { feat, frames: new DataView(feat.buffer).getUint32(1, true), bytes, type: MIME[ext(f.name)] ?? (f.type || 'application/octet-stream') };
  }
}
