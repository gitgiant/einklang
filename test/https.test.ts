import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import { connect } from 'node:tls';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { networkInterfaces, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { startServer } from '../src/server/main.ts';
import { lanAddresses, setCookie } from '../src/server/auth.ts';
import { redirectTarget, type RedirectTargets } from '../src/server/redirect.ts';
import { CHECK_EVERY_MS, expiresAt, findTailscale, keepFresh, lanCert, readCert, selfSigned, tailscaleCert, type Cert, type Exec } from '../src/server/certs.ts';
import { httpsSetup, publicUrl } from '../src/server/https.ts';

const DAY = 86_400_000, NOW = Date.parse('2026-11-27T12:00:00Z');
const tmp = () => mkdtempSync(join(tmpdir(), 'einklang-tls-'));
const NAME = 'pc.tail1.ts.net';

const TS: RedirectTargets = { https: { port: 8444, name: NAME } };
const remote = { remoteAddress: '100.101.1.2', localAddress: '100.101.1.1', host: 'pc:8080', url: '/gallery.html?scene=a%20b&t=tk' };

test('redirect: localhost and a local TLS proxy are served, other devices go to https with path and query', () => {
  for (const remoteAddress of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) assert.equal(redirectTarget({ ...remote, remoteAddress }, TS), null);
  // `tailscale serve` arrives from 127.0.0.1 whatever Host it forwards
  assert.equal(redirectTarget({ remoteAddress: '127.0.0.1', host: NAME, url: '/?t=tk' }, { ...TS, publicUrl: `https://${NAME}` }), null);
  assert.equal(redirectTarget(remote, TS), `https://${NAME}:8444/gallery.html?scene=a%20b&t=tk`);
  assert.equal(redirectTarget(remote, { ...TS, publicUrl: `https://${NAME}` }), `https://${NAME}/gallery.html?scene=a%20b&t=tk`);
  assert.equal(redirectTarget(remote, { publicUrl: `https://${NAME}` }), `https://${NAME}/gallery.html?scene=a%20b&t=tk`);
  assert.equal(redirectTarget(remote, {}), null, 'nowhere to send it: serve it');
  assert.equal(redirectTarget({ ...remote, url: '//evil.example/x' }, TS), `https://${NAME}:8444//evil.example/x`);
  assert.equal(redirectTarget({ ...remote, url: 'http://evil.example/x?t=1' }, TS), `https://${NAME}:8444/x?t=1`);
  assert.equal(redirectTarget({ ...remote, url: '*' }, TS), `https://${NAME}:8444/`);
  assert.equal(redirectTarget({ ...remote, host: 'pc:8080' }, { https: { port: 9 } }), 'https://pc:9/gallery.html?scene=a%20b&t=tk');
  assert.equal(redirectTarget({ ...remote, host: 'a/b@c' }, { https: { port: 9 } }), 'https://100.101.1.1:9/gallery.html?scene=a%20b&t=tk');
});

test('redirect: LAN devices stay on an address the self-signed certificate covers', () => {
  const t: RedirectTargets = { publicUrl: `https://${NAME}`, https: { port: 8444, name: NAME, lanNames: ['pc', 'pc.local', '192.168.0.5'] } };
  const lan = { remoteAddress: '192.168.0.9', localAddress: '::ffff:192.168.0.5', host: '192.168.0.5:8080', url: '/?t=tk' };
  assert.equal(redirectTarget(lan, t), 'https://192.168.0.5:8444/?t=tk');
  assert.equal(redirectTarget({ ...lan, host: 'PC.local:8080' }, t), 'https://pc.local:8444/?t=tk');
  assert.equal(redirectTarget({ ...lan, host: 'other.example' }, t), 'https://192.168.0.5:8444/?t=tk');
  assert.equal(redirectTarget(remote, t), `https://${NAME}/gallery.html?scene=a%20b&t=tk`, 'tailnet: unchanged');
  assert.equal(redirectTarget(lan, { publicUrl: `https://${NAME}` }), `https://${NAME}/?t=tk`, 'no LAN certificate');
});

test('redirect-only listener: localhost is redirected too', () => {
  assert.equal(redirectTarget({ ...remote, remoteAddress: '127.0.0.1' }, TS, true), `https://${NAME}:8444/gallery.html?scene=a%20b&t=tk`);
});

test('LAN addresses: private IPv4 on real adapters only; cookies are Secure on https', () => {
  const i = (address: string, internal = false) => [{ address, internal } as never];
  assert.deepEqual(lanAddresses({ lo: i('127.0.0.1', true), Ethernet: i('192.168.0.5'), wlan0: i('10.0.0.2'), pub: i('8.8.8.8'), Tailscale: i('100.64.0.1'),
    'vEthernet (WSL (Hyper-V firewall))': i('172.20.0.1'), docker0: i('172.17.0.1'), ll: i('169.254.1.1') }), ['192.168.0.5', '10.0.0.2']);
  assert.match(setCookie('t', true), /; Secure$/);
  assert.doesNotMatch(setCookie('t'), /Secure/);
});

test('self-signed certificate: usable, signed by itself, covers the names, 825 days', () => {
  const c = selfSigned({ dns: ['pc', 'pc.local'], ips: ['192.168.0.5'] }, NOW);
  const x = new crypto.X509Certificate(c.cert);
  assert.ok(x.verify(x.publicKey) && x.checkPrivateKey(crypto.createPrivateKey(c.key)));
  assert.ok(x.checkHost('pc.local') && x.checkIP('192.168.0.5'));
  assert.ok(!x.checkIP('192.168.0.6') && !x.ca);
  assert.equal(expiresAt(c.cert), NOW + 824 * DAY);
});

test('LAN certificate is generated once; replaced for a new address or near expiry', () => {
  const dir = tmp(), names = { dns: ['pc'], ips: ['192.168.0.5', '127.0.0.1'] };
  const a = lanCert(dir, names, NOW), b = lanCert(dir, names, NOW + 30 * DAY);
  assert.deepEqual([a.created, b.created, b.cert], [true, false, a.cert]);
  assert.equal(lanCert(dir, { ...names, ips: ['127.0.0.1'] }, NOW).created, false, 'an address gone is no reason');
  const c = lanCert(dir, { ...names, ips: ['192.168.0.6'] }, NOW);
  assert.ok(c.created);
  assert.ok(!lanCert(dir, { ...names, ips: ['192.168.0.6'] }, expiresAt(c.cert) - 15 * DAY).created);
  assert.ok(lanCert(dir, { ...names, ips: ['192.168.0.6'] }, expiresAt(c.cert) - 13 * DAY).created);
});

/** A tailscale that writes a certificate valid for `days` from the mock clock. */
function mockTailscale(clock: { now: number }, days = 90) {
  const calls: string[][] = [];
  const state = { fail: false };
  const exec: Exec = async (_bin, args) => {
    calls.push(args);
    if (args[0] === 'status') return JSON.stringify({ Self: { DNSName: `${NAME.toUpperCase()}.` } });
    if (state.fail) throw new Error('offline');
    const c = selfSigned({ dns: [NAME], ips: [] }, clock.now, days);
    writeFileSync(args[2], c.cert); writeFileSync(args[4], c.key);
    return '';
  };
  return { exec, calls, state, certs: () => calls.filter((a) => a[0] === 'cert').length };
}

test('tailscale: finds the program and the name; absent is null, other failures throw', async () => {
  const tried: string[] = [];
  const missing: Exec = async (bin) => { tried.push(bin); throw Object.assign(new Error('nope'), { code: 'ENOENT' }); };
  assert.equal(await findTailscale(missing, 'win32'), null);
  assert.equal(tried.length, 2);
  assert.deepEqual(await findTailscale(mockTailscale({ now: NOW }).exec, 'linux'), { bin: 'tailscale', name: NAME });
  await assert.rejects(findTailscale(async () => { throw new Error('daemon down'); }, 'linux'), /daemon down/);
  await assert.rejects(findTailscale(async () => '{"Self":{"DNSName":""}}', 'linux'), /DNS name/);
});

test('cert renewal: daily check, renews under 14 days, keeps the old one when that fails', async () => {
  const clock = { now: NOW }, ts = mockTailscale(clock), dir = tmp(), logs: string[] = [];
  const load = () => tailscaleCert(dir, { bin: 'tailscale', name: NAME }, { exec: ts.exec, now: clock.now, log: (s) => logs.push(s) });
  const first = await load();
  assert.deepEqual(ts.calls[0], ['cert', '--cert-file', join(dir, `${NAME}.crt`), '--key-file', join(dir, `${NAME}.key`), NAME]);
  let tick!: () => void, every = 0, stopped = false;
  const applied: Cert[] = [];
  const stop = keepFresh(first, load, (c) => applied.push(c), { timers: { every: (f, ms) => { tick = f; every = ms; return () => { stopped = true; }; } }, log: (s) => logs.push(s) });
  assert.equal(every, CHECK_EVERY_MS);
  const day = async (n: number) => { clock.now = NOW + n * DAY; tick(); await new Promise((ok) => setImmediate(ok)); };
  await day(1); await day(74); // 15 days left (made at NOW - 1 day, 90 days)
  assert.deepEqual([ts.certs(), applied.length], [1, 0]);
  ts.state.fail = true;
  await day(76);
  assert.deepEqual([ts.certs(), applied.length], [2, 0]);
  assert.match(logs.at(-1)!, /offline.*keeping/);
  ts.state.fail = false;
  await day(77);
  assert.deepEqual([ts.certs(), applied.length], [3, 1]);
  assert.notEqual(applied[0].cert, first.cert);
  await day(78);
  assert.deepEqual([ts.certs(), applied.length], [3, 1]);
  stop();
  assert.ok(stopped);
  ts.state.fail = true;
  await assert.rejects(tailscaleCert(tmp(), { bin: 'tailscale', name: NAME }, { exec: ts.exec, now: NOW }), /offline/);
});

test('https settings: off, Tailscale, own files, LAN; bad settings throw', async () => {
  const root = tmp(), exec = mockTailscale({ now: Date.now() }).exec, names = { dns: ['pc', 'localhost'], ips: ['192.168.0.5', '127.0.0.1'] };
  assert.equal(await httpsSetup({ EINKLANG_HTTPS: '0' }, root, { exec }), null);
  const none: Exec = async () => { throw Object.assign(new Error(), { code: 'ENOENT' }); };
  assert.equal(await httpsSetup({}, root, { exec: none }), null);
  const ts = (await httpsSetup({}, root, { exec }))!;
  assert.deepEqual([ts.port, ts.name, !!ts.main, !!ts.lan], [8444, NAME, true, false]);
  const warned: string[] = [];
  const lan = (await httpsSetup({ EINKLANG_LAN: '1', EINKLANG_HTTPS_PORT: '9443' }, root, { exec: async () => { throw new Error('logged out'); }, names, warn: (s) => warned.push(s) }))!;
  assert.deepEqual([lan.port, lan.main, lan.lanNames], [9443, undefined, ['pc', '192.168.0.5']]);
  assert.match(warned[0], /logged out/);
  const own = (await httpsSetup({ EINKLANG_CERT: join(root, '.einklang-certs', `${NAME}.crt`), EINKLANG_KEY: join(root, '.einklang-certs', `${NAME}.key`) }, root, { exec: none }))!;
  assert.deepEqual([own.name, own.main!.current], [NAME, readCert(join(root, '.einklang-certs', `${NAME}.crt`), join(root, '.einklang-certs', `${NAME}.key`))]);
  await assert.rejects(httpsSetup({ EINKLANG_CERT: 'x' }, root), /both/);
  await assert.rejects(httpsSetup({ EINKLANG_CERT: 'x', EINKLANG_KEY: 'y' }, root), /cannot read/);
  await assert.rejects(httpsSetup({ EINKLANG_HTTPS_PORT: 'no' }, root), /not a port/);
  assert.equal(publicUrl({ EINKLANG_PUBLIC_URL: `https://${NAME}/` }), `https://${NAME}`);
  assert.throws(() => publicUrl({ EINKLANG_PUBLIC_URL: `http://${NAME}` }), /https/);
});

interface Got { status: number; headers: http.IncomingHttpHeaders }
const get = (url: string, headers: Record<string, string> = {}) => new Promise<Got>((ok, fail) => {
  (url.startsWith('https') ? https : http).get(url, { headers, rejectUnauthorized: false, agent: false }, (r) => { r.resume(); ok({ status: r.statusCode!, headers: r.headers }); }).on('error', fail);
});
const served = (port: number, servername?: string) => new Promise<string>((ok, fail) => {
  const s = connect({ port, host: '127.0.0.1', servername, rejectUnauthorized: false }, () => { ok(s.getPeerX509Certificate()!.fingerprint256); s.end(); });
  s.on('error', fail);
});

test('server: https and wss, Secure cookie, SNI picks the certificate, renewal, redirect port', async () => {
  const pub = tmp(); writeFileSync(join(pub, 'index.html'), 'ok');
  const main = selfSigned({ dns: [NAME], ips: [] }), lan = selfSigned({ dns: ['pc'], ips: ['127.0.0.1'] });
  const print = (c: Cert) => new crypto.X509Certificate(c.cert).fingerprint256;
  const srv = await startServer({ port: 0, pub, token: 'tk', hosts: ['127.0.0.1'], https: { port: 0, main, lan, name: NAME }, httpPort: 0 });
  const port = (s: http.Server) => (s.address() as AddressInfo).port;
  const secure = port(srv.secure[0]), plain = port(srv.servers[0]);
  try {
    const page = await get(`https://127.0.0.1:${secure}/?t=tk`);
    assert.equal(page.status, 200);
    assert.match(page.headers['set-cookie']![0], /; Secure$/);
    assert.equal((await get(`https://127.0.0.1:${secure}/`)).status, 401);
    const local = await get(`http://127.0.0.1:${plain}/?t=tk`);
    assert.equal(local.status, 200);
    assert.doesNotMatch(local.headers['set-cookie']![0], /Secure/);
    assert.match((await get(`http://127.0.0.1:${plain}/?t=tk`, { 'x-forwarded-proto': 'https' })).headers['set-cookie']![0], /; Secure$/);
    const upgraded = await new Promise<number>((ok, fail) => {
      https.request(`https://127.0.0.1:${secure}/ws?t=tk`, { rejectUnauthorized: false, agent: false, headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': crypto.randomBytes(16).toString('base64') } })
        .on('upgrade', (r, sock) => { sock.destroy(); ok(r.statusCode!); }).on('error', fail).end();
    });
    assert.equal(upgraded, 101);
    assert.equal(await served(secure, NAME), print(main));
    assert.equal(await served(secure, 'pc'), print(lan));
    assert.equal(await served(secure), print(lan));
    const next = selfSigned({ dns: [NAME], ips: [] });
    srv.setCert('main', next);
    assert.equal(await served(secure, NAME), print(next));
    assert.equal(await served(secure), print(lan));
    const moved = await get(`http://127.0.0.1:${port(srv.redirectors[0])}/gallery.html?t=tk`);
    assert.deepEqual([moved.status, moved.headers.location], [308, `https://${NAME}:${secure}/gallery.html?t=tk`]);
  } finally { await srv.close(); }
});

test('server: an HTTPS port in use leaves http serving, with a warning', async () => {
  const blocker = http.createServer().listen(0, '127.0.0.1');
  await new Promise((ok) => blocker.once('listening', ok));
  const c = selfSigned({ dns: ['pc'], ips: [] });
  const srv = await startServer({ port: 0, pub: tmp(), token: 'tk', hosts: ['127.0.0.1'], https: { port: (blocker.address() as AddressInfo).port, main: c }, httpPort: 0 });
  assert.equal(srv.secure.length + srv.redirectors.length, 0);
  assert.match(srv.warnings.join('\n'), /no HTTPS.*EADDRINUSE[\s\S]*no https URL/);
  await srv.close(); blocker.close();
});

const nonLoopback = () => Object.values(networkInterfaces()).flat().find((i) => i && !i.internal && i.family === 'IPv4')?.address;

// a real non-loopback client: this machine's own network address, where it has one
test('server: a request from a non-loopback address is redirected, its ws upgrade refused', { skip: !nonLoopback() }, async () => {
  const ip = nonLoopback()!;
  const srv = await startServer({ port: 0, pub: tmp(), token: 'tk', hosts: [ip], publicUrl: `https://${NAME}` });
  const base = `${ip}:${(srv.servers[0].address() as AddressInfo).port}`;
  try {
    const r = await get(`http://${base}/x?t=tk`);
    assert.deepEqual([r.status, r.headers.location], [308, `https://${NAME}/x?t=tk`]);
    const refused = await new Promise<number>((ok, fail) => {
      http.request(`http://${base}/ws?t=tk`, { agent: false, headers: { Connection: 'Upgrade', Upgrade: 'websocket' } }).on('response', (res) => { res.resume(); ok(res.statusCode!); }).on('error', fail).end();
    });
    assert.equal(refused, 403);
  } finally { await srv.close(); }
});
