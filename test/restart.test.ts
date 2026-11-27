import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { startServer } from '../src/server/main.ts';
import { RESTART_EVERY_MS, processRestarter, type Restarter } from '../src/server/restart.ts';
import { RESTART_CODE, supervise } from '../src/server/supervisor.ts';
import { restartServer } from '../src/web/restart.ts';

const TOKEN = 'restart-token';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function serve(restart?: Restarter) {
  const srv = await startServer({ port: 0, pub: mkdtempSync(join(tmpdir(), 'einklang-')), token: TOKEN, hosts: ['127.0.0.1'], restart });
  const base = `http://127.0.0.1:${(srv.servers[0].address() as AddressInfo).port}`;
  const post = async (body: object | string = {}, query = `?t=${TOKEN}`) => {
    const r = await fetch(`${base}/admin/restart${query}`, { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body) });
    return { status: r.status, body: await r.text() };
  };
  return { srv, base, post };
}

function fake(over: Partial<Restarter> = {}) {
  const calls: string[] = [];
  const r: Restarter = {
    build: async () => { calls.push('build'); return { ok: true, log: '' }; },
    check: async () => { calls.push('check'); return { ok: true, log: '' }; },
    exit: () => { calls.push('exit'); },
    ...over,
  };
  return { r, calls };
}

test('restart endpoint: needs the room token and POST', async () => {
  const f = fake(), s = await serve(f.r);
  assert.equal((await s.post({}, '')).status, 401);
  assert.equal((await s.post({}, '?t=wrong')).status, 401);
  assert.equal((await fetch(`${s.base}/admin/restart?t=${TOKEN}`)).status, 405);
  assert.equal((await s.post('{')).status, 400);
  await sleep(350);
  assert.deepEqual(f.calls, []);
  await s.srv.close();
});

test('restart endpoint: checks, answers, exits; builds only when asked; rate-limited', async () => {
  const f = fake(), s = await serve(f.r);
  assert.equal((await s.post()).status, 200);
  const again = await s.post();
  assert.equal(again.status, 429);
  await sleep(350);
  assert.deepEqual(f.calls, ['check', 'exit']);
  await s.srv.close();
  const g = fake(), t = await serve(g.r);
  assert.equal((await t.post({ build: true })).status, 200);
  await sleep(350);
  assert.deepEqual(g.calls, ['build', 'check', 'exit']);
  await t.srv.close();
});

test('restart endpoint: a failed build or code check reports its output and keeps running', async () => {
  for (const step of ['build', 'check'] as const) {
    const f = fake({ [step]: async () => ({ ok: false, log: 'boom at line 3' }) }), s = await serve(f.r);
    const r = await s.post({ build: true });
    assert.equal(r.status, 500);
    assert.match(r.body, /not restarted.*boom at line 3/);
    await sleep(350);
    assert.ok(!f.calls.includes('exit'));
    assert.equal((await s.post()).status, 429, 'a failed attempt counts for the rate limit');
    await s.srv.close();
  }
});

test('restart endpoint: a respawned server is rate-limited from its start; an unsupervised one refuses', async () => {
  assert.ok(RESTART_EVERY_MS >= 10_000);
  const s = await serve(fake({ respawned: true }).r);
  assert.equal((await s.post()).status, 429);
  await s.srv.close();
  const u = await serve();
  assert.equal((await u.post()).status, 501);
  await u.srv.close();
});

class FakeChild extends EventEmitter {
  killed: string[] = [];
  kill(s: string) { this.killed.push(s); }
}

test('supervisor: respawns on the restart code only', async () => {
  const kids: FakeChild[] = [], respawned: boolean[] = [];
  const s = supervise((again) => { respawned.push(again); kids.push(new FakeChild()); return kids.at(-1)!; }, () => {});
  kids[0].emit('exit', RESTART_CODE);
  kids[1].emit('exit', RESTART_CODE);
  kids[2].emit('exit', 1);
  assert.equal(await s.done, 1);
  assert.deepEqual(respawned, [false, true, true]);
});

test('supervisor: a stop signal is forwarded and ends the respawning; a spawn error ends it', async () => {
  const kids: FakeChild[] = [];
  const start = () => { kids.push(new FakeChild()); return kids.at(-1)!; };
  const s = supervise(start, () => {});
  s.stop('SIGINT');
  kids[0].emit('exit', RESTART_CODE);
  assert.equal(await s.done, RESTART_CODE);
  assert.deepEqual([kids.length, kids[0].killed], [1, ['SIGINT']]);
  const e = supervise(start, () => {});
  kids[1].emit('error', new Error('ENOENT'));
  assert.equal(await e.done, 1);
});

test('the server code on disk passes the check', async () => {
  const r = await processRestarter(resolve(import.meta.dirname, '..'), false).check();
  assert.ok(r.ok, r.log);
});

test('page: waits for a new boot id, shows a failed build', async () => {
  const run = async (post: () => Response, boots: (string | null)[]) => {
    const said: [string, string?][] = [];
    const ok = await restartServer(false, {
      fetch: async (p) => {
        if (p === '/admin/restart') return post();
        const b = boots.shift();
        if (!b) throw new Error('down');
        return Response.json({ boot: b });
      },
      sleep: async () => {},
      say: (t, log) => { said.push([t, log]); },
    });
    return { ok, said };
  };
  const good = await run(() => Response.json({ ok: true }), ['a', 'a', null, 'b']);
  assert.ok(good.ok);
  assert.deepEqual(good.said.map((x) => x[0]), ['restarting…', 'restarting…', 'back']);
  const lost = await run(() => { throw new Error('network'); }, ['a', 'b']);
  assert.ok(lost.ok);
  const bad = await run(() => Response.json({ error: 'build failed, not restarted', log: 'x' }, { status: 500 }), ['a']);
  assert.ok(!bad.ok);
  assert.deepEqual(bad.said.at(-1), ['build failed, not restarted', 'x']);
  assert.ok(!(await run(() => Response.json({}), [null])).ok);
});

// real processes, as `npm run server` starts them
test('supervisor + server: restart brings up a new process on the same port and token', { timeout: 60_000 }, async () => {
  const port = await new Promise<number>((ok) => { const s = createServer().listen(0, '127.0.0.1', () => { const p = (s.address() as AddressInfo).port; s.close(() => ok(p)); }); });
  const proc = spawn(process.execPath, ['--experimental-strip-types', '--no-warnings', resolve(import.meta.dirname, '../src/server/supervisor.ts')], {
    env: { ...process.env, PORT: String(port), BIND: '127.0.0.1', EINKLANG_TOKEN: TOKEN },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  proc.stdout.on('data', (c) => { out += c; }); proc.stderr.on('data', (c) => { out += c; });
  const exited = new Promise((ok) => proc.on('exit', ok));
  try {
    const url = (p: string) => `http://127.0.0.1:${port}${p}?t=${TOKEN}`;
    const boot = async () => { try { return ((await (await fetch(url('/scores'))).json()) as { boot: string }).boot; } catch { return null; } };
    let first = null;
    while (!(first = await boot())) await sleep(100);
    const open = () => new WebSocket(`ws://127.0.0.1:${port}/ws?t=${TOKEN}`);
    const ws = open(), closed = new Promise((ok) => { ws.onclose = ok; });
    await new Promise((ok) => { ws.onopen = ok; });
    assert.equal((await fetch(url('/admin/restart'), { method: 'POST' })).status, 200);
    await closed;
    let second = null;
    while (!(second = await boot()) || second === first) await sleep(100);
    const again = open();
    await new Promise((ok, fail) => { again.onmessage = ok; again.onerror = fail; });
    again.close();
    assert.match(out, /restart requested[\s\S]*restarting the server[\s\S]*einklang listening/);
  } finally {
    proc.kill('SIGTERM');
    await exited;
  }
});
