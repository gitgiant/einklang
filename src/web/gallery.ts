// Scene gallery: every scene driven by the synthetic demo track, or by an input picked bottom left (mic,
// tab / system audio, an audio file; analyzed in the page), no server needed. Double-tap or double-click
// the picture to hide / show the UI. A single tap or click on its right / left third (also with the UI
// hidden), or the right / left arrow key, goes to the next / previous scene.
// URL params:
//   scene=radial|tunnel|scope|flow|<lab scene id>   which scene (default radial)
//   grid=1                           all four at once
//   start=<s>                        demo-track time to start at (default 0)
//   stop=<s>                         stop rendering at this demo time (for screenshots); sets window.__done
//   hud=0                            hide the tab bar; hud=1 also shows the info text (key `i`)
//   trans=random|<effect>|all|off    transitions: auto-cycle scenes (2 bars, longer for long
//                                    transitions) from `scene` with a random effect per switch (the
//                                    default), one effect, or all in order; off (or none) = stay on
//                                    one scene; key `t` / the selector. With stop= or at= the default
//                                    is off, and a stop= cycle counts from the first scene at time 0
//   at=<s>                           with trans: one transition from `scene` to the next at demo
//                                    time s instead of the cycle (for stills: add stop=<s>)
//   len=<beats>                      transition length (default: the length selector's choice,
//                                    remembered per device, else 8; stills ignore the remembered one)
//   interp=0                         whole ticks only (no display-rate interpolation)
//   t=<token>                        room token, for voting through the server (remembered like the app's)
// Voting: 👍/👎 plus reason tags for the scene shown (keys + / -), posted to the server's /vote. A static
// build without the server shows the panel disabled.
import { initGpu } from './gpu/gpu.ts';
import { Engine } from './engine.ts';
import { FrameStats } from './framestats.ts';
import { FPS } from '../core/constants.ts';
import { TRANS_BEATS, ranTransition, type SceneSched } from '../core/protocol.ts';
import './transitions.ts'; // installs the transition registry (lab/transitions/)
import { transIds, transName, transitions } from '../core/transitions.ts';
import { VOTE_TAGS } from '../core/votes.ts';
import { autoHideUi } from './idle.ts';
import { tapZone, toggleUiOnDoubleTap } from './doubletap.ts';
import { galleryBeats, galleryTrans, type GalleryTrans } from './defaults.ts';
import { TRANS_KEYS, transRow } from './transvote.ts';
import { ZERO, cycleSched, holdAt, retime, step, switchAt, type Anchor, type Cycle } from './cycle.ts';
import { demoInput, fileInput, liveInput, type Input } from './inputs.ts';
import { canShare, insecure, micError, openMic, openShare } from './capture.ts';
import { ACCEPT, Player } from './player.ts';

declare global { interface Window { __done?: boolean; __error?: string } }

const qs = new URLSearchParams(location.search);
const $ = (id: string) => document.getElementById(id)!;
const startTick = Math.round(+(qs.get('start') ?? 0) * FPS);
const stopTick = qs.has('stop') ? Math.round(+qs.get('stop')! * FPS) : Infinity;
let hud = qs.get('hud') !== '0';
/** The bottom-left info text: off unless hud=1 (mockups) or toggled with `i`. */
let info = qs.get('hud') === '1';
const interp = qs.get('interp') !== '0';
let grid = (qs.get('grid') ?? document.body.dataset.grid) === '1'; // data-grid: default for hosted builds
let current = qs.get('scene') ?? 'radial';
let trans: GalleryTrans = galleryTrans(qs);
const oneShotAt = qs.has('at') ? Math.round(+qs.get('at')! * FPS) : null;
const mod = (a: number, n: number) => ((a % n) + n) % n;

const lsGet = (k: string) => { try { return localStorage.getItem(k); } catch { return null; } };
/** Transition length in beats. Its own key: the app's `tlen` would also count as a choice for the room. */
let beats = galleryBeats(qs, lsGet('gallery.tlen'));
const token = qs.get('t') ?? lsGet('token') ?? '';
if (qs.get('t')) try { localStorage.setItem('token', qs.get('t')!); } catch { /* private mode */ }
const withToken = (p: string) => (token ? `${p}?t=${encodeURIComponent(token)}` : p);

/**
 * The vote panel: 👍/👎 and reason tags for the scene shown, and under it the row for the last transition,
 * posted to the server. `scored`: the transition scores, whenever they arrive or change.
 */
function votePanel(sceneOf: () => { id: string; name: string } | null, scored: (s: Record<string, number>) => void) {
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
  const post = async (body: object) => {
    const r = await fetch(withToken('/vote'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const j = await r.json() as { score?: number; retired?: boolean; error?: string };
    if (!r.ok || j.score === undefined) throw new Error(j.error ?? String(r.status));
    return { score: j.score, retired: j.retired };
  };
  const trans = transRow(async (t, vote, picks) => {
    try {
      const j = await post({ transition: t.type, from: t.from, to: t.to, beats: t.beats, vote, tags: picks });
      transScores = { ...transScores, [t.type]: j.score };
      trans.saved(`${vote > 0 ? '👍' : '👎'} saved ${transName(t.type)}${picks.length ? ` (${picks.join(', ')})` : ''}`);
      scored(transScores);
    } catch (e) { trans.note(`vote failed: ${(e as Error).message}`); }
    show();
  });
  el.append(label, up, down, note, tags, trans.el);
  document.body.append(el);
  let scores: Record<string, number> = {}, transScores: Record<string, number> = {}, live: string[] = [], online = false;
  const show = () => {
    trans.show(transScores, online);
    const sc = sceneOf();
    el.classList.toggle('hide', sc === null);
    if (sc === null) return;
    const s = scores[sc.id] ?? 0;
    label.textContent = sc.name + (online ? `  ${s > 0 ? '+' : ''}${s}${live.includes(sc.id) ? '' : ' · retired'}` : '');
    label.title = online ? '' : 'voting needs the server (npm run server)';
    up.disabled = down.disabled = !online;
  };
  fetch(withToken('/scores')).then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
    .then((j: { scores: Record<string, number>; live: string[]; transScores?: Record<string, number> }) => { scores = j.scores; live = j.live; transScores = j.transScores ?? {}; online = true; scored(transScores); show(); })
    .catch(() => { online = false; show(); });
  const send = async (vote: 1 | -1) => {
    const id = sceneOf()?.id;
    if (!id || !online) return;
    try {
      const j = await post({ scene: id, vote, tags: [...picked] });
      scores[id] = j.score;
      if (j.retired) live = live.filter((x) => x !== id); else if (!live.includes(id)) live.push(id);
      note.textContent = `${vote > 0 ? '👍' : '👎'} saved${picked.size ? ` (${[...picked].join(', ')})` : ''}`;
      picked.clear(); for (const b of tags.querySelectorAll('button')) b.setAttribute('aria-pressed', 'false');
    } catch (e) { note.textContent = `vote failed: ${(e as Error).message}`; }
    show();
  };
  up.onclick = () => send(1); down.onclick = () => send(-1);
  /** Key votes count only while the panel is on screen. */
  const voteTrans = (v: 1 | -1) => { if (sceneOf()) trans.vote(v); };
  return { show, send, voteTrans, trans };
}

/** The input picker. `change` takes over each newly opened input. */
function inputPanel(change: (i: Input) => void) {
  const el = document.createElement('div'); el.id = 'input';
  const note = document.createElement('span'); note.className = 'note';
  const file = document.createElement('input'); file.type = 'file'; file.accept = ACCEPT; file.multiple = true; file.hidden = true; // multiple: a track and its .lrc
  let player: Player | null = null, asked = 0, active: Input | null = null;
  const buttons = new Map<string, HTMLButtonElement>();
  const press = (kind: string) => { for (const [k, b] of buttons) b.setAttribute('aria-pressed', String(k === kind)); };
  /** Open an input; a later pick wins over one still opening, and a failure keeps the current one. */
  const pick = async (kind: string, open: () => Promise<Input>, failed: string) => {
    const mine = ++asked;
    note.textContent = '';
    try {
      const input = await open();
      if (mine !== asked) return input.stop();
      change(active = input); press(kind);
    } catch (e) {
      const err = e as Error;
      if (mine === asked) note.textContent = kind === 'mic' ? micError(err, insecure(), navigator)
        : err.name === 'NotAllowedError' && kind === 'share' ? '' : `${failed}: ${err.message}${kind === 'file' ? '' : insecure()}`;
    }
  };
  const demo = () => pick('demo', async () => demoInput(startTick), 'demo failed');
  const live = (kind: string, name: string, open: () => Promise<MediaStream>) => pick(kind, async () => {
    const input: Input = liveInput(await open(), name, () => { if (active === input) demo().then(() => { note.textContent = `${name} ended`; }); });
    return input;
  }, `${name} failed`);
  file.onchange = () => {
    const list = [...(file.files ?? [])];
    file.value = '';
    if (!list.length) return;
    player ??= new Player();
    if (!player.setFiles(list)) { note.textContent = 'no audio file there'; return; }
    const p = player, mine = asked + 1, say = (s: string) => { if (mine === asked) note.textContent = s; };
    pick('file', async () => {
      const input = await fileInput(p, (x) => say(`analyzing ${(x * 100) | 0}%`), () => say('tap to start the sound'));
      say(p.names[0]);
      return input;
    }, 'file failed');
  };
  for (const [kind, text, run] of [
    ['demo', 'demo track', demo],
    ['mic', 'mic', () => live('mic', 'mic', openMic)],
    ['share', 'tab / system audio', () => live('share', 'shared audio', openShare)],
    ['file', 'audio file', () => file.click()],
  ] as const) {
    if (kind === 'share' && !canShare()) continue;
    const b = document.createElement('button'); b.textContent = text; b.onclick = () => { run(); };
    buttons.set(kind, b); el.append(b);
  }
  el.append(note, file);
  document.body.append(el);
  press('demo');
  return el;
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
  let input = demoInput(startTick), tickNow = startTick;
  const cyc = (): Cycle => ({ ids, trans: trans || 'random', beats, scores });
  const idxOf = (id: string) => Math.max(0, ids.indexOf(id));
  /** stop= stills count the cycle from time 0; otherwise it starts on `scene`. */
  let anchor: Anchor = qs.has('stop') ? ZERO : holdAt(startTick, idxOf(current), beats);
  /** A newly picked length waiting for the next switch. */
  let pending: { beats: number; anchor: Anchor } | null = null;
  const applyLen = () => { if (pending) beats = pending.beats; pending = null; };
  /** Vote scores weighting `random`: new ones apply from the next switch, so a running effect never changes. */
  let latestScores: Record<string, number> = {}, scores = latestScores, scoredSwitch = NaN;
  const schedAt = (tick: number): SceneSched | undefined => {
    if (!trans || grid) return undefined;
    if (pending && tick >= pending.anchor.at) { anchor = pending.anchor; applyLen(); }
    if (oneShotAt !== null) return step(cyc(), 0, current, ids[(idxOf(current) + 1) % ids.length], oneShotAt);
    const n = switchAt(cyc(), anchor, tick);
    if (n !== scoredSwitch) { scores = latestScores; scoredSwitch = n; }
    return cycleSched(cyc(), anchor, tick);
  };
  const shownId = () => cells[0].engine.scene.def.id;
  const tsel = document.createElement('select');
  tsel.add(new Option('no transitions', ''));
  tsel.add(new Option('auto: random effects', 'random'));
  tsel.add(new Option('auto: all effects', 'all'));
  for (const t of transitions()) tsel.add(new Option(`auto: ${t.name}`, t.id));
  tsel.value = trans;
  const setTrans = (t: GalleryTrans) => {
    if (!trans || !t) applyLen();
    if (!trans && t) { current = shownId(); anchor = holdAt(tickNow, idxOf(current), beats); } // cycle on from here
    else if (trans && !t) current = shownId(); // stay on what's showing
    trans = t; tsel.value = t;
    if (t) grid = false;
    try { const u = new URL(location.href); t === 'random' ? u.searchParams.delete('trans') : u.searchParams.set('trans', t || 'off'); history.replaceState(null, '', u); } catch { /* sandboxed */ }
    layout();
  };
  tsel.onchange = () => setTrans(tsel.value as GalleryTrans);
  const lsel = document.createElement('select');
  lsel.title = 'transition length (beats)';
  for (const b of [...new Set<number>([...TRANS_BEATS.filter((b) => b > 0), beats])].sort((a, b) => a - b)) lsel.add(new Option(b === 0.5 ? '½' : String(b), String(b))); // no 0: the effect list has `cut`
  lsel.value = String(beats);
  lsel.onchange = () => {
    const next = +lsel.value;
    try { localStorage.setItem('gallery.tlen', lsel.value); } catch { /* private mode */ }
    try { const u = new URL(location.href); if (u.searchParams.has('len')) { u.searchParams.set('len', lsel.value); history.replaceState(null, '', u); } } catch { /* sandboxed */ }
    if (trans && oneShotAt === null) pending = { beats: next, anchor: retime(cyc(), anchor, tickNow) };
    else beats = next;
  };
  const votes = votePanel(
    () => (grid || !hud ? null : { id: cells[0].engine.scene.def.id, name: cells[0].engine.scene.def.name }),
    (s) => { if (!qs.has('at') && !qs.has('stop')) latestScores = s; }, // stills repeat, votes or not
  );
  /** The tick space starts over (new input, looped file): sims replay, the cycle carries on from the scene showing. */
  const restart = (tick: number) => {
    const n = switchAt(cyc(), anchor, tickNow) + 1;
    applyLen();
    anchor = holdAt(tick, idxOf(shownId()), beats, n);
    tickNow = tick;
    for (const c of cells) c.engine.invalidate(-Infinity);
  };
  const picker = inputPanel((next) => {
    input.stop(); input = next;
    restart(Math.floor(input.tick(performance.now())));
  });
  autoHideUi(() => [bar, document.getElementById('vote'), picker]);
  /** The next / previous scene in tab order, with the current transition. Not in the grid. */
  const stepScene = (by: -1 | 1) => { if (!grid) go(ids[mod(idxOf(shownId()) + by, ids.length)]); };
  toggleUiOnDoubleTap((el) => el === stage || el.matches('#stage .cell, #stage canvas'), (x) => {
    const zone = tapZone(x, innerWidth);
    if (zone) stepScene(zone);
  });
  /** The tab pressed and the scene voted on follow what's showing (the cycle moves it). */
  let marked = '';
  const mark = () => {
    marked = shownId();
    for (const b of bar.querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.id === (grid ? 'grid' : marked)));
    votes.show();
  };

  const layout = () => {
    stage.classList.toggle('grid', grid);
    cells.forEach((c, i) => {
      c.cell.classList.toggle('hide', !grid && i > 0);
      c.engine.setScene(grid ? i : current);
      c.engine.transition = null;
      c.tag.textContent = grid ? c.engine.scene.def.name : '';
    });
    $('hud').classList.toggle('hide', !info); bar.classList.toggle('hide', !hud);
    picker.classList.toggle('hide', !hud || qs.has('stop'));
    mark();
  };
  const go = (id: string) => {
    if (id === 'grid') grid = !grid;
    else {
      // while cycling, switch to the picked scene with a transition and carry on from it
      const n = switchAt(cyc(), anchor, tickNow);
      applyLen();
      if (trans && !grid) anchor = { at: tickNow, n: n + 1, idx: idxOf(id), prev: idxOf(shownId()) };
      else if (trans) anchor = holdAt(tickNow, idxOf(id), beats, anchor.n);
      grid = false; current = id;
    }
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
  bar.append(tsel, lsel);
  addEventListener('keydown', (e) => {
    if (e.key === 'h' && document.body.classList.contains('ui-off')) document.body.classList.remove('ui-off'); // hidden by double-tap: h brings it back
    else if (e.key === 'h') { hud = !hud; layout(); }
    else if (e.key === 'i') { info = !info; layout(); }
    else if (e.key === 'g') go('grid');
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      // a focused selector keeps its arrows; Alt / Cmd + arrow stays the browser's back / forward
      if (!(e.target instanceof HTMLSelectElement) && !e.altKey && !e.ctrlKey && !e.metaKey) stepScene(e.key === 'ArrowLeft' ? -1 : 1);
    }
    else if (e.key === 't') { const opts: GalleryTrans[] = ['', 'random', 'all', ...transIds()]; setTrans(opts[mod(opts.indexOf(trans) + (e.shiftKey ? -1 : 1), opts.length)]); }
    else if (+e.key >= 1 && +e.key <= ids.length) go(ids[+e.key - 1]);
    else if (e.key === '+' || e.key === '=') votes.send(1);
    else if (e.key === '-' || e.key === '_') votes.send(-1);
    else if ((e.key === TRANS_KEYS.up || e.key === TRANS_KEYS.down) && !e.repeat && !e.ctrlKey && !e.metaKey) votes.voteTrans(e.key === TRANS_KEYS.up ? 1 : -1);
  });
  layout();

  const fstats = new FrameStats();
  const loop = () => {
    const now = performance.now();
    const tF = input.tick(now);
    let tick = Math.min(Math.floor(tF), stopTick), sub = interp && tick < stopTick ? Math.floor((tF - Math.floor(tF)) * 256) : 0;
    if (tick < tickNow - FPS / 2) restart(tick); // a looping file started over
    else if (tick < tickNow) { tick = tickNow; sub = 0; } // an audio clock resync: hold rather than rewind
    tickNow = tick;
    const active = grid ? cells : cells.slice(0, 1);
    const sched = schedAt(tick);
    const hashes = active.map((c, i) => c.engine.frame(tick, input.F, undefined, i === 0 ? sched : undefined, sub));
    fstats.frame(performance.now(), grid ? null : cells[0].engine.transition?.type ?? null);
    if (marked !== shownId()) mark();
    if (sched) votes.trans.ran(ranTransition(sched, tick));
    if (info) {
      const sc = cells[0].engine.scene;
      $('hud').textContent = [
        `${grid ? 'grid' : sc.def.name}  ·  ${input.label(tick)}`,
        `tick ${tick}  hash ${hashes.join(' ')}`,
        trans && !grid ? `transitions: ${trans === 'all' || trans === 'random' ? trans : transName(trans)} ${beats} beats  ·  ${(() => {
          const tr = cells[0].engine.transition;
          return tr ? `${transName(tr.type)} ${tr.from}→${tr.to} ${((tr.p16 / 65536) * 100) | 0}%` : 'between';
        })()}` : null,
        !grid && sc.status ? sc.status() : null,
        `keys: + - vote scene  ·  ${TRANS_KEYS.up} ${TRANS_KEYS.down} vote transition  ·  ← → scene  ·  t transition  ·  g grid  ·  h UI  ·  i info`,
        `${fstats.line(transName)}  ·  WebGPU ${gpu.adapterInfo}`,
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
