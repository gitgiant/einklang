import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { startServer, type Running } from '../src/server/main.ts';
import { isTailnet } from '../src/server/auth.ts';
import { INPUT_DELAY, modeTick, type RoomState, type ServerMsg, type TickEvent } from '../src/core/protocol.ts';

const TOKEN = 'test-token';
let srv: Running, base: string;

before(async () => {
  const pub = mkdtempSync(join(tmpdir(), 'einklang-'));
  writeFileSync(join(pub, 'index.html'), '<h1>ok</h1>');
  srv = await startServer({ port: 0, pub, token: TOKEN, hosts: ['127.0.0.1'] });
  base = `127.0.0.1:${(srv.servers[0].address() as AddressInfo).port}`;
});
after(() => srv.close());

/** WebSocket client that buffers every message so tests can await specific ones. */
class Peer {
  ws: WebSocket;
  private q: (ServerMsg | Uint8Array)[] = [];
  private waiters: (() => void)[] = [];
  constructor(ws: WebSocket) {
    this.ws = ws;
    ws.onmessage = (e) => {
      this.q.push(typeof e.data === 'string' ? JSON.parse(e.data) : new Uint8Array(e.data as ArrayBuffer));
      this.waiters.splice(0).forEach((w) => w());
    };
  }
  static open(token = TOKEN): Promise<Peer> {
    return new Promise((ok, fail) => {
      const ws = new WebSocket(`ws://${base}/ws?t=${token}`);
      ws.binaryType = 'arraybuffer';
      const p = new Peer(ws);
      ws.onopen = () => ok(p);
      ws.onerror = () => fail(new Error('ws failed'));
    });
  }
  /** Next (unconsumed) message matching pred. */
  async next<T = ServerMsg>(pred: (m: ServerMsg | Uint8Array) => boolean): Promise<T> {
    for (;;) {
      const i = this.q.findIndex(pred);
      if (i >= 0) return this.q.splice(i, 1)[0] as T;
      await new Promise<void>((r) => this.waiters.push(r));
    }
  }
  state(pred: (s: RoomState) => boolean = () => true) {
    return this.next<RoomState>((m) => !(m instanceof Uint8Array) && m.t === 'state' && pred(m as RoomState));
  }
  send(m: unknown) { this.ws.send(m instanceof Uint8Array ? new Uint8Array(m) : JSON.stringify(m)); }
  close() { this.ws.close(); }
}

test('every request needs the room token; a ?t= page load sets a cookie', async () => {
  assert.equal((await fetch(`http://${base}/`)).status, 401);
  assert.equal((await fetch(`http://${base}/track`)).status, 401);
  assert.equal((await fetch(`http://${base}/?t=nope`)).status, 401);
  const r = await fetch(`http://${base}/?t=${TOKEN}`);
  assert.equal(await r.text(), '<h1>ok</h1>');
  const cookie = r.headers.get('set-cookie')!.split(';')[0];
  assert.equal((await fetch(`http://${base}/index.html`, { headers: { cookie } })).status, 200);
  await assert.rejects(Peer.open('nope'));
});

test('tailnet address detection', () => {
  assert.ok(isTailnet('100.111.89.46'));
  assert.ok(isTailnet('fd7a:115c:a1e0::1'));
  assert.ok(!isTailnet('100.63.0.1'));
  assert.ok(!isTailnet('192.168.0.27'));
});

test('clock sync, hello -> host list, view overrides', async () => {
  const a = await Peer.open();
  const pong = a.next<{ c: number; s: number }>((m) => !(m instanceof Uint8Array) && m.t === 'pong');
  a.send({ t: 'ping', c: 42 });
  assert.equal((await pong).c, 42);

  const { you } = await a.next<{ you: number }>((m) => !(m instanceof Uint8Array) && m.t === 'welcome');
  a.send({ t: 'hello', name: 'tv' });
  await a.state((s) => s.hosts.some((h) => h.name === 'tv' && h.view === null));
  a.send({ t: 'view', host: you, view: 3 });
  await a.state((s) => s.hosts.some((h) => h.id === you && h.view === 3));
  a.close();
});

test('events are stamped INPUT_DELAY ahead, relayed to all, and replayed to joiners', async () => {
  const a = await Peer.open(), b = await Peer.open();
  const st = await b.state();
  const before = modeTick(st, performance.now());
  a.send({ t: 'ev', type: 'hit', payload: { pad: 1 } });
  const got = await b.next<{ ev: TickEvent }>((m) => !(m instanceof Uint8Array) && m.t === 'ev');
  assert.equal(got.ev.type, 'hit');
  assert.deepEqual(got.ev.payload, { pad: 1 });
  assert.ok(got.ev.tick >= before + INPUT_DELAY && got.ev.tick <= before + INPUT_DELAY + 3, `tick ${got.ev.tick} vs ${before}`);

  a.send({ t: 'ev', type: 'x'.repeat(33) }); // rejected: type too long
  const c = await Peer.open();
  const log = await c.next<{ events: TickEvent[] }>((m) => !(m instanceof Uint8Array) && m.t === 'log');
  assert.ok(log.events.some((e) => e.tick === got.ev.tick && e.type === 'hit'));
  assert.ok(!log.events.some((e) => e.type.length > 32));
  a.close(); b.close(); c.close();
});

test('scene switches land on the next bar (or beat) boundary, at least INPUT_DELAY ahead', async () => {
  const a = await Peer.open();
  const s0 = await a.state();
  a.send({ t: 'scene', id: 'scope', quant: 'bar' });
  const s1 = await a.state((s) => s.scene.id === 'scope');
  const bar = s1.grid.tpb * 4;
  assert.equal((s1.scene.at - s1.grid.origin) % bar, 0);
  assert.ok(s1.scene.at >= modeTick(s1, performance.now()) + INPUT_DELAY - 2);
  assert.equal(s1.scene.prev, s0.scene.at > modeTick(s0, performance.now()) ? s0.scene.prev : s0.scene.id);

  a.send({ t: 'scene', step: 1, quant: 'beat' }); // presets: radial tunnel scope flow -> flow
  const s2 = await a.state((s) => s.scene.id === 'flow');
  assert.equal((s2.scene.at - s2.grid.origin) % s2.grid.tpb, 0);
  a.send({ t: 'scene', id: 'nonexistent', quant: 'now' });
  a.send({ t: 'scene', id: 'radial', quant: 'now' });
  const s3 = await a.state((s) => s.scene.id !== 'flow');
  assert.equal(s3.scene.id, 'radial'); // the unknown id was ignored
  a.close();
});

test('file mode: features relayed, new epoch, logs reset', async () => {
  const a = await Peer.open(), b = await Peer.open();
  const e0 = (await b.state()).epoch;
  const feat = new Uint8Array(5 + 3 * 18); feat[0] = 2; new DataView(feat.buffer).setUint32(1, 3, true); feat[5] = 200;
  a.send(feat);
  a.send({ t: 'play' });
  const f = await b.next<Uint8Array>((m) => m instanceof Uint8Array && m[0] === 2);
  assert.equal(f.length, feat.length);
  assert.equal(f[5], 200);
  const st = await b.state((s) => s.mode === 'file');
  assert.equal(st.epoch, e0 + 1);
  assert.equal(st.mode === 'file' && st.frames, 3);
  const c = await Peer.open();
  const log = await c.next<{ events: TickEvent[] }>((m) => !(m instanceof Uint8Array) && m.t === 'log');
  assert.equal(log.events.length, 0);
  a.close(); b.close(); c.close();
});
