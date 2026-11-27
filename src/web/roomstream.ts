// The room stream: the live leader's shared tab / screen video, sent to every other host over WebRTC
// (one peer connection and one encode per receiver; fine for 2-4 hosts) and shown there as its
// media exactly like a local share (MEDIA.share). Signaling rides the room WebSocket ({t: 'rtc'},
// room-token auth as everything else); no STUN / TURN: host candidates only (localhost / LAN /
// tailnet), plus each peer's address as the server saw it standing in for mDNS-hidden ones. The
// receiver holds the picture to the room's live delay (jitterBufferTarget) and measures how late it
// really is. Never hashed. The browser parts are injected, so the state machine runs in Node tests.
import type { RtcSignal } from '../core/protocol.ts';

export type Quality = '720p30' | '1080p30';
/** Sent-resolution caps (the track is constrained to them) and bitrate ceilings. */
export const QUALITY: Record<Quality, { w: number; h: number; fps: number; kbps: number }> = {
  '720p30': { w: 1280, h: 720, fps: 30, kbps: 2500 },
  '1080p30': { w: 1920, h: 1080, fps: 30, kbps: 5000 },
};
/** Most receivers the leader encodes for at once (one encode each). */
export const MAX_PEERS = 8;
/** A receiver not connected this long after asking gives up (and shows it), then asks again after RETRY_MS. */
export const CONNECT_MS = 10_000, RETRY_MS = 15_000;
/** Hold controller: ignore errors under DEADBAND ms, move by GAIN of the error, never hold more than MAX. */
export const HOLD_DEADBAND = 6, HOLD_GAIN = 0.6, HOLD_MAX = 1000;
/** NTP epoch (1900) to Unix epoch, ms. */
const NTP_UNIX_MS = 2_208_988_800_000;
const RTC_CONFIG: RTCConfiguration = { iceServers: [], bundlePolicy: 'max-bundle' };

export type IceInit = Extract<RtcSignal, { k: 'ice' }>['c'];

/**
 * `cand` with its mDNS host name (`<uuid>.local`, Chrome hides local IPs behind one when the page has
 * no media permission) replaced by `addr`, the IP the server sees the peer at; null if it has none.
 * Across a tailnet or without multicast the name never resolves, the address may.
 */
export function aliasCandidate(cand: string, addr: string | null | undefined): string | null {
  if (!addr) return null;
  const f = cand.split(' ');
  if (f.length < 8 || !/\.local$/i.test(f[4])) return null;
  f[4] = addr;
  return f.join(' ');
}

const ABS_CAPTURE = 'http://www.webrtc.org/experiments/rtp-hdrext/abs-capture-time';
/**
 * `sdp` with the abs-capture-time RTP header extension offered on its video section: every frame
 * then carries the leader's own capture time (NTP), which the receiver reads from
 * getSynchronizationSources() and puts on the room clock.
 */
export function withAbsCaptureTime(sdp: string): string {
  if (sdp.includes(ABS_CAPTURE)) return sdp;
  const used = new Set([...sdp.matchAll(/^a=extmap:(\d+)/gm)].map((m) => +m[1]));
  let id = 1; while (used.has(id)) id++;
  return id > 14 ? sdp : eachVideoSection(sdp, (sec) => {
    // after the section's last extmap, else after its mid
    let at = sec.map((l) => l.startsWith('a=extmap:')).lastIndexOf(true);
    if (at < 0) at = sec.findIndex((l) => l.startsWith('a=mid:'));
    if (at >= 0) sec.splice(at + 1, 0, `a=extmap:${id} ${ABS_CAPTURE}`);
  });
}

/** Video codecs with a start bitrate: the bandwidth estimate starts there, not at 300 kbps (a LAN has plenty). */
export function withStartBitrate(sdp: string, kbps: number): string {
  const par = `x-google-start-bitrate=${Math.round(kbps)}`;
  return eachVideoSection(sdp, (sec) => {
    for (let i = 0; i < sec.length; i++) {
      const m = /^a=rtpmap:(\d+) (H264|VP8|VP9|AV1)\//i.exec(sec[i]);
      if (!m) continue;
      const f = sec.findIndex((l) => l.startsWith(`a=fmtp:${m[1]} `));
      if (f < 0) sec.splice(i + 1, 0, `a=fmtp:${m[1]} ${par}`);
      else if (!sec[f].includes('x-google-start-bitrate')) sec[f] += `;${par}`;
    }
  });
}

/** Run `edit` on the lines of each m=video section of `sdp` (in place), keeping its line endings. */
function eachVideoSection(sdp: string, edit: (lines: string[]) => void): string {
  const nl = sdp.includes('\r\n') ? '\r\n' : '\n', out: string[] = [];
  const parts = sdp.split(new RegExp(`${nl}(?=m=)`));
  for (const p of parts) {
    const lines = p.split(nl);
    if (lines[0].startsWith('m=video')) edit(lines);
    out.push(lines.join(nl));
  }
  return out.join(nl);
}

/** Next jitterBufferTarget (ms): move the playout delay so the picture's latency reaches `want`. */
export function nextHold(cur: number, jb: number, latency: number, want: number): number {
  const err = want - latency;
  if (Math.abs(err) < HOLD_DEADBAND) return cur;
  // the buffer holds at least what it adapts to by itself, whatever the target says
  return Math.max(0, Math.min(HOLD_MAX, Math.round(Math.max(cur, jb) + err * HOLD_GAIN)));
}

/** A peer connection plus its ICE candidates that arrived before the remote description. */
class Link {
  private remote = false;
  private queue: RTCIceCandidateInit[] = [];
  readonly pc: RTCPeerConnection;
  constructor(pc: RTCPeerConnection) { this.pc = pc; }
  ice(c: IceInit, addr: string | null | undefined): void {
    if (!c?.candidate) return; // end of candidates: nothing to do
    const alias = aliasCandidate(c.candidate, addr);
    const list: RTCIceCandidateInit[] = [c, ...(alias ? [{ ...c, candidate: alias }] : [])];
    if (this.remote) for (const x of list) this.pc.addIceCandidate(x).catch(() => {});
    else this.queue.push(...list);
  }
  async remoteSet(d: RTCSessionDescriptionInit): Promise<void> {
    await this.pc.setRemoteDescription(d);
    this.remote = true;
    for (const x of this.queue.splice(0)) this.pc.addIceCandidate(x).catch(() => {});
  }
  close(): void { this.pc.onicecandidate = null; this.pc.ontrack = null; this.pc.onconnectionstatechange = null; this.pc.close(); }
}

const iceOf = (e: RTCPeerConnectionIceEvent): IceInit => (e.candidate ? { candidate: e.candidate.candidate, sdpMid: e.candidate.sdpMid, sdpMLineIndex: e.candidate.sdpMLineIndex } : null);

// ------------------------------------------------------------------ stats

type Rep = Record<string, unknown> & { type: string; id: string };
const num = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? x : 0);
function reports(s: RTCStatsReport): Rep[] { const out: Rep[] = []; s.forEach((r) => out.push(r as Rep)); return out; }
/** The selected candidate pair: rtt (ms) and how it connected ("host 192.168.1.5 → host 100.101.2.3"). */
function pairOf(all: Rep[]): { rtt: number | null; path: string } {
  const byId = new Map(all.map((r) => [r.id, r]));
  const t = all.find((r) => r.type === 'transport' && r.selectedCandidatePairId);
  const p = (t && byId.get(t.selectedCandidatePairId as string)) ?? all.find((r) => r.type === 'candidate-pair' && (r.selected || (r.nominated && r.state === 'succeeded')));
  if (!p) return { rtt: null, path: '' };
  const c = (id: unknown) => { const x = byId.get(id as string); return x ? `${x.candidateType} ${x.address ?? x.ip ?? '?'}` : '?'; };
  return { rtt: typeof p.currentRoundTripTime === 'number' ? p.currentRoundTripTime * 1000 : null, path: `${c(p.localCandidateId)} → ${c(p.remoteCandidateId)}` };
}
const codecOf = (all: Rep[], r: Rep | undefined) => String(all.find((x) => x.id === r?.codecId)?.mimeType ?? '').replace(/^video\//, '');

/** Per-interval rates from two cumulative counters. */
class Delta {
  private last = new Map<string, number>();
  d(key: string, v: number): number { const p = this.last.get(key); this.last.set(key, v); return p === undefined ? 0 : v - p; }
}

export interface SendStats {
  host: number; state: string; codec: string; impl: string; w: number; h: number; fps: number; kbps: number;
  /** Encode time per frame (ms), over the last interval. */
  encodeMs: number; limit: string; rtt: number | null; path: string;
}

export interface RecvStats {
  state: string; codec: string; impl: string; w: number; h: number; fps: number; kbps: number;
  /** Decode time per frame (ms) and the jitter buffer's average hold (ms), over the last interval. */
  decodeMs: number; jitterMs: number; dropped: number; rtt: number | null; path: string;
  /**
   * End-to-end latency (ms, captured on the leader → here): `latFrame` to the display, from the frame
   * callbacks (Chrome's own estimate of the leader's clock); `latRoom` to the track, from the frame's
   * abs-capture-time stamp on the room clock (both hosts know their wall-clock offset to it).
   */
  latFrame: number | null; latRoom: number | null;
  /** jitterBufferTarget now (ms), null where the browser has none; `want`: the room's live delay (ms). */
  hold: number | null; want: number;
}

// ------------------------------------------------------------------ sender (the leader)

export interface SenderOpts {
  signal(to: number, d: RtcSignal): void;
  quality(): Quality;
  /** Date.now() - room time (ms): receivers place RTCP NTP times on the room clock with it. */
  wall(): number;
  makePc?: () => RTCPeerConnection;
}

interface OutPeer { link: Link; sender: RTCRtpSender | null; state: string }

/** The leader's side: one peer connection per host that asked (`want`), all fed from one clone of the shared track. */
export class StreamSender {
  readonly peers = new Map<number, OutPeer>();
  readonly track: MediaStreamTrack;
  private o: SenderOpts;
  private delta = new Delta();
  constructor(source: MediaStreamTrack, o: SenderOpts) {
    this.o = o;
    // a clone, constrained on its own: the leader's own picture keeps the full capture
    this.track = source.clone();
    try { this.track.contentHint = 'motion'; } catch { /* old browsers */ }
    this.constrain();
  }

  private constrain(): void {
    const q = QUALITY[this.o.quality()];
    this.track.applyConstraints?.({ width: { max: q.w }, height: { max: q.h }, frameRate: { max: q.fps } })?.catch(() => {});
  }

  /** The cap changed: re-constrain the track, re-apply every encoding. */
  setQuality(): void { this.constrain(); for (const p of this.peers.values()) this.encode(p); }

  /** Bitrate / frame-rate ceilings, and a downscale should the capture still be larger than the cap. */
  private encode(p: OutPeer): void {
    const s = p.sender; if (!s) return;
    const q = QUALITY[this.o.quality()], st = this.track.getSettings?.() ?? {};
    const k = Math.max(1, (st.width ?? 0) / q.w, (st.height ?? 0) / q.h);
    const par = s.getParameters();
    if (!par.encodings?.length) return;
    for (const e of par.encodings) { e.maxBitrate = q.kbps * 1000; e.maxFramerate = q.fps; e.scaleResolutionDownBy = Math.round(k * 100) / 100; }
    s.setParameters(par).catch(() => {});
  }

  onSignal(from: number, d: RtcSignal, addr?: string): void {
    if (d.k === 'want') { this.offer(from); return; }
    const p = this.peers.get(from);
    if (!p) return;
    if (d.k === 'bye') this.drop(from);
    else if (d.k === 'answer') p.link.remoteSet({ type: 'answer', sdp: withStartBitrate(d.sdp, QUALITY[this.o.quality()].kbps * 0.6) }).then(() => this.encode(p)).catch(() => { p.state = 'failed'; });
    else if (d.k === 'ice') p.link.ice(d.c, addr);
  }

  private offer(to: number): void {
    this.drop(to);
    if (this.peers.size >= MAX_PEERS) return;
    const pc = (this.o.makePc ?? (() => new RTCPeerConnection(RTC_CONFIG)))();
    const q = QUALITY[this.o.quality()];
    const tr = pc.addTransceiver(this.track, { direction: 'sendonly', sendEncodings: [{ maxBitrate: q.kbps * 1000, maxFramerate: q.fps }] });
    preferCodec(tr);
    const p: OutPeer = { link: new Link(pc), sender: tr.sender, state: 'offering' };
    this.peers.set(to, p);
    pc.onicecandidate = (e) => this.o.signal(to, { k: 'ice', c: iceOf(e) });
    pc.onconnectionstatechange = () => { if (this.peers.get(to) === p) p.state = pc.connectionState; };
    pc.createOffer()
      .then((o) => pc.setLocalDescription({ type: 'offer', sdp: withAbsCaptureTime(o.sdp ?? '') }).catch(() => pc.setLocalDescription(o)))
      .then(() => { if (this.peers.get(to) === p) this.o.signal(to, { k: 'offer', sdp: pc.localDescription!.sdp, wall: this.o.wall() }); })
      .catch(() => { p.state = 'failed'; });
  }

  drop(id: number): void { const p = this.peers.get(id); if (p) { p.link.close(); this.peers.delete(id); } }
  /** Close the peers of hosts that left the room. */
  prune(hosts: Iterable<number>): void { const keep = new Set(hosts); for (const id of [...this.peers.keys()]) if (!keep.has(id)) this.drop(id); }
  close(): void { for (const id of [...this.peers.keys()]) this.drop(id); this.track.stop(); }

  async stats(): Promise<SendStats[]> {
    const out: SendStats[] = [];
    for (const [host, p] of this.peers) {
      const all = reports(await p.link.pc.getStats().catch(() => new Map() as unknown as RTCStatsReport));
      const r = all.find((x) => x.type === 'outbound-rtp' && x.kind !== 'audio');
      const frames = this.delta.d(`${host}f`, num(r?.framesEncoded)), enc = this.delta.d(`${host}e`, num(r?.totalEncodeTime)), bytes = this.delta.d(`${host}b`, num(r?.bytesSent));
      const t = this.delta.d(`${host}t`, num(r?.timestamp));
      const { rtt, path } = pairOf(all);
      out.push({
        host, state: p.state, codec: codecOf(all, r), impl: String(r?.encoderImplementation ?? ''), w: num(r?.frameWidth), h: num(r?.frameHeight),
        fps: num(r?.framesPerSecond), kbps: t > 0 ? (bytes * 8) / t : 0, encodeMs: frames > 0 ? (enc * 1000) / frames : 0,
        limit: String(r?.qualityLimitationReason ?? ''), rtt, path,
      });
    }
    return out;
  }
}

/** H.264 first where the browser has it: hardware encoders (Windows, macOS, iOS) cost the leader the least. */
function preferCodec(tr: RTCRtpTransceiver): void {
  const caps = globalThis.RTCRtpSender?.getCapabilities?.('video')?.codecs;
  if (!caps || !tr.setCodecPreferences) return;
  const h264 = caps.filter((c) => /h264/i.test(c.mimeType)), rest = caps.filter((c) => !/h264/i.test(c.mimeType));
  if (h264.length) try { tr.setCodecPreferences([...h264, ...rest]); } catch { /* keep the default order */ }
}

/** One status line for the leader (HostInfo.rtc, the hosts panel). */
export function sendLine(q: Quality, s: SendStats[]): string {
  if (!s.length) return `sharing ${q}, no receivers`;
  const ok = s.filter((x) => x.state === 'connected'), ms = ok.length ? ok.reduce((a, x) => a + x.encodeMs, 0) / ok.length : 0;
  return `sending ${q} to ${ok.length}/${s.length}${ok.length ? `, encode ${ms.toFixed(1)} ms` : ''}`;
}

/** Share of one CPU core the encodes take (encode ms per frame x fps, summed over the peers). */
export const encodeLoad = (s: SendStats[]): number => s.reduce((a, x) => a + (x.encodeMs * x.fps) / 1000, 0);

// ------------------------------------------------------------------ receiver (every other host)

export type RecvState = 'off' | 'asking' | 'connecting' | 'connected' | 'failed';

/** Frame-callback metadata (requestVideoFrameCallback; WebRTC frames carry the capture time). */
export interface FrameMeta { expectedDisplayTime: number; captureTime?: number; receiveTime?: number }

export interface Shown {
  release(): void;
  /** The element it plays in: its frame callbacks give the latency per frame. */
  video?: HTMLVideoElement;
}

export interface ReceiverOpts {
  signal(to: number, d: RtcSignal): void;
  /** Show a received track as this host's media; returns its release. */
  show(track: MediaStreamTrack): Shown;
  /** The room clock (ms): reads RTCP NTP times. */
  roomNow(): number;
  /** Date.now() - room time on this host (ms). */
  wall(): number;
  makePc?: () => RTCPeerConnection;
  /** Clock for the timeouts (ms; default performance.now). */
  now?: () => number;
}

export class StreamReceiver {
  state: RecvState = 'off';
  /** The host streaming to this one (null: none / opted out). */
  from: number | null = null;
  /** Times it failed to connect (the panel shows it). */
  failures = 0;
  private since = 0;
  private link: Link | null = null;
  private rx: RTCRtpReceiver | null = null;
  private shown: Shown | null = null;
  private senderWall: number | null = null;
  private o: ReceiverOpts;
  private delta = new Delta();
  /** Smoothed per-frame latency (ms) and when it was last sampled (performance.now). */
  private latF: number | null = null;
  private latAt = 0;
  private hold: number | null = null;
  private now: () => number;
  constructor(o: ReceiverOpts) { this.o = o; this.now = o.now ?? (() => performance.now()); }

  /** Receive from `host` (the room's sharing host; null = none, or this host opted out / leads). */
  update(host: number | null): void {
    if (host === this.from) return;
    this.close();
    this.from = host;
    if (host !== null) this.ask();
  }

  /** Timeouts and retries; call a couple of times a second. */
  tick(): void {
    const now = this.now();
    if ((this.state === 'asking' || this.state === 'connecting') && now - this.since > CONNECT_MS) this.fail();
    else if (this.state === 'failed' && now - this.since > RETRY_MS) this.ask();
  }

  private ask(): void {
    this.state = 'asking'; this.since = this.now();
    this.o.signal(this.from!, { k: 'want' });
  }

  private fail(): void {
    this.teardown(true);
    this.state = 'failed'; this.since = this.now(); this.failures++;
  }

  onSignal(from: number, d: RtcSignal, addr?: string): void {
    if (from !== this.from || this.state === 'off') return;
    if (d.k === 'offer') this.answer(from, d.sdp, d.wall);
    else if (d.k === 'ice') this.link?.ice(d.c, addr);
    else if (d.k === 'bye') this.fail();
  }

  private answer(from: number, sdp: string, wall: number | undefined): void {
    this.teardown(false);
    const pc = (this.o.makePc ?? (() => new RTCPeerConnection(RTC_CONFIG)))(), link = (this.link = new Link(pc));
    this.state = 'connecting'; this.since = this.now(); this.senderWall = typeof wall === 'number' ? wall : null;
    pc.onicecandidate = (e) => this.o.signal(from, { k: 'ice', c: iceOf(e) });
    pc.ontrack = (e) => {
      if (this.link !== link || e.track.kind !== 'video') return;
      this.shown?.release();
      this.rx = e.receiver;
      this.shown = this.o.show(e.track);
      this.probe(this.shown.video, link);
    };
    pc.onconnectionstatechange = () => {
      if (this.link !== link) return;
      if (pc.connectionState === 'connected') this.state = 'connected';
      else if (pc.connectionState === 'failed') this.fail();
    };
    link.remoteSet({ type: 'offer', sdp })
      .then(() => pc.createAnswer())
      .then((a) => pc.setLocalDescription(a))
      .then(() => { if (this.link === link) this.o.signal(from, { k: 'answer', sdp: pc.localDescription!.sdp }); })
      .catch(() => { if (this.link === link) this.fail(); });
  }

  /** Per-frame latency from the frame callbacks: shown at expectedDisplayTime, captured at captureTime. */
  private probe(v: HTMLVideoElement | undefined, link: Link): void {
    if (!v || typeof v.requestVideoFrameCallback !== 'function') return;
    const cb = (_: number, m: FrameMeta) => {
      if (this.link !== link) return;
      if (typeof m.captureTime === 'number' && m.captureTime > 0) this.sample(m.expectedDisplayTime - m.captureTime, m.expectedDisplayTime);
      v.requestVideoFrameCallback(cb as VideoFrameRequestCallback);
    };
    v.requestVideoFrameCallback(cb as VideoFrameRequestCallback);
  }
  /** One latency sample (tests feed these directly). */
  sample(ms: number, at: number): void {
    if (!(ms > -1000 && ms < 10_000)) return;
    this.latF = this.latF === null ? ms : this.latF + 0.1 * (ms - this.latF); this.latAt = at;
  }

  private teardown(bye: boolean): void {
    if (bye && this.from !== null && this.state !== 'off') this.o.signal(this.from, { k: 'bye' });
    this.link?.close(); this.link = null; this.rx = null;
    this.shown?.release(); this.shown = null;
    this.latF = null; this.hold = null;
  }

  /**
   * The newest frame's latency on the room clock: its abs-capture-time (the leader's NTP clock, so
   * its Date.now()) less the leader's wall offset, against when it reached the track here.
   */
  private roomLatency(): number | null {
    const src = this.rx?.getSynchronizationSources?.()[0] as (RTCRtpSynchronizationSource & { captureTimestamp?: number }) | undefined;
    if (!src?.captureTimestamp || this.senderWall === null) return null;
    const captured = src.captureTimestamp - NTP_UNIX_MS - this.senderWall;
    // `timestamp` is on this page's time origin
    const reached = src.timestamp - performance.timeOrigin + (this.o.roomNow() - performance.now());
    const ms = reached - captured;
    return ms > -1000 && ms < 10_000 ? ms : null;
  }

  /** Stop receiving (tells the sender, takes the picture off). */
  close(): void { this.teardown(true); this.state = 'off'; this.from = null; }

  /** Status for the hosts panel (HostInfo.rtc). */
  line(s?: RecvStats | null): string | null {
    if (this.state === 'off') return null;
    if (this.state === 'connected') { const l = s?.latFrame ?? s?.latRoom; return `stream connected${l != null ? ` ${Math.round(l / 10) * 10} ms` : ''}`; }
    if (this.state === 'failed') return `stream failed (${this.failures}x), retrying`;
    return `stream ${this.state}`;
  }

  /**
   * Stats over the last interval, and the hold: the jitter buffer target moves the picture's latency
   * to `wantMs` (the room's live delay). Call about once a second.
   */
  async stats(wantMs: number, perfNow: number): Promise<RecvStats | null> {
    const link = this.link;
    if (!link) return null;
    const all = reports(await link.pc.getStats().catch(() => new Map() as unknown as RTCStatsReport));
    if (this.link !== link) return null;
    const r = all.find((x) => x.type === 'inbound-rtp' && x.kind !== 'audio');
    const frames = this.delta.d('f', num(r?.framesDecoded)), dec = this.delta.d('d', num(r?.totalDecodeTime));
    const em = this.delta.d('e', num(r?.jitterBufferEmittedCount)), jb = this.delta.d('j', num(r?.jitterBufferDelay));
    const bytes = this.delta.d('b', num(r?.bytesReceived)), t = this.delta.d('t', num(r?.timestamp));
    const { rtt, path } = pairOf(all);
    const latRoom = this.roomLatency();
    const latFrame = this.latF !== null && perfNow - this.latAt < 2000 ? this.latF : null;
    const jitterMs = em > 0 ? (jb * 1000) / em : 0;
    const lat = latFrame ?? latRoom;
    const rx = this.rx as (RTCRtpReceiver & { jitterBufferTarget?: number | null }) | null;
    const can = !!rx && 'jitterBufferTarget' in rx;
    if (can && lat !== null && this.state === 'connected') {
      const next = nextHold(this.hold ?? 0, jitterMs, lat, wantMs);
      if (next !== (this.hold ?? 0)) { try { rx.jitterBufferTarget = next; } catch { /* out of range */ } }
      this.hold = next;
    }
    return {
      state: this.state, codec: codecOf(all, r), impl: String(r?.decoderImplementation ?? ''), w: num(r?.frameWidth), h: num(r?.frameHeight),
      fps: num(r?.framesPerSecond), kbps: t > 0 ? (bytes * 8) / t : 0, decodeMs: frames > 0 ? (dec * 1000) / frames : 0, jitterMs,
      dropped: num(r?.framesDropped), rtt, path, latFrame, latRoom, hold: can ? (this.hold ?? 0) : null, want: wantMs,
    };
  }
}

/** Debug panel lines for a receiver. */
export function recvLines(s: RecvStats): string[] {
  const ms = (x: number | null) => (x === null ? '-' : `${x.toFixed(0)} ms`);
  return [
    `latency ${ms(s.latFrame)} capture → display (frame callbacks)  ${ms(s.latRoom)} capture → track (room clock)  want ${s.want.toFixed(0)} ms  hold ${s.hold === null ? 'n/a (no jitterBufferTarget)' : `${s.hold} ms`}  jitter buffer ${s.jitterMs.toFixed(0)} ms`,
    `${s.codec || '?'}${s.impl ? ` (${s.impl})` : ''} ${s.w}x${s.h} ${s.fps.toFixed(0)} fps ${(s.kbps / 1000).toFixed(2)} Mbps  decode ${s.decodeMs.toFixed(2)} ms/frame  dropped ${s.dropped}`,
    `path ${s.path || '?'}  rtt ${s.rtt === null ? '-' : `${s.rtt.toFixed(1)} ms`}`,
  ];
}

/** Debug panel lines for the leader; `names` maps host ids. */
export function sendLines(q: Quality, s: SendStats[], name: (id: number) => string, pressure: string | null): string[] {
  const load = encodeLoad(s);
  return [
    `sending ${q} (cap ${QUALITY[q].w}x${QUALITY[q].h} ${QUALITY[q].fps} fps ${QUALITY[q].kbps / 1000} Mbps) to ${s.length} host${s.length === 1 ? '' : 's'}  encode load ~${(load * 100).toFixed(0)}% of a core${pressure ? `  cpu pressure ${pressure}` : ''}`,
    ...s.map((x) => `→ ${name(x.host)}: ${x.state}  ${x.codec || '?'}${x.impl ? ` (${x.impl})` : ''} ${x.w}x${x.h} ${x.fps.toFixed(0)} fps ${(x.kbps / 1000).toFixed(2)} Mbps  encode ${x.encodeMs.toFixed(2)} ms/frame${x.limit && x.limit !== 'none' ? `  limited by ${x.limit}` : ''}  rtt ${x.rtt === null ? '-' : x.rtt.toFixed(1)}  ${x.path}`),
  ];
}
