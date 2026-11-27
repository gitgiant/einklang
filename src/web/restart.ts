// "restart server": POST /admin/restart, then wait until a new server process answers /scores (its `boot`
// id changes). A button with a "rebuild first" box, in the app's debug panel and the gallery's display tab.

export interface RestartIo {
  fetch(path: string, init?: RequestInit): Promise<Response>;
  sleep(ms: number): Promise<unknown>;
  say(text: string, log?: string): void;
}

const POLL_MS = 500;

/** True once the new server answers; false (with the reason said) otherwise. */
export async function restartServer(build: boolean, io: RestartIo): Promise<boolean> {
  const boot = async (): Promise<string | null> => {
    try {
      const r = await io.fetch('/scores', { cache: 'no-store', signal: AbortSignal.timeout(3000) });
      return r.ok ? ((await r.json()) as { boot?: string }).boot ?? null : null;
    } catch { return null; }
  };
  const old = await boot();
  if (old === null) { io.say('no server that can restart answers (start it with `npm run server`)'); return false; }
  io.say(build ? 'rebuilding…' : 'restarting…');
  let wait = 60_000;
  try {
    const r = await io.fetch('/admin/restart', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ build }) });
    if (!r.ok) {
      const j = await r.json().catch(() => ({})) as { error?: string; log?: string };
      io.say(j.error ?? `restart failed (${r.status})`, j.log);
      return false;
    }
    io.say('restarting…');
  } catch {
    // the answer got lost (phone locked, network change): a build may still be running
    if (build) wait = 6 * 60_000;
    io.say('no answer, waiting for the server…');
  }
  for (let t = 0; t < wait; t += POLL_MS) {
    await io.sleep(POLL_MS);
    const now = await boot();
    if (now !== null && now !== old) { io.say('back'); return true; }
  }
  io.say('the new server has not answered: look at its terminal');
  return false;
}

/** The control. After a rebuild the page reloads (new page code); after a plain restart `back` runs. */
export function restartControl(withToken: (path: string) => string, back: () => void = () => {}): HTMLElement {
  const el = document.createElement('div'); el.className = 'restart';
  const button = document.createElement('button'); button.textContent = 'restart server';
  const label = document.createElement('label'), box = document.createElement('input'); box.type = 'checkbox';
  label.append(box, ' rebuild first');
  const note = document.createElement('span'); note.className = 'note';
  const out = document.createElement('div'); out.className = 'out'; out.hidden = true;
  el.append(button, label, note, out);
  button.onclick = async () => {
    button.blur(); // keys go back to the page
    const build = box.checked;
    if (!confirm(`${build ? 'Rebuild and restart' : 'Restart'} the server? Every screen reconnects; the track, capture and current scene are reset.`)) return;
    button.disabled = box.disabled = true;
    const ok = await restartServer(build, {
      fetch: (p, init) => fetch(withToken(p), init),
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      say: (text, log) => { note.textContent = text; out.textContent = log ?? ''; out.hidden = !log; },
    });
    button.disabled = box.disabled = false;
    if (ok && build) { note.textContent = 'back, reloading…'; setTimeout(() => location.reload(), 800); }
    else if (ok) back();
  };
  return el;
}
