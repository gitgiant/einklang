// `npm run server`: runs the server (main.ts) as a child in the same terminal and starts it again when it
// exits with RESTART_CODE (POST /admin/restart), so new code on disk is picked up. Same node flags, args,
// env and cwd, so port and token stay. Imports no server code: a broken main.ts can't break this file.
import { spawn } from 'node:child_process';
import path from 'node:path';

/** Exit code by which the server asks to be started again. */
export const RESTART_CODE = 75;

export interface Child {
  on(event: 'exit', f: (code: number | null) => void): unknown;
  on(event: 'error', f: (e: Error) => void): unknown;
  kill(signal: NodeJS.Signals): unknown;
}

/**
 * Keep one child running: respawn on RESTART_CODE, otherwise resolve `done` with its exit code.
 * `respawned` is false only for the first start. `stop` forwards a signal and ends the respawning.
 */
export function supervise(start: (respawned: boolean) => Child, log: (s: string) => void = console.log) {
  let child: Child, stopped = false;
  const done = new Promise<number>((ok) => {
    const run = (respawned: boolean) => {
      child = start(respawned);
      child.on('error', (e) => { log(`server did not start: ${e.message}`); ok(1); });
      child.on('exit', (code) => {
        if (code === RESTART_CODE && !stopped) { log('--- restarting the server ---'); run(true); }
        else ok(code ?? (stopped ? 0 : 1));
      });
    };
    run(false);
  });
  return { done, stop: (signal: NodeJS.Signals) => { stopped = true; child.kill(signal); } };
}

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) {
  const main = path.join(import.meta.dirname, 'main.ts');
  const s = supervise((respawned) => spawn(process.execPath, [...process.execArgv, main, ...process.argv.slice(2)], {
    stdio: 'inherit',
    env: { ...process.env, EINKLANG_SUPERVISED: '1', EINKLANG_RESPAWNED: respawned ? '1' : '' },
  }));
  // Ctrl+C reaches the child too; either way the supervisor waits for it to end
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(sig, () => s.stop(sig));
  s.done.then((code) => process.exit(code));
}
