import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CONNECT_MS, HOLD_MAX, QUALITY, RETRY_MS, StreamReceiver, StreamSender, aliasCandidate, nextHold, sendLine, withAbsCaptureTime, withStartBitrate,
} from '../src/web/roomstream.ts';
import { Room } from '../src/server/room.ts';
import type { WsConn } from '../src/server/ws.ts';
import type { RoomState, RtcSignal, ServerMsg } from '../src/core/protocol.ts';

const flush = () => new Promise((r) => setImmediate(r));
const OFFER_SDP = ['v=0', 'm=video 9 UDP/TLS/RTP/SAVPF 96', 'a=mid:0', 'a=extmap:1 urn:x', 'a=rtpmap:96 H264/90000', 'a=fmtp:96 packetization-mode=1', ''].join('\r\n');

/** A fake RTCPeerConnection: records what it was told, lets the test fire its events. */
class FakePc {
  static made: FakePc[] = [];
  onicecandidate: ((e: unknown) => void) | null = null;
  ontrack: ((e: unknown) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  connectionState = 'new';
  localDescription: { type: string; sdp: string } | null = null;
  remote: { type: string; sdp: string } | null = null;
  added: { candidate: string }[] = [];
  closed = false;
  params = { encodings: [{}] as Record<string, number>[] };
  sender = { getParameters: () => structuredClone(this.params), setParameters: (p: typeof this.params) => { this.params = p; return Promise.resolve(); } };
  receiver = { jitterBufferTarget: null as number | null, getSynchronizationSources: () => [] };
  constructor() { FakePc.made.push(this); }
  addTransceiver(_t: unknown, init: { sendEncodings: Record<string, number>[] }) { this.params = { encodings: init.sendEncodings.map((e) => ({ ...e })) }; return { sender: this.sender, setCodecPreferences: () => {} }; }
  async createOffer() { return { type: 'offer', sdp: OFFER_SDP }; }
  async createAnswer() { return { type: 'answer', sdp: 'v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\na=rtpmap:96 H264/90000\r\n' }; }
  async setLocalDescription(d: { type: string; sdp: string }) { this.localDescription = d; }
  async setRemoteDescription(d: { type: string; sdp: string }) { this.remote = d; }
  async addIceCandidate(c: { candidate: string }) { if (!this.remote) throw new Error('no remote description'); this.added.push(c); }
  async getStats() { return new Map(); }
  close() { this.closed = true; this.connectionState = 'closed'; }
  ice(candidate: string) { this.onicecandidate?.({ candidate: { candidate, sdpMid: '0', sdpMLineIndex: 0 } }); }
  state(s: string) { this.connectionState = s; this.onconnectionstatechange?.(); }
  track() { const t = { kind: 'video' }; this.ontrack?.({ track: t, receiver: this.receiver }); return t; }
}
const makePc = () => new FakePc() as unknown as RTCPeerConnection;

function fakeTrack() {
  const t = { stopped: 0, constraints: [] as unknown[], contentHint: '', clone: () => clone, stop: () => { t.stopped++; }, getSettings: () => ({ width: 1280, height: 720 }) };
  const clone = { ...t, stopped: 0, constraints: [] as unknown[], applyConstraints: (c: unknown) => { clone.constraints.push(c); return Promise.resolve(); }, stop: () => { clone.stopped++; } };
  return { t, clone };
}

/**
 * A leader (host 1) and receivers on an in-memory signaling bus (the server relay), delivered on demand.
 * `addr` stands in for the address the server sees each host at.
 */
function room(n = 1) {
  FakePc.made = [];
  const queue: { from: number; to: number; d: RtcSignal }[] = [];
  const clock = { ms: 1000 };
  const { t, clone } = fakeTrack();
  const sender = new StreamSender(t as unknown as MediaStreamTrack, { signal: (to, d) => queue.push({ from: 1, to, d }), quality: () => '720p30', wall: () => 5000, makePc });
  const shown: { track: unknown; released: number }[] = [];
  const rx = Array.from({ length: n }, (_, i) => new StreamReceiver({
    signal: (to, d) => queue.push({ from: i + 2, to, d }),
    show: (track) => { const s = { track, released: 0 }; shown.push(s); return { release: () => { s.released++; } }; },
    roomNow: () => clock.ms, wall: () => 0, makePc, now: () => clock.ms,
  }));
  const deliver = async () => {
    for (let k = 0; k < 20 && queue.length; k++) {
      for (const m of queue.splice(0)) {
        if (m.to === 1) sender.onSignal(m.from, m.d, `10.0.0.${m.from}`);
        else rx[m.to - 2]?.onSignal(m.from, m.d, '10.0.0.1');
      }
      await flush();
    }
  };
  return { sender, rx, queue, deliver, clock, shown, clone };
}

test('signaling: want → offer → answer; trickled ICE waits for the remote description; connected shows the track', async () => {
  const { sender, rx: [r], queue, deliver, shown, clone } = room();
  r.update(1);
  assert.deepEqual([r.state, queue.map((m) => m.d.k)], ['asking', ['want']]);
  await deliver();
  const [out, inn] = FakePc.made;
  assert.equal(sender.peers.size, 1);
  assert.match(out.localDescription!.sdp, /a=extmap:2 http:\/\/www\.webrtc\.org\/experiments\/rtp-hdrext\/abs-capture-time/, 'offers the capture-time stamp');
  assert.match(out.remote!.sdp, /x-google-start-bitrate=1500/, 'the answer gets a start bitrate');
  assert.equal(inn.localDescription!.type, 'answer');
  assert.equal(r.state, 'connecting');
  // the clone is capped to 720p30; the encodings to the bitrate
  assert.deepEqual(clone.constraints[0], { width: { max: 1280 }, height: { max: 720 }, frameRate: { max: 30 } });
  assert.equal(out.params.encodings[0].maxBitrate, QUALITY['720p30'].kbps * 1000);
  assert.equal(out.params.encodings[0].scaleResolutionDownBy, 1);

  // candidates both ways; an mDNS one also goes in under the address the server saw
  out.ice('candidate:1 1 udp 2122260223 abcd-1234.local 50000 typ host generation 0');
  inn.ice('candidate:2 1 udp 2122260223 192.168.1.9 50001 typ host generation 0');
  await deliver();
  assert.deepEqual(inn.added.map((c) => c.candidate.split(' ')[4]), ['abcd-1234.local', '10.0.0.1']);
  assert.deepEqual(out.added.map((c) => c.candidate.split(' ')[4]), ['192.168.1.9']);

  inn.state('connected');
  const track = inn.track();
  assert.deepEqual([r.state, shown.length, shown[0].track], ['connected', 1, track]);
  assert.match(r.line()!, /^stream connected/);
  assert.equal(sendLine('720p30', [{ host: 2, state: 'connected', codec: 'H264', impl: '', w: 1280, h: 720, fps: 30, kbps: 2000, encodeMs: 3.14, limit: '', rtt: 1, path: '' }]), 'sending 720p30 to 1/1, encode 3.1 ms');
});

test('ICE that arrives before the offer is queued until it is set', async () => {
  const { rx: [r], deliver } = room();
  r.update(1);
  await deliver();
  const inn = FakePc.made[1];
  // a second offer (the leader restarted the peer) with a candidate racing ahead of it
  r.onSignal(1, { k: 'offer', sdp: OFFER_SDP, wall: 0 });
  const again = FakePc.made[2];
  r.onSignal(1, { k: 'ice', c: { candidate: 'candidate:3 1 udp 1 10.1.1.1 5 typ host', sdpMid: '0', sdpMLineIndex: 0 } });
  assert.equal(again.added.length, 0);
  await flush(); await flush();
  assert.deepEqual([inn.closed, again.added.length], [true, 1]);
});

test('no answer in time: failed (shown, the sender is told), then asks again', async () => {
  const { sender, rx: [r], queue, clock } = room();
  r.update(1);
  queue.length = 0; // the leader never hears it
  clock.ms += CONNECT_MS - 1; r.tick();
  assert.equal(r.state, 'asking');
  clock.ms += 2; r.tick();
  assert.deepEqual([r.state, r.failures, queue.map((m) => m.d.k)], ['failed', 1, ['bye']]);
  assert.match(r.line()!, /failed \(1x\)/);
  queue.length = 0;
  clock.ms += RETRY_MS + 1; r.tick();
  assert.deepEqual([r.state, queue.map((m) => m.d.k)], ['asking', ['want']]);
  assert.equal(sender.peers.size, 0);
});

test('a peer connection that fails takes the picture off and drops the leader\'s peer', async () => {
  const { sender, rx: [r], deliver, shown } = room();
  r.update(1);
  await deliver();
  const inn = FakePc.made[1];
  inn.state('connected'); inn.track();
  inn.state('failed');
  assert.deepEqual([r.state, shown[0].released, inn.closed], ['failed', 1, true]);
  await deliver();
  assert.equal(sender.peers.size, 0, 'bye reached the leader');
  assert.equal(FakePc.made[0].closed, true);
});

test('the share ends, or the host opts out: the receiver closes cleanly; the leader prunes hosts that left', async () => {
  const { sender, rx, deliver, shown, clone } = room(2);
  rx.forEach((r) => r.update(1));
  await deliver();
  assert.equal(sender.peers.size, 2);
  for (const pc of FakePc.made.slice(1)) { if (pc.ontrack) { pc.state('connected'); pc.track(); } }
  rx[0].update(null); // opted out (or the room's share ended)
  await deliver();
  assert.deepEqual([rx[0].state, rx[0].line(), shown[0].released, sender.peers.size], ['off', null, 1, 1]);
  // an offer from a host it isn't receiving from is ignored
  rx[0].onSignal(1, { k: 'offer', sdp: OFFER_SDP });
  assert.equal(rx[0].state, 'off');
  sender.prune([1]); // host 3 left the room
  assert.equal(sender.peers.size, 0);
  sender.close();
  assert.equal(clone.stopped, 1, 'the sent clone stops; the leader\'s own track is bindStream\'s');
});

test('a quality change re-caps the track and every encoding', async () => {
  FakePc.made = [];
  let q: '720p30' | '1080p30' = '720p30';
  const { t, clone } = fakeTrack(), sent: RtcSignal[] = [];
  const s = new StreamSender(t as unknown as MediaStreamTrack, { signal: (_, d) => sent.push(d), quality: () => q, wall: () => 0, makePc });
  s.onSignal(2, { k: 'want' });
  await flush();
  q = '1080p30'; s.setQuality();
  assert.deepEqual(clone.constraints.at(-1), { width: { max: 1920 }, height: { max: 1080 }, frameRate: { max: 30 } });
  assert.equal(FakePc.made[0].params.encodings[0].maxBitrate, 5_000_000);
  assert.equal((sent[0] as { wall?: number }).wall, 0);
});

test('hold: the jitter buffer target walks the latency to the room\'s delay, within bounds', () => {
  assert.equal(nextHold(0, 30, 60, 100), 54, 'early: hold more (from what the buffer holds already)');
  assert.equal(nextHold(50, 30, 98, 100), 50, 'inside the deadband: leave it');
  assert.equal(nextHold(0, 30, 160, 100), 0, 'late without a hold: nothing to take away');
  assert.equal(nextHold(200, 200, 300, 100), 80);
  assert.equal(nextHold(900, 900, 0, 1000), HOLD_MAX);
  // converges on a plant where the latency is the fixed path plus the hold
  let hold = 0;
  for (let i = 0; i < 20; i++) hold = nextHold(hold, hold, 45 + hold, 100);
  assert.ok(Math.abs(45 + hold - 100) < 6, `converged: hold ${hold}`);
});

test('sdp helpers and the mDNS alias', () => {
  const sdp = ['v=0', 'm=audio 9 X 111', 'a=mid:a', 'a=extmap:1 urn:a', 'a=rtpmap:111 opus/48000', 'm=video 9 X 96 98', 'a=mid:v', 'a=extmap:3 urn:b', 'a=rtpmap:96 VP8/90000', 'a=rtpmap:98 H264/90000', 'a=fmtp:98 profile-level-id=42e01f', ''].join('\r\n');
  const abs = withAbsCaptureTime(sdp);
  assert.match(abs, /a=extmap:3 urn:b\r\na=extmap:2 http:\/\/www\.webrtc\.org\/experiments\/rtp-hdrext\/abs-capture-time\r\na=rtpmap:96/, 'video section, first free id');
  assert.equal(withAbsCaptureTime(abs), abs, 'once');
  const sb = withStartBitrate(sdp, 1500);
  assert.match(sb, /a=rtpmap:96 VP8\/90000\r\na=fmtp:96 x-google-start-bitrate=1500\r\n/);
  assert.match(sb, /a=fmtp:98 profile-level-id=42e01f;x-google-start-bitrate=1500/);
  assert.doesNotMatch(sb.split('m=video')[0], /start-bitrate/, 'audio untouched');
  assert.equal(aliasCandidate('candidate:1 1 udp 9 1b2c.local 5000 typ host', '100.64.0.7'), 'candidate:1 1 udp 9 100.64.0.7 5000 typ host');
  assert.equal(aliasCandidate('candidate:1 1 udp 9 192.168.0.2 5000 typ host', '100.64.0.7'), null);
  assert.equal(aliasCandidate('candidate:1 1 udp 9 1b2c.local 5000 typ host', null), null);
});

// ---- server side: the share flag and the relay

function server() {
  const r = new Room(() => 10_000);
  const join = (addr: string | null = null) => {
    const got: ServerMsg[] = [];
    const ws = { onmessage: (_: Buffer | string) => {}, onclose: () => {}, json: (m: unknown) => got.push(m as ServerMsg), send: (s: string | Buffer) => { if (typeof s === 'string') got.push(JSON.parse(s)); } };
    r.join(ws as unknown as WsConn, addr);
    const id = (got[0] as { you: number }).you, send = (m: unknown) => ws.onmessage(JSON.stringify(m));
    send({ t: 'hello', name: `h${id}` });
    return { got, ws, id, send, state: () => [...got].reverse().find((m) => m.t === 'state') as RoomState, rtc: () => got.filter((m) => m.t === 'rtc') };
  };
  return { r, join };
}

test('server: only the live leader shares; a new timeline or the leader leaving ends it', () => {
  const { join } = server();
  const a = join(), b = join();
  a.send({ t: 'share', on: true });
  assert.equal(b.state().share ?? null, null, 'not live: ignored');
  a.send({ t: 'live' }); a.send({ t: 'share', on: true });
  assert.equal(b.state().share, a.id);
  b.send({ t: 'share', on: true });
  assert.equal(b.state().share, a.id, 'not the leader: ignored');
  b.send({ t: 'live' });
  assert.equal(a.state().share ?? null, null, 'another host took over live');
  b.send({ t: 'share', on: true });
  assert.equal(a.state().share, b.id);
  b.ws.onclose();
  assert.equal(a.state().share, null);
});

test('server: signaling is relayed to its target with the sender\'s address; status lines reach the hosts list', () => {
  const { join } = server();
  const a = join('192.168.1.10'), b = join(null);
  b.send({ t: 'rtc', to: a.id, d: { k: 'want' } });
  assert.deepEqual(a.rtc(), [{ t: 'rtc', from: b.id, d: { k: 'want' } }]);
  a.send({ t: 'rtc', to: b.id, d: { k: 'offer', sdp: 'v=0', wall: 1 } });
  assert.deepEqual(b.rtc(), [{ t: 'rtc', from: a.id, addr: '192.168.1.10', d: { k: 'offer', sdp: 'v=0', wall: 1 } }]);
  a.send({ t: 'rtc', to: a.id, d: { k: 'want' } });
  a.send({ t: 'rtc', to: 99, d: { k: 'want' } });
  a.send({ t: 'rtc', to: b.id, d: { k: 'offer', sdp: 'x'.repeat(40_000) } });
  assert.equal(a.rtc().length + b.rtc().length, 2, 'not to itself, nobody, or oversized');
  b.send({ t: 'rtcstat', s: 'stream connected 100 ms' });
  assert.equal(a.state().hosts.find((h) => h.id === b.id)?.rtc, 'stream connected 100 ms');
  const n = a.got.length;
  b.send({ t: 'rtcstat', s: 'stream connected 100 ms' });
  assert.equal(a.got.length, n, 'unchanged: no rebroadcast');
});

test('server: the address relayed is the socket peer, or behind a local proxy the forwarded one', async () => {
  const { clientAddr } = await import('../src/server/auth.ts');
  const req = (remoteAddress: string, xff?: string) => ({ socket: { remoteAddress }, headers: xff ? { 'x-forwarded-for': xff } : {} });
  assert.equal(clientAddr(req('::ffff:192.168.1.4')), '192.168.1.4');
  assert.equal(clientAddr(req('127.0.0.1', '100.101.102.103, 127.0.0.1')), '100.101.102.103', 'tailscale serve');
  assert.equal(clientAddr(req('192.168.1.4', '6.6.6.6')), '192.168.1.4', 'a remote client cannot claim another address');
  assert.equal(clientAddr(req('127.0.0.1', 'evil.local')), null);
});
