// Scene gallery: every v1 scene driven by the synthetic demo track, no server needed.
// URL params:
//   scene=radial|tunnel|scope|flow|<lab scene id>   which scene (default radial)
//   grid=1                           all four at once
//   start=<s>                        demo-track time to start at (default 0)
//   stop=<s>                         stop rendering at this demo time (for screenshots); sets window.__done
//   hud=0                            hide HUD and tab bar
//   trans=<effect>|all               transitions: auto-cycle scenes every 2 bars with this effect
//                                    (all = rotate through every effect); key `t` / the selector
//   at=<s>                           with trans: one transition from `scene` to the next at demo
//                                    time s instead of the cycle (for stills: add stop=<s>)
//   len=<beats>                      transition length (default 4)
//   interp=0                         whole ticks only (no display-rate interpolation)
//   t=<token>                        room token, for voting through the server (remembered like the app's)
// Voting: 👍/👎 plus reason tags for the scene shown (keys + / -), posted to the server's /vote. A static
// build without the server shows the panel disabled.
import { initGpu } from './gpu/gpu.ts';
import { Engine } from './engine.ts';
import { demoSource, sectionAt } from '../core/demo.ts';
import { FPS, TICKS_PER_BEAT } from '../core/constants.ts';
import { TRANSITIONS, type SceneSched, type TransType } from '../core/protocol.ts';
import { TRANS_NAMES } from '../core/transitions.ts';
import { h32 } from '../core/math.ts';
import { VOTE_TAGS } from '../core/votes.ts';

declare global { interface Window { __done?: boolean; __error?: string } }

const qs = new URLSearchParams(location.search);
const $ = (id: string) => document.getElementById(id)!;
const F = demoSource();
const startTick = Math.round(+(qs.get('start') ?? 0) * FPS);
const stopTick = qs.has('stop') ? Math.round(+qs.get('stop')! * FPS) : Infinity;
let hud = qs.get('hud') !== '0';
const interp = qs.get('interp') !== '0';
let grid = (qs.get('grid') ?? document.body.dataset.grid) === '1'; // data-grid: default for hosted builds
let current = qs.get('scene') ?? 'radial';
/** '' = transitions off; else an effect id or 'all'. */
let trans = qs.get('trans') ?? '';
const oneShotAt = qs.has('at') ? Math.round(+qs.get('at')! * FPS) : null;
const beats = Math.max(0.5, Math.min(16, +(qs.get('len') ?? 4) || 4));
const CYCLE = 2 * 4 * TICKS_PER_BEAT;
const ROTATE = TRANSITIONS.filter((t) => t !== 'cut');
const mod = (a: number, n: number) => ((a % n) + n) % n;

const lsGet = (k: string) => { try { return localStorage.getItem(k); } catch { return null; } };
const token = qs.get('t') ?? lsGet('token') ?? '';
if (qs.get('t')) try { localStorage.setItem('token', qs.get('t')!); } catch { /* private mode */ }
const withToken = (p: string) => (token ? `${p}?t=${encodeURIComponent(token)}` : p);

/** The vote panel: 👍/👎 and reason tags for the scene shown, posted to the server. */
function votePanel(sceneOf: () => string | null) {
  const el = document.createElement('div'); el.id = 'vote';
  const label = document.createElement('span'), up = document.createElement('button'), down = document.createElement('button');
  const tags = document.createElement('div'); tags.className = 'tags';
  const note = document.createElement('span'); note.className = 'note';
  up.textContent = '👍'; up.title = 'vote up (+)'; down.textContent = '👎'; down.title = 'vote down (-)';
  const picked = new Set<string>();
  for (const t of VOTE_TAGS) {
    const b = document.createElement('button'); b.textContent = t; b.setAttribute('aria-pressed', 'false');
    b.onclick = () => { picked.has(t) ? picked.delete(t) : picked.add(t); b.setAttribute('aria-pressed', String(picked.has(t))); };
    tags.append(b);
  }
  el.append(label, up, down, note, tags);
  document.body.append(el);
  let scores: Record<string, number> = {}, live: string[] = [], online = false;
  const show = () => {
    const id = sceneOf();
    el.classList.toggle('hide', id === null);
    if (id === null) return;
    const s = scores[id] ?? 0;
    label.textContent = online ? `${s > 0 ? '+' : ''}${s}${live.includes(id) ? '' : ' · retired'}` : 'votes need the server';
    up.disabled = down.disabled = !online;
  };
  fetch(withToken('/scores')).then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
    .then((j: { scores: Record<string, number>; live: string[] }) => { scores = j.scores; live = j.live; online = true; show(); })
    .catch(() => { online = false; show(); });
  const send = async (vote: 1 | -1) => {
    const id = sceneOf();
    if (!id || !online) return;
    try {
      const r = await fetch(withToken('/vote'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ scene: id, vote, tags: [...picked] }) });
      const j = await r.json() as { score?: number; retired?: boolean; error?: string };
      if (!r.ok || j.score === undefined) throw new Error(j.error ?? String(r.status));
      scores[id] = j.score;
      if (j.retired) live = live.filter((x) => x !== id); else if (!live.includes(id)) live.push(id);
      note.textContent = `${vote > 0 ? '👍' : '👎'} saved${picked.size ? ` (${[...picked].join(', ')})` : ''}`;
      picked.clear(); for (const b of tags.querySelectorAll('button')) b.setAttribute('aria-pressed', 'false');
    } catch (e) { note.textContent = `vote failed: ${(e as Error).message}`; }
    show();
  };
  up.onclick = () => send(1); down.onclick = () => send(-1);
  return { show, send };
}

async function main() {
  const gpu = await initGpu();
  const stage = $('stage'), bar = $('bar');
  const cells = Array.from({ length: 4 }, () => {
    const cell = document.createElement('div'); cell.className = 'cell';
    const cv = document.createElement('canvas'), tag = document.createElement('div'); tag.className = 'tag';
    cell.append(cv, tag); stage.append(cell);
    return { cell, tag, engine: new Engine(gpu, cv) };
  });
  const ids = cells[0].engine.scenes.map((s) => s.def.id);
  /** The local stand-in for the server's schedule: a pure function of the tick, so stills repeat. */
  const schedAt = (tick: number): SceneSched | undefined => {
    if (!trans || grid) return undefined;
    const mk = (k: number, prev: string, id: string, at: number): SceneSched => ({
      id, prev, at, earlier: [],
      trans: { type: (trans === 'all' ? ROTATE[mod(k, ROTATE.length)] : trans) as TransType, ticks: Math.round(beats * TICKS_PER_BEAT), seed: h32(k, 0x7a5), tpb: TICKS_PER_BEAT },
    });
    if (oneShotAt !== null) return mk(0, current, ids[mod(ids.indexOf(current) + 1, ids.length)], oneShotAt);
    const k = Math.floor(tick / CYCLE);
    return mk(k, ids[mod(k - 1, ids.length)], ids[mod(k, ids.length)], k * CYCLE);
  };
  const tsel = document.createElement('select');
  tsel.add(new Option('no transitions', ''));
  tsel.add(new Option('auto: all effects', 'all'));
  for (const t of TRANSITIONS) tsel.add(new Option(`auto: ${TRANS_NAMES[t]}`, t));
  tsel.value = trans;
  const setTrans = (t: string) => {
    trans = t; tsel.value = t;
    if (t) grid = false;
    try { const u = new URL(location.href); t ? u.searchParams.set('trans', t) : u.searchParams.delete('trans'); history.replaceState(null, '', u); } catch { /* sandboxed */ }
    layout();
  };
  tsel.onchange = () => setTrans(tsel.value);
  const votes = votePanel(() => (grid ? null : cells[0].engine.scene.def.id));

  const layout = () => {
    stage.classList.toggle('grid', grid);
    cells.forEach((c, i) => {
      c.cell.classList.toggle('hide', !grid && i > 0);
      c.engine.setScene(grid ? i : current);
      c.engine.transition = null;
      c.tag.textContent = grid ? c.engine.scene.def.name : '';
    });
    for (const b of bar.querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.id === (grid ? 'grid' : trans && oneShotAt === null ? '' : current)));
    $('hud').classList.toggle('hide', !hud); bar.classList.toggle('hide', !hud);
    votes.show();
  };
  const go = (id: string) => {
    if (id === 'grid') { grid = !grid; if (grid) trans = ''; tsel.value = trans; } else { grid = false; current = id; }
    try {
      const u = new URL(location.href); u.searchParams.set('scene', current); grid ? u.searchParams.set('grid', '1') : u.searchParams.delete('grid');
      history.replaceState(null, '', u);
    } catch { /* sandboxed frames may refuse URL updates; the view still switches */ }
    layout();
  };
  for (const [i, id] of [...ids, 'grid'].entries()) {
    const b = document.createElement('button');
    b.dataset.id = id;
    b.textContent = id === 'grid' ? 'grid' : `${i + 1} ${cells[0].engine.scenes[i].def.name}`;
    b.onclick = () => go(id);
    bar.append(b);
  }
  bar.append(tsel);
  addEventListener('keydown', (e) => {
    if (e.key === 'h') { hud = !hud; layout(); }
    else if (e.key === 'g') go('grid');
    else if (e.key === 't') { const opts = ['', 'all', ...TRANSITIONS]; setTrans(opts[mod(opts.indexOf(trans) + (e.shiftKey ? -1 : 1), opts.length)]); }
    else if (+e.key >= 1 && +e.key <= ids.length) go(ids[+e.key - 1]);
    else if (e.key === '+' || e.key === '=') votes.send(1);
    else if (e.key === '-' || e.key === '_') votes.send(-1);
  });
  layout();

  const t0 = performance.now();
  let frames = 0, fps = 0, lastFps = t0;
  const loop = () => {
    const now = performance.now();
    const tF = startTick + ((now - t0) * FPS) / 1000, tick = Math.min(Math.floor(tF), stopTick);
    const sub = interp && tick < stopTick ? Math.floor((tF - Math.floor(tF)) * 256) : 0;
    const active = grid ? cells : cells.slice(0, 1);
    const sched = schedAt(tick);
    const hashes = active.map((c, i) => c.engine.frame(tick, F, undefined, i === 0 ? sched : undefined, sub));
    frames++;
    if (now - lastFps > 500) { fps = (frames * 1000) / (now - lastFps); frames = 0; lastFps = now; }
    if (hud) {
      const sc = cells[0].engine.scene;
      $('hud').textContent = [
        `${grid ? 'grid' : sc.def.name}  ·  demo ${(tick / FPS).toFixed(2)}s  ${sectionAt(tick)}`,
        `tick ${tick}  hash ${hashes.join(' ')}`,
        trans && !grid ? `transitions: ${trans === 'all' ? 'all' : TRANS_NAMES[trans as TransType]} ${beats} beats  ·  ${(() => {
          const tr = cells[0].engine.transition;
          return tr ? `${TRANS_NAMES[tr.type]} ${tr.from}→${tr.to} ${((tr.p16 / 65536) * 100) | 0}%` : 'between';
        })()}` : null,
        !grid && sc.status ? sc.status() : null,
        `${fps.toFixed(0)} fps  ·  WebGPU ${gpu.adapterInfo}`,
      ].filter(Boolean).join('\n');
    }
    if (tick >= stopTick) { gpu.device.queue.onSubmittedWorkDone().then(() => { window.__done = true; }); return; }
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}

main().catch((e: Error) => {
  window.__error = e.message;
  const el = $('err'); el.style.display = 'grid'; el.textContent = e.message;
});
