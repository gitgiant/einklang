// Live audio input, analyzed on this device: the mic / line-in or shared tab / system audio, turned
// into one feature message per tick. The app's leader sends the messages to the room; the gallery
// keeps them to itself. (Whole files go through player.ts.)
import { Analyzer, N } from '../core/analysis.ts';
import { FPS, STRIDE, WAVE_BYTES } from '../core/constants.ts';
import { decimateWave } from '../core/features.ts';
import { bindStream } from './sharevideo.ts';

const RAW_AUDIO = { echoCancellation: false, noiseSuppression: false, autoGainControl: false };
/** Hint to append to a capture error (capture needs a secure context: localhost or https). */
export const insecure = () => (isSecureContext ? '' : ' (capture needs localhost or https: open the 127.0.0.1 link, or use `tailscale serve`)');


export async function openMic(): Promise<MediaStream> {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('no microphone access here'); // insecure context
  return navigator.mediaDevices.getUserMedia({ audio: RAW_AUDIO });
}

/** Whether tab / system audio capture exists at all (not on iOS, nor in an insecure context). */
export const canShare = () => !!navigator.mediaDevices?.getDisplayMedia;

/** What to show when opening the mic failed. `hint` is insecure()'s; `nav` is the navigator. */
export const micError = (e: { name: string; message: string }, hint: string, nav: { userAgent: string; maxTouchPoints: number }): string => permError('mic', e, hint, nav);
/** The same for the camera (image input). */
export const cameraError = (e: { name: string; message: string }, hint: string, nav: { userAgent: string; maxTouchPoints: number }): string => permError('camera', e, hint, nav);

function permError(dev: 'mic' | 'camera', e: { name: string; message: string }, hint: string, nav: { userAgent: string; maxTouchPoints: number }): string {
  if (hint || e.name !== 'NotAllowedError') return `${dev} failed: ${e.message}${hint}`;
  const what = dev === 'mic' ? 'microphone' : 'camera', What = dev === 'mic' ? 'Microphone' : 'Camera', ua = nav.userAgent;
  // iPadOS reports as a Mac: only the touch screen gives it away
  if (!(/iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && nav.maxTouchPoints > 1))) return `${dev} blocked: allow the ${what} for this site in the browser's site settings`;
  const browser = /CriOS/.test(ua) ? 'Chrome' : /FxiOS/.test(ua) ? 'Firefox' : /EdgiOS/.test(ua) ? 'Edge' : /Version\/.*Safari/.test(ua) ? 'Safari' : 'your browser';
  return `${dev} blocked: allow ${What} for this browser in iOS Settings → Apps → ${browser}, and for this site in the browser's site settings, then tap ${dev} again`;
}


/**
 * Music already playing elsewhere: a Chrome tab ("Share tab audio") or any app via "Entire screen" +
 * "Share system audio" (Windows/ChromeOS). The source keeps playing normally. Call from a user gesture.
 * With `video` its picture comes along (LiveAnalyzer shows it as this host's media).
 */
export async function openShare(video = false): Promise<MediaStream> {
  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: true, // required by Chrome; dropped below unless wanted
    audio: { ...RAW_AUDIO, suppressLocalAudioPlayback: false },
    systemAudio: 'include', selfBrowserSurface: 'exclude', surfaceSwitching: 'include', preferCurrentTab: false,
  } as DisplayMediaStreamOptions);
  const audio = stream.getAudioTracks();
  const keep = video && audio.length ? stream.getVideoTracks().slice(0, 1) : [];
  for (const t of stream.getVideoTracks()) if (!keep.includes(t)) t.stop();
  if (!audio.length) throw new Error('no audio was shared: pick a tab with "Share tab audio" on, or Entire screen with "Share system audio"');
  return new MediaStream([...audio, ...keep]);
}

const VIDEO_KEY = 'share.video';
/** The "use its video too" box next to a page's tab / system audio button (default on, remembered). */
export function shareVideoBox(): { el: HTMLLabelElement; box: HTMLInputElement } {
  const el = document.createElement('label'), box = document.createElement('input');
  el.className = 'sharevideo';
  el.title = 'also show the shared tab\'s / screen\'s picture in media scenes, replacing picked media while sharing (this device only, never uploaded; applies to the next share)';
  box.type = 'checkbox';
  try { box.checked = localStorage.getItem(VIDEO_KEY) !== '0'; } catch { box.checked = true; }
  box.onchange = () => { try { localStorage.setItem(VIDEO_KEY, box.checked ? '1' : '0'); } catch { /* private mode */ } };
  el.append(box, ' use its video too');
  return { el, box };
}

/** Live audio to analyze: a capture stream, or a playing media element (a video's sound). */
export type LiveSource = MediaStream | HTMLMediaElement;

export class LiveAnalyzer {
  readonly source: LiveSource;
  /** The newest tick produced. */
  private last = -1;
  private ac = new AudioContext();
  private an: Analyzer;
  private analyser: AnalyserNode;
  private td = new Float32Array(N);
  /** Per-channel taps for the waveform stream. */
  private wl: AnalyserNode;
  private wr: AnalyserNode;
  private bl = new Float32Array(2048);
  private br = new Float32Array(2048);
  /** A captured stream: stops its tracks and takes its video off the screen. */
  private unbind: (() => void) | null = null;

  /**
   * `ended`: the user pressed "Stop sharing" in Chrome's bar, the device went away, or the media
   * element was emptied. An element's sound is routed through here to the speakers, so closing the
   * analyzer silences it (its picture plays on).
   */
  constructor(source: LiveSource, ended: () => void) {
    this.source = source;
    const ac = this.ac;
    this.an = new Analyzer(ac.sampleRate);
    this.analyser = ac.createAnalyser(); this.analyser.fftSize = N;
    const el = source instanceof MediaStream ? null : source;
    const src = el ? ac.createMediaElementSource(el) : ac.createMediaStreamSource(source as MediaStream);
    src.connect(this.analyser); // analysis only: a stream is not routed to the speakers
    if (el) {
      src.connect(ac.destination);
      el.addEventListener('emptied', ended, { once: true });
      // the pick's user gesture may have run out while the file loaded: resume on the next tap
      addEventListener('pointerup', () => { ac.resume().catch(() => {}); }, { once: true });
    }
    // stereo taps for the scope; a mono source feeds the same signal to both (splitter upmixes)
    const split = ac.createChannelSplitter(2);
    this.wl = ac.createAnalyser(); this.wr = ac.createAnalyser();
    this.wl.fftSize = this.wr.fftSize = 2048;
    src.connect(split); split.connect(this.wl, 0); split.connect(this.wr, 1);
    ac.resume().catch(() => {}); // Safari starts contexts suspended
    if (!el) this.unbind = bindStream(source as MediaStream, ended);
  }

  /**
   * Emit every tick up to `cur` not produced yet, as [1][u32 tick][features][waveform] messages.
   * Call a few times per tick.
   */
  pull(cur: number, emit: (tick: number, msg: Uint8Array<ArrayBuffer>) => void): void {
    if (cur < 0) return;
    if (this.last < cur - 30) this.last = cur - 1; // don't burst after a stall
    this.analyser.getFloatTimeDomainData(this.td);
    this.wl.getFloatTimeDomainData(this.bl); this.wr.getFloatTimeDomainData(this.br);
    const span = this.ac.sampleRate / FPS;
    while (this.last < cur) {
      this.last++;
      const b = this.an.frame(this.td), m = new Uint8Array(5 + STRIDE + WAVE_BYTES);
      m[0] = 1; new DataView(m.buffer).setUint32(1, this.last, true); m.set(b, 5);
      decimateWave(this.bl, this.br, this.bl.length - span, span, m, 5 + STRIDE); // the newest tick of audio
      emit(this.last, m);
    }
  }

  close(): void { this.unbind?.(); this.ac.close(); }
}
