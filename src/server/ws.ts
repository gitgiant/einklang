// Minimal RFC 6455 WebSocket server side: handshake, framing, ping/pong, fragmentation.
import crypto from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';

export const MAX_FRAME = 256 << 20;

export class WsConn {
  private buf = Buffer.alloc(0);
  private frag: Buffer[] = [];
  private op = 0;
  onmessage: (data: Buffer | string) => void = () => {};
  onclose: () => void = () => {};
  private sock: Duplex;

  constructor(sock: Duplex) {
    this.sock = sock;
    sock.on('data', (d: Buffer) => { this.buf = Buffer.concat([this.buf, d]); this.parse(); });
    let closed = false;
    const done = () => { if (!closed) { closed = true; this.onclose(); } };
    sock.on('close', done); sock.on('error', done);
  }

  /** Complete the upgrade handshake. Returns null if the request isn't a WebSocket upgrade. */
  static accept(req: IncomingMessage, sock: Duplex): WsConn | null {
    const key = req.headers['sec-websocket-key'];
    if (!key) { sock.destroy(); return null; }
    const acc = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${acc}\r\n\r\n`);
    (sock as unknown as { setNoDelay?(b: boolean): void }).setNoDelay?.(true);
    return new WsConn(sock);
  }

  send(payload: Buffer | Uint8Array | string): void {
    const binary = typeof payload !== 'string';
    this.frame(binary ? 2 : 1, binary ? Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength) : Buffer.from(payload));
  }

  json(msg: unknown): void { this.send(JSON.stringify(msg)); }

  close(): void { this.sock.end(); }

  private frame(op: number, p: Buffer): void {
    if (this.sock.destroyed) return;
    const n = p.length; let h: Buffer;
    if (n < 126) h = Buffer.from([0x80 | op, n]);
    else if (n < 65536) { h = Buffer.alloc(4); h[0] = 0x80 | op; h[1] = 126; h.writeUInt16BE(n, 2); }
    else { h = Buffer.alloc(10); h[0] = 0x80 | op; h[1] = 127; h.writeBigUInt64BE(BigInt(n), 2); }
    this.sock.write(Buffer.concat([h, p]));
  }

  private parse(): void {
    for (;;) {
      const b = this.buf;
      if (b.length < 2) return;
      const fin = b[0] & 0x80, op = b[0] & 15, masked = b[1] & 0x80;
      let len = b[1] & 127, o = 2;
      if (len === 126) { if (b.length < 4) return; len = b.readUInt16BE(2); o = 4; }
      else if (len === 127) { if (b.length < 10) return; len = Number(b.readBigUInt64BE(2)); o = 10; }
      if (len > MAX_FRAME) { this.sock.destroy(); return; }
      const mo = o; if (masked) o += 4;
      if (b.length < o + len) return;
      const p = Buffer.from(b.subarray(o, o + len));
      if (masked) for (let i = 0; i < len; i++) p[i] ^= b[mo + (i & 3)];
      this.buf = b.subarray(o + len);
      if (op === 8) { this.frame(8, Buffer.alloc(0)); this.sock.end(); return; }
      if (op === 9) { this.frame(10, p); continue; }
      if (op === 10) continue;
      if (op !== 0) { this.op = op; this.frag = []; }
      this.frag.push(p);
      if (fin) {
        const m = Buffer.concat(this.frag); this.frag = [];
        this.onmessage(this.op === 1 ? m.toString() : m);
      }
    }
  }
}
