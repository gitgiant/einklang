// Zero-dependency sync server: static files, clock sync, feature relay, track hosting.
// Usage: node server.js   (PORT env, default 8080)
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const PORT = +process.env.PORT || 8080, PUB = path.join(__dirname, 'public'), MAX = 256 << 20;
const now = () => performance.now();
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };

let state = { mode: 'idle' }, fileFeat = null, ring = [], leader = null;
let track = null, trackType = 'application/octet-stream', trackId = 0;
const clients = new Set();

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (url === '/track' && req.method === 'POST') {
    const chunks = []; let n = 0;
    req.on('data', (c) => { n += c.length; if (n > MAX) req.destroy(); else chunks.push(c); });
    req.on('end', () => { track = Buffer.concat(chunks); trackType = req.headers['content-type'] || trackType; trackId++; res.end(String(trackId)); });
    return;
  }
  if (url === '/track') {
    if (!track) { res.writeHead(404); return res.end(); }
    const total = track.length, m = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
    if (m) {
      let s = m[1] ? +m[1] : total - +m[2], e = m[1] && m[2] ? +m[2] : total - 1;
      e = Math.min(e, total - 1);
      res.writeHead(206, { 'Content-Type': trackType, 'Content-Range': `bytes ${s}-${e}/${total}`, 'Content-Length': e - s + 1, 'Accept-Ranges': 'bytes' });
      return res.end(track.subarray(s, e + 1));
    }
    res.writeHead(200, { 'Content-Type': trackType, 'Content-Length': total, 'Accept-Ranges': 'bytes' });
    return res.end(track);
  }
  const file = path.join(PUB, path.normalize(url === '/' ? '/index.html' : url));
  if (!file.startsWith(PUB)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(data);
  });
});

// --- minimal RFC6455 ---
server.on('upgrade', (req, sock) => {
  const key = req.headers['sec-websocket-key'];
  if (!key) return sock.destroy();
  const acc = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${acc}\r\n\r\n`);
  sock.setNoDelay(true);
  const c = { sock, buf: Buffer.alloc(0), frag: [], op: 0 };
  clients.add(c);
  sock.on('data', (d) => { c.buf = Buffer.concat([c.buf, d]); parse(c); });
  const drop = () => { clients.delete(c); if (leader === c) leader = null; };
  sock.on('close', drop); sock.on('error', drop);
  send(c, 1, JSON.stringify({ t: 'state', ...state }));
  if (state.mode === 'file' && fileFeat) send(c, 2, fileFeat);
  if (state.mode === 'live') for (const m of ring) send(c, 2, m);
});

function parse(c) {
  for (;;) {
    const b = c.buf;
    if (b.length < 2) return;
    const fin = b[0] & 0x80, op = b[0] & 15, masked = b[1] & 0x80;
    let len = b[1] & 127, o = 2;
    if (len === 126) { if (b.length < 4) return; len = b.readUInt16BE(2); o = 4; }
    else if (len === 127) { if (b.length < 10) return; len = Number(b.readBigUInt64BE(2)); o = 10; }
    if (len > MAX) return c.sock.destroy();
    const mo = o; if (masked) o += 4;
    if (b.length < o + len) return;
    const p = Buffer.from(b.subarray(o, o + len));
    if (masked) for (let i = 0; i < len; i++) p[i] ^= b[mo + (i & 3)];
    c.buf = b.subarray(o + len);
    if (op === 8) { send(c, 8, Buffer.alloc(0)); c.sock.end(); return; }
    if (op === 9) { send(c, 10, p); continue; }
    if (op === 10) continue;
    if (op !== 0) { c.op = op; c.frag = []; }
    c.frag.push(p);
    if (fin) { const m = Buffer.concat(c.frag); c.frag = []; onMsg(c, c.op, m); }
  }
}

function send(c, op, p) {
  if (c.sock.destroyed) return;
  if (typeof p === 'string') p = Buffer.from(p);
  const n = p.length; let h;
  if (n < 126) h = Buffer.from([0x80 | op, n]);
  else if (n < 65536) { h = Buffer.alloc(4); h[0] = 0x80 | op; h[1] = 126; h.writeUInt16BE(n, 2); }
  else { h = Buffer.alloc(10); h[0] = 0x80 | op; h[1] = 127; h.writeBigUInt64BE(BigInt(n), 2); }
  c.sock.write(Buffer.concat([h, p]));
}

const bcast = () => { const s = JSON.stringify({ t: 'state', ...state }); for (const o of clients) send(o, 1, s); };

// binary: [1][u32 frame][18B] live frame | [2][u32 frames][frames*18B] whole-track features
function onMsg(c, op, m) {
  if (op === 2) {
    if (m[0] === 2) fileFeat = m;
    else if (m[0] === 1 && state.mode === 'live' && c === leader) {
      ring.push(m); if (ring.length > 700) ring.shift(); // > scene lookback (600)
      for (const o of clients) if (o !== c) send(o, 2, m);
    }
    return;
  }
  let j; try { j = JSON.parse(m); } catch { return; }
  if (j.t === 'ping') return send(c, 1, JSON.stringify({ t: 'pong', c: j.c, s: now() }));
  if (j.t === 'play' && fileFeat) {
    leader = c;
    state = { mode: 'file', start: now() + 2500, frames: fileFeat.readUInt32LE(1), track: trackId };
    for (const o of clients) send(o, 2, fileFeat);
    bcast();
  } else if (j.t === 'live') {
    leader = c; ring = [];
    state = { mode: 'live', start: now() + 300 };
    bcast();
  } else if (j.t === 'stop') {
    leader = null; fileFeat = null; ring = []; state = { mode: 'idle' }; bcast();
  }
}

server.listen(PORT, '0.0.0.0', () => console.log(`einklang on :${PORT}`));
