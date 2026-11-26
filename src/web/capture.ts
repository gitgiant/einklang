// Live audio input, analyzed on this device: the mic / line-in or shared tab / system audio, turned
// into one feature message per tick. The app's leader sends the messages to the room; the gallery
// keeps them to itself. (Whole files go through player.ts.)
import { Analyzer, N } from '../core/analysis.ts';
import { FPS, STRIDE, WAVE_BYTES } from '../core/constants.ts';
import { decimateWave } from '../core/features.ts';

const RAW_AUDIO = { echoCancellation: false, noiseSuppression: false, autoGainControl: false };
/** Hint to append to a capture error (capture needs a secure context: localhost or https). */
export const insecure = () => (isSecureContext ? '' : ' (capture needs localhost or https: open the 127.0.0.1 link, or use `tailscale serve`)');

export const openMic = async (): Promise<MediaStream> => navigator.mediaDevices.getUserMedia({ audio: RAW_AUDIO });

/**
 * Music already playing elsewhere: a Chrome tab ("Share tab audio") or any app via "Entire screen" +
 * "Share system audio" (Windows/ChromeOS). The source keeps playing normally. Call from a user gesture.
 */
export async function openShare(): Promise<MediaStream> {
  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: true, // required by Chrome; dropped below
    audio: { ...RAW_AUDIO, suppressLocalAudioPlayback: false },
    systemAudio: 'include', selfBrowserSurface: 'exclude', surfaceSwitching: 'include', preferCurrentTab: false,
  } as DisplayMediaStreamOptions);
  const audio = stream.getAudioTracks();
  stream.getVideoTracks().forEach((t) => t.stop());
  if (!audio.length) throw new Error('no audio was shared: pick a tab with "Share tab audio" on, or Entire screen with "Share system audio"');
  return new MediaStream(audio);
}

export class LiveAnalyzer {
  readonly stream: MediaStream;
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

  /** `ended`: the user pressed "Stop sharing" in Chrome's bar, or the device went away. */
  constructor(stream: MediaStream, ended: () => void) {
    this.stream = stream;
    const ac = this.ac;
    this.an = new Analyzer(ac.sampleRate);
    this.analyser = ac.createAnalyser(); this.analyser.fftSize = N;
    const src = ac.createMediaStreamSource(stream);
    src.connect(this.analyser); // analysis only: not routed to the speakers
    // stereo taps for the scope; a mono source feeds the same signal to both (splitter upmixes)
    const split = ac.createChannelSplitter(2);
    this.wl = ac.createAnalyser(); this.wr = ac.createAnalyser();
    this.wl.fftSize = this.wr.fftSize = 2048;
    src.connect(split); split.connect(this.wl, 0); split.connect(this.wr, 1);
    ac.resume().catch(() => {}); // Safari starts contexts suspended
    for (const t of stream.getAudioTracks()) t.onended = ended;
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

  close(): void { this.stream.getTracks().forEach((t) => t.stop()); this.ac.close(); }
}
