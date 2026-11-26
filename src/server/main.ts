// Zero-dependency sync server: static files, clock sync, room state + event relay, track hosting.
// Run: npm run server   (PORT, default 8080; BIND to override localhost+tailnet; EINKLANG_TOKEN).
// Serves the Vite build from dist/. In dev, run `npm run dev` alongside; Vite proxies /ws and /track.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { authorize, bindAddresses, loadToken, setCookie } from './auth.ts';
import { Room, type VoteStore } from './room.ts';
import { WsConn, MAX_FRAME } from './ws.ts';
import { DEFAULT_PRESETS } from '../core/protocol.ts';
import { parseVotes, type Vote } from '../core/votes.ts';
import { TRANSITION_PROBLEMS } from './transitions.ts';
import { transitions } from '../core/transitions.ts';

const TYPES: Record<string, string> = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.wasm': 'application/wasm',
};

export interface ServerOpts {
  port: number; pub: string; token: string; hosts: string[];
  /** Live scene ids in list order (default: the v1 presets). */
  scenes?: string[];
  /** Append-only vote log (default: in memory). */
  votesFile?: string;
}

/** Votes in an append-only JSONL file (created on the first vote). */
export function fileVotes(file: string): VoteStore {
  return {
    load: () => (fs.existsSync(file) ? parseVotes(fs.readFileSync(file, 'utf8')) : []),
    append: (v: Vote) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.appendFileSync(file, JSON.stringify(v) + '\n'); },
  };
}

/** Lab scenes that aren't retired, the v1 presets first, then by file name. */
export function labCatalog(dir: string): string[] {
  if (!fs.existsSync(dir)) return [...DEFAULT_PRESETS];
  const ids: string[] = [];
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json')).sort()) {
    try { const g = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); if (typeof g.id === 'string' && g.status !== 'retired') ids.push(g.id); } catch { /* the lab gate reports broken scenes */ }
  }
  const rank = (id: string) => { const i = DEFAULT_PRESETS.indexOf(id); return i < 0 ? DEFAULT_PRESETS.length : i; };
  return ids.map((id, i) => [id, i] as const).sort((a, b) => rank(a[0]) - rank(b[0]) || a[1] - b[1]).map(([id]) => id);
}
export interface Running { room: Room; servers: http.Server[]; close(): Promise<void> }

export async function startServer(o: ServerOpts): Promise<Running> {
  const room = new Room(undefined, undefined, { catalog: o.scenes, votes: o.votesFile ? fileVotes(o.votesFile) : undefined });
  const auto = setInterval(() => room.tickAuto(), 250);
  let track: Buffer | null = null, trackType = 'application/octet-stream';

  const handler: http.RequestListener = (req, res) => {
    const auth = authorize(req, o.token);
    if (!auth) {
      res.writeHead(401, { 'Content-Type': 'text/plain' });
      return res.end('Missing or wrong room token. Open the join URL the server printed (it ends in ?t=...).\n');
    }
    if (auth === 'query') res.setHeader('Set-Cookie', setCookie(o.token));
    const url = (req.url ?? '/').split('?')[0];

    if (url === '/scores') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify({ scores: room.state.scores, live: room.state.presets, transScores: room.state.transScores }));
    }
    if (url === '/vote' && req.method === 'POST') {
      let body = '';
      req.on('data', (c: Buffer) => { body += c; if (body.length > 4096) req.destroy(); });
      req.on('end', () => {
        let r: ReturnType<Room['vote']> = null;
        try {
          const v = JSON.parse(body);
          // `transition` instead of `scene`: a vote on a transition
          if (v.vote === 1 || v.vote === -1) r = v.transition !== undefined ? room.voteTransition(v, v.vote, v.tags, null) : room.vote(String(v.scene), v.vote, v.tags, null);
        } catch { /* bad JSON */ }
        res.writeHead(r ? 200 : 400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(r ?? { error: 'unknown scene or transition, or bad vote' }));
      });
      return;
    }
    if (url === '/track' && req.method === 'POST') {
      const chunks: Buffer[] = []; let n = 0;
      req.on('data', (c: Buffer) => { n += c.length; if (n > MAX_FRAME) req.destroy(); else chunks.push(c); });
      req.on('end', () => { track = Buffer.concat(chunks); trackType = req.headers['content-type'] || trackType; res.end(String(++room.trackId)); });
      return;
    }
    if (url === '/track') {
      if (!track) { res.writeHead(404); return res.end(); }
      const total = track.length, m = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
      if (m) {
        const s = m[1] ? +m[1] : total - +m[2];
        const e = Math.min(m[1] && m[2] ? +m[2] : total - 1, total - 1);
        res.writeHead(206, { 'Content-Type': trackType, 'Content-Range': `bytes ${s}-${e}/${total}`, 'Content-Length': e - s + 1, 'Accept-Ranges': 'bytes' });
        return res.end(track.subarray(s, e + 1));
      }
      res.writeHead(200, { 'Content-Type': trackType, 'Content-Length': total, 'Accept-Ranges': 'bytes' });
      return res.end(track);
    }
    const file = path.join(o.pub, path.normalize(url === '/' ? '/index.html' : url));
    if (!file.startsWith(o.pub)) { res.writeHead(403); return res.end(); }
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      res.end(data);
    });
  };

  const servers = await Promise.all(o.hosts.map((host) => new Promise<http.Server>((ok, fail) => {
    const s = http.createServer(handler);
    s.on('upgrade', (req, sock) => {
      if (!authorize(req, o.token)) { sock.end('HTTP/1.1 401 Unauthorized\r\n\r\n'); return; }
      const ws = WsConn.accept(req, sock);
      if (ws) room.join(ws);
    });
    s.once('error', fail);
    s.listen(o.port, host, () => ok(s));
  })));

  return {
    room, servers,
    close: async () => {
      clearInterval(auto);
      for (const s of servers) { s.closeAllConnections(); await new Promise((ok) => s.close(ok)); }
    },
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  const root = path.resolve(import.meta.dirname, '../..');
  const port = +(process.env.PORT ?? 8080);
  const pub = path.join(root, 'dist');
  if (!fs.existsSync(pub)) console.warn('dist/ not found: run `npm run build`, or use `npm run dev` for the page.');
  const token = loadToken(path.join(root, '.einklang-token'));
  const hosts = bindAddresses();
  const scenes = labCatalog(path.join(root, 'lab/scenes')), votesFile = path.join(root, 'data/votes.jsonl');
  startServer({ port, pub, token, hosts, scenes, votesFile }).then(({ room }) => {
    for (const p of TRANSITION_PROBLEMS) console.warn(`transition skipped: ${p}`);
    console.log(`${transitions().length} transitions`);
    console.log(`${room.state.presets.length} scenes live (${scenes.length - room.state.presets.length} retired by votes), votes in data/votes.jsonl`);
    console.log('einklang listening. Join URLs:');
    for (const h of hosts) console.log(`  http://${h.includes(':') ? `[${h}]` : h === '0.0.0.0' ? 'localhost' : h}:${port}/?t=${token}`);
    if (hosts.length === 1) console.log('  (no tailnet address found; set BIND to listen elsewhere)');
    console.log(`Dev (Vite): http://localhost:5173/?t=${token}`);
  }).catch((e: Error) => { console.error(e.message); process.exit(1); });
}
