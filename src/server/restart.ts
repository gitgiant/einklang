// POST /admin/restart {build?: boolean}: optionally `npm run build`, make sure the server code on disk
// loads, answer, then exit with RESTART_CODE for the supervisor (supervisor.ts) to start it again.
// A failed step answers with its output and keeps the running server.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { stripVTControlCharacters } from 'node:util';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { RESTART_CODE } from './supervisor.ts';

export const RESTART_EVERY_MS = 10_000;

export interface StepResult { ok: boolean; log: string }
export interface Restarter {
  /** `npm run build`. */
  build(): Promise<StepResult>;
  /** Whether the server code now on disk loads. */
  check(): Promise<StepResult>;
  /** End this process so that it gets started again. */
  exit(): void;
  /** This process came out of a restart: the rate limit counts from its start. */
  respawned?: boolean;
}

export function restartRoute(r: Restarter | undefined, now: () => number = Date.now, log: (s: string) => void = console.log) {
  let last = r?.respawned ? now() : -Infinity, busy = false;
  return (req: IncomingMessage, res: ServerResponse): void => {
    const reply = (status: number, body: object) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); };
    if (req.method !== 'POST') return reply(405, { error: 'POST only' });
    if (!r) return reply(501, { error: 'this server cannot restart itself: start it with `npm run server`' });
    let body = '';
    req.on('data', (c: Buffer) => { body += c; if (body.length > 1024) req.destroy(); });
    req.on('end', async () => {
      let build = false;
      try { build = body !== '' && JSON.parse(body).build === true; } catch { return reply(400, { error: 'bad JSON' }); }
      if (busy) return reply(429, { error: 'a restart is already running' });
      const wait = last + RESTART_EVERY_MS - now();
      if (wait > 0) return reply(429, { error: `restarted just now, try again in ${Math.ceil(wait / 1000)} s` });
      busy = true; last = now();
      log(`restart requested${build ? ' (rebuild first)' : ''} by ${req.socket.remoteAddress}`);
      try {
        for (const [name, step] of [...(build ? [['build', r.build] as const] : []), ['server code check', r.check] as const]) {
          const result = await step();
          if (!result.ok) {
            log(`restart aborted: ${name} failed, still running the old server`);
            busy = false;
            return reply(500, { error: `${name} failed, not restarted`, log: result.log });
          }
        }
      } catch (e) { busy = false; return reply(500, { error: `not restarted: ${(e as Error).message}` }); }
      log('restarting…');
      reply(200, { ok: true });
      setTimeout(() => r.exit(), 250); // let the answer leave first (busy stays set until the exit)
    });
  };
}

/** Run a command to its end; `log` is the tail of its output. */
function step(cmd: string, args: string[], cwd: string, opts: { shell?: boolean; echo?: boolean } = {}): Promise<StepResult> {
  return new Promise((ok) => {
    let out = '';
    const p = spawn(cmd, args, { cwd, shell: opts.shell, stdio: ['ignore', 'pipe', 'pipe'], timeout: 5 * 60_000 });
    const take = (to: NodeJS.WriteStream) => (c: Buffer) => { out = (out + c).slice(-8000); if (opts.echo) to.write(c); };
    p.stdout!.on('data', take(process.stdout)); p.stderr!.on('data', take(process.stderr));
    p.on('error', (e) => ok({ ok: false, log: e.message }));
    p.on('close', (code) => ok({ ok: code === 0, log: stripVTControlCharacters(out) }));
  });
}

/** The real steps, for a server started by the supervisor in `root`. */
export function processRestarter(root: string, respawned: boolean): Restarter {
  const main = pathToFileURL(path.join(import.meta.dirname, 'main.ts')).href;
  return {
    respawned,
    // through the shell: npm is npm.cmd on Windows
    build: () => step('npm run build', [], root, { shell: true, echo: true }),
    // importing main.ts starts nothing, but resolves and runs every module the server loads
    check: () => step(process.execPath, [...process.execArgv, '--input-type=module', '-e', `await import(${JSON.stringify(main)})`], root),
    exit: () => process.exit(RESTART_CODE),
  };
}
