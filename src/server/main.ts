// Zero-dependency sync server: static files, clock sync, room state + event relay, track hosting.
// Run: npm run server   (PORT, default 8080; BIND to override localhost+tailnet; EINKLANG_TOKEN; HTTPS
// settings in https.ts / README). That goes through supervisor.ts, which starts this file again on
// POST /admin/restart (restart.ts).
// Serves the Vite build from dist/. In dev, run `npm run dev` alongside; Vite proxies /ws and /track.
import crypto from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import fs from 'node:fs';
import path from 'node:path';
import { processRestarter, restartRoute, type Restarter } from './restart.ts';
import { authorize, bindAddresses, clientAddr, isLoopback, loadToken, setCookie } from './auth.ts';
import { fingerprint, keepFresh, type Cert } from './certs.ts';
import { httpPort, httpsSetup, lanEnabled, publicUrl } from './https.ts';
import { plainRequest, redirectTarget, type RedirectTargets } from './redirect.ts';
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
  /** How POST /admin/restart restarts (default: it can't). */
  restart?: Restarter;
  /** Also serve TLS on `hosts`. `main` has `name`; `lan` is for clients that ask for anything else. */
  https?: { port: number; main?: Cert; lan?: Cert; name?: string; lanNames?: string[] };
  /** https URL that other devices on plain HTTP are sent to (instead of this server's own HTTPS). */
  publicUrl?: string;
  /** A further port on `hosts` that only redirects to https. */
  httpPort?: number;
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
export interface Running {
  room: Room;
  /** Plain HTTP, one per host. */
  servers: http.Server[];
  /** TLS, one per host; empty without `https`, or if it could not listen. */
  secure: https.Server[];
  /** The $EINKLANG_HTTP_PORT listeners. */
  redirectors: http.Server[];
  /** What could not be started. */
  warnings: string[];
  /** Serve this certificate from now on. */
  setCert(which: 'main' | 'lan', c: Cert): void;
  close(): Promise<void>;
}

/** Listen on every host, or on none of them. */
async function listenAll<S extends http.Server>(hosts: string[], port: number, make: () => S): Promise<S[]> {
  const done = await Promise.allSettled(hosts.map((host) => new Promise<S>((ok, fail) => {
    const s = make();
    s.once('error', fail);
    s.listen(port, host, () => ok(s));
  })));
  const up = done.flatMap((d) => (d.status === 'fulfilled' ? [d.value] : []));
  const bad = done.find((d) => d.status === 'rejected');
  if (!bad) return up;
  for (const s of up) s.close();
  throw bad.reason;
}

function refuseUpgrade(sock: Duplex, to: string): void {
  const body = `Plain ws:// is refused from other devices. Open ${to.split('?')[0].replace(/\/ws$/, '/')} (with your ?t=...) instead.\n`;
  sock.end(`HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`);
}

export async function startServer(o: ServerOpts): Promise<Running> {
  const room = new Room(undefined, undefined, { catalog: o.scenes, votes: o.votesFile ? fileVotes(o.votesFile) : undefined });
  const auto = setInterval(() => room.tickAuto(), 250);
  const restart = restartRoute(o.restart), boot = crypto.randomUUID(); // /scores tells processes apart by it
  let track: Buffer | null = null, trackType = 'application/octet-stream';

  const handler: http.RequestListener = (req, res) => {
    const auth = authorize(req, o.token);
    if (!auth) {
      res.writeHead(401, { 'Content-Type': 'text/plain' });
      return res.end('Missing or wrong room token. Open the join URL the server printed (it ends in ?t=...).\n');
    }
    // over TLS here, or at a local proxy in front (`tailscale serve`)
    const secure = 'encrypted' in req.socket || (isLoopback(req.socket.remoteAddress ?? '') && req.headers['x-forwarded-proto'] === 'https');
    if (auth === 'query') res.setHeader('Set-Cookie', setCookie(o.token, secure));
    const url = (req.url ?? '/').split('?')[0];

    if (url === '/scores') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify({ scores: room.state.scores, live: room.state.presets, transScores: room.state.transScores, boot }));
    }
    if (url === '/admin/restart') return restart(req, res);
    if (url === '/vote' && req.method === 'POST') {
      let body = '';
      req.on('data', (c: Buffer) => { body += c; if (body.length > 4096) req.destroy(); });
      req.on('end', () => {
        let r: ReturnType<Room['vote']> = null;
        try {
          const v = JSON.parse(body);
          // `transition` instead of `scene`: a vote on a transition
          if (v.vote === 1 || v.vote === -1) r = v.transition !== undefined ? room.voteTransition(v, v.vote, v.tags, null) : room.vote(String(v.scene), v.vote, v.tags, null, undefined, v.evolve);
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

  const upgrade = (req: http.IncomingMessage, sock: Duplex) => {
    if (!authorize(req, o.token)) { sock.end('HTTP/1.1 401 Unauthorized\r\n\r\n'); return; }
    const ws = WsConn.accept(req, sock);
    if (ws) room.join(ws, clientAddr(req));
  };

  const warnings: string[] = [];
  const certs = { main: o.https?.main, lan: o.https?.lan };
  let secure: https.Server[] = [], sni: tls.SecureContext | undefined;
  /** The default certificate (clients that name no host, or another one); `sni` holds `main` beside it. */
  const fallback = () => (certs.lan ?? certs.main)!;
  const useSni = () => { sni = certs.main && certs.lan ? tls.createSecureContext(certs.main) : undefined; };
  if (o.https && (certs.main || certs.lan)) {
    useSni();
    try {
      secure = await listenAll(o.hosts, o.https.port, () => {
        const s = https.createServer({
          ...fallback(),
          SNICallback: (name, done) => done(null, sni && new crypto.X509Certificate(certs.main!.cert).checkHost(name) ? sni : undefined),
        }, handler);
        s.on('upgrade', upgrade);
        return s;
      });
    } catch (e) { warnings.push(`no HTTPS: ${(e as Error).message}`); }
  }

  const targets: RedirectTargets = {
    publicUrl: o.publicUrl,
    https: secure.length ? { port: (secure[0].address() as AddressInfo).port, name: o.https!.name, lanNames: certs.lan ? o.https!.lanNames : undefined } : undefined,
  };
  const redirect = (res: http.ServerResponse, to: string) => { res.writeHead(308, { Location: to, 'Cache-Control': 'no-store' }); res.end(); };
  const plain = (redirectOnly: boolean) => () => {
    const s = http.createServer((req, res) => {
      const to = redirectTarget(plainRequest(req), targets, redirectOnly);
      if (to) return redirect(res, to);
      handler(req, res);
    });
    s.on('upgrade', (req, sock) => {
      const to = redirectTarget(plainRequest(req), targets, redirectOnly);
      if (to) refuseUpgrade(sock, to); else upgrade(req, sock);
    });
    return s;
  };

  let servers: http.Server[], redirectors: http.Server[] = [];
  try { servers = await listenAll(o.hosts, o.port, plain(false)); } catch (e) {
    clearInterval(auto);
    for (const s of secure) s.close();
    throw e;
  }
  if (o.httpPort !== undefined) {
    if (!targets.publicUrl && !targets.https) warnings.push(`not listening on port ${o.httpPort}: there is no https URL to redirect to`);
    else {
      try { redirectors = await listenAll(o.hosts, o.httpPort, plain(true)); } catch (e) { warnings.push(`no redirect on port ${o.httpPort}: ${(e as Error).message}`); }
    }
  }

  return {
    room, servers, secure, redirectors, warnings,
    setCert: (which, c) => {
      tls.createSecureContext(c); // throws before anything changes if unusable
      certs[which] = c;
      useSni();
      for (const s of secure) s.setSecureContext(fallback());
    },
    close: async () => {
      clearInterval(auto);
      for (const s of [...servers, ...secure, ...redirectors]) { s.closeAllConnections(); await new Promise((ok) => s.close(ok)); }
    },
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  const root = path.resolve(import.meta.dirname, '../..');
  const port = +(process.env.PORT ?? 8080);
  const pub = path.join(root, 'dist');
  if (!fs.existsSync(pub)) console.warn('dist/ not found: run `npm run build`, or use `npm run dev` for the page.');
  const token = loadToken(path.join(root, '.einklang-token'));
  const lan = lanEnabled(process.env);
  const hosts = bindAddresses(lan);
  const scenes = labCatalog(path.join(root, 'lab/scenes')), votesFile = path.join(root, 'data/votes.jsonl');
  const restart = process.env.EINKLANG_SUPERVISED ? processRestarter(root, !!process.env.EINKLANG_RESPAWNED) : undefined;
  const main = async () => {
    const pubUrl = publicUrl(process.env), redirectPort = httpPort(process.env);
    const setup = await httpsSetup(process.env, root);
    const running = await startServer({
      port, pub, token, hosts, scenes, votesFile, restart, publicUrl: pubUrl, httpPort: redirectPort,
      https: setup ? { port: setup.port, main: setup.main?.current, lan: setup.lan?.current, name: setup.name, lanNames: setup.lanNames } : undefined,
    });
    const { room, secure } = running;
    for (const which of ['main', 'lan'] as const) {
      const source = setup?.[which];
      if (source && secure.length) keepFresh(source.current, source.load, (c) => running.setCert(which, c));
    }
    for (const p of TRANSITION_PROBLEMS) console.warn(`transition skipped: ${p}`);
    for (const w of running.warnings) console.warn(w);
    console.log(`${transitions().length} transitions`);
    console.log(`${room.state.presets.length} scenes live (${scenes.length - room.state.presets.length} retired by votes), votes in data/votes.jsonl`);
    console.log('einklang listening. Join URLs:');
    const join = (base: string, note = '') => console.log(`  ${base}/?t=${token}${note}`);
    const urlHost = (h: string) => (h.includes(':') ? `[${h}]` : h === '0.0.0.0' ? 'localhost' : h);
    if (pubUrl) join(pubUrl);
    if (secure.length) {
      if (setup!.main && setup!.name) join(`https://${setup!.name}:${setup!.port}`);
      else if (setup!.main) for (const h of hosts) join(`https://${urlHost(h)}:${setup!.port}`);
      if (setup!.lan) {
        console.log('  LAN, self-signed: accept the browser warning once, after comparing the certificate\'s SHA-256 fingerprint:');
        console.log(`  ${fingerprint(setup!.lan.current.cert)}`);
        for (const n of setup!.lanNames!) join(`https://${n}:${setup!.port}`);
      }
    }
    // with https, other devices are redirected, so plain http is only worth listing for this machine
    for (const h of hosts) {
      const local = h === '0.0.0.0' || h === '::' || isLoopback(h);
      if (local || (!secure.length && !pubUrl)) join(`http://${urlHost(h === '::' ? 'localhost' : h)}:${port}`);
    }
    if (!secure.length && !pubUrl) console.log('  (no HTTPS: other devices get no mic, screen share or wake lock over http)');
    if (hosts.length === 1) console.log('  (no tailnet address found; set BIND to listen elsewhere)');
    console.log(`Dev (Vite): http://localhost:5173/?t=${token}`);
  };
  main().catch((e: Error) => { console.error(e.message); process.exit(1); });
}
