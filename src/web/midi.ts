// Web MIDI relay: every input on this host is forwarded to the room. Notes and CCs go out as
// events (stamped by the server). Clock is counted here, and each beat (24 pulses) is reported
// with its server-time timestamp and tempo; the server picks the master and stamps the beats.
import type { ClientMsg } from '../core/protocol.ts';

export interface MidiStatus { inputs: string[]; bpm: number; beat: number; lastMsg: string; clockAge: number }

export class MidiRelay {
  readonly status: MidiStatus = { inputs: [], bpm: 0, beat: -1, lastMsg: '', clockAge: Infinity };
  private access: MIDIAccess | null = null;
  private pulses: number[] = [];
  private pulse = 0;
  private beat = 0;
  private lastPulse = -Infinity;
  /** Latest pending value per CC: knobs send far faster than one per tick. */
  private ccPending = new Map<number, number>();
  private send: (m: ClientMsg) => void;
  private toServer: (perfMs: number) => number;

  constructor(send: (m: ClientMsg) => void, toServer: (perfMs: number) => number) {
    this.send = send; this.toServer = toServer;
    setInterval(() => this.flushCcs(), 16);
  }

  get enabled(): boolean { return this.access !== null; }

  async enable(): Promise<void> {
    if (!navigator.requestMIDIAccess) throw new Error('Web MIDI not available in this browser (use Chrome)');
    this.access = await navigator.requestMIDIAccess({ sysex: false });
    this.access.onstatechange = () => this.bind();
    this.bind();
  }

  disable(): void {
    if (!this.access) return;
    for (const i of this.access.inputs.values()) i.onmidimessage = null;
    this.access.onstatechange = null; this.access = null;
    this.status.inputs = [];
  }

  private bind(): void {
    if (!this.access) return;
    this.status.inputs = [];
    for (const i of this.access.inputs.values()) {
      if (i.state !== 'connected') continue;
      i.onmidimessage = (e) => this.onMessage(e);
      this.status.inputs.push(i.name ?? i.id);
    }
  }

  private onMessage(e: MIDIMessageEvent): void {
    const d = e.data; if (!d || !d.length) return;
    const st = d[0], kind = st & 0xf0;
    if (st === 0xf8) return this.onPulse(e.timeStamp);
    if (st === 0xfa || st === 0xfb || st === 0xfc) {
      const op = st === 0xfa ? 'start' : st === 0xfb ? 'continue' : 'stop';
      if (op === 'start') { this.pulse = 0; this.beat = 0; } // the next pulse is beat 0 = downbeat
      this.status.lastMsg = op;
      return this.send({ t: 'ev', type: 'transport', payload: { op } });
    }
    if (kind === 0x90 && d[2] > 0) {
      this.status.lastMsg = `note ${d[1]} v${d[2]} ch${(st & 15) + 1}`;
      return this.send({ t: 'ev', type: 'note', payload: { n: d[1], v: d[2] } });
    }
    if (kind === 0xb0) { this.ccPending.set(d[1], d[2]); this.status.lastMsg = `cc ${d[1]} = ${d[2]} ch${(st & 15) + 1}`; }
  }

  private flushCcs(): void {
    for (const [c, v] of this.ccPending) this.send({ t: 'ev', type: 'cc', payload: { c, v } });
    this.ccPending.clear();
    this.status.clockAge = performance.now() - this.lastPulse;
    if (this.status.clockAge > 2000) { this.status.bpm = 0; this.pulses.length = 0; }
  }

  /** 24 pulses per quarter note. Tempo from the last 2 beats of pulses, beat time = its first pulse. */
  private onPulse(ts: number): void {
    if (ts - this.lastPulse > 2000) { this.pulses.length = 0; this.pulse = 0; } // clock resumed after a gap
    this.lastPulse = ts;
    this.pulses.push(ts); if (this.pulses.length > 49) this.pulses.shift();
    const isBeat = this.pulse % 24 === 0;
    if (isBeat) {
      if (this.pulse > 0) this.beat++;
      if (this.pulses.length >= 13) {
        const n = this.pulses.length - 1, bpm = 60000 / (((this.pulses[n] - this.pulses[0]) / n) * 24);
        this.status.bpm = Math.round(bpm * 100) / 100; this.status.beat = this.beat;
        this.send({ t: 'clock', at: this.toServer(ts), bpm: this.status.bpm, n: this.beat });
      }
    }
    this.pulse++;
  }
}
