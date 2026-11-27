// Scene gallery: every scene driven by the synthetic demo track, or by an input (mic, tab / system audio, an
// audio file; analyzed in the page), no server needed. The ☰ button (key `o`) opens the picker
// (gallerysheet.ts): scenes, rotation and transitions, input, the scene's variants, display. Double-tap or
// double-click the picture to hide / show the UI. A single tap or click on its right / left third (also
// with the UI hidden), or the right / left arrow key, goes to the next / previous scene.
// URL params:
//   scene=radial|tunnel|scope|flow|<lab scene id>   which scene (default radial)
//   grid=1                           all four at once
//   start=<s>                        demo-track time to start at (default 0)
//   stop=<s>                         stop rendering at this demo time (for screenshots); sets window.__done
//   hud=0                            hide the controls; hud=1 also shows the info text (key `i`)
//   rot=weighted|order|liked|stay    which scene comes next: random weighted by votes (the default), list
//                                    order (the default with stop= or at=), liked ones only, or none
//   trans=random|<effect>|all|off    the effect of each switch: random (the default), one effect, or all
//                                    in order (key `t`); off (or none) = rot=stay unless rot= says
//                                    otherwise. With stop= or at= the default is off, and a stop= cycle
//                                    counts from the first scene at time 0
//   hold=<bars>                      bars each scene of the cycle shows alone between transitions
//                                    (rounded up so switches stay on bars). Default by len=: up to 2
//                                    beats a switch every 4 bars, 4: every 3, 8: every 4, 16: every 6
//   at=<s>                           with trans: one transition from `scene` to the next at demo
//                                    time s instead of the cycle (for stills: add stop=<s>)
//   len=<beats>                      transition length (default: the picker's speed choice,
//                                    remembered per device, else 8; stills ignore the remembered one)
//   interp=0                         whole ticks only (no display-rate interpolation)
//   t=<token>                        room token, for voting through the server (remembered like the app's)
// Voting: 👍/👎 for the scene shown (keys + / -) and the last transition, posted to the server's /vote. A
// static build without the server shows the panel disabled.
import { initGpu } from './gpu/gpu.ts';
import { Engine } from './engine.ts';
import { FrameStats } from './framestats.ts';
import { restartControl } from './restart.ts';
import { FPS } from '../core/constants.ts';
import { ranTransition, type SceneSched } from '../core/protocol.ts';
import './transitions.ts'; // installs the transition registry (lab/transitions/)
import { transIds, transName } from '../core/transitions.ts';
import { autoHideUi } from './idle.ts';
import { tapZone, toggleUiOnDoubleTap } from './doubletap.ts';
import { galleryBeats, galleryHold, galleryRot, galleryTrans } from './defaults.ts';
import { TRANS_KEYS, stepButton, transRow } from './transvote.ts';
import { ZERO, change, cycleSched, holdAt, pickScene, step, switchAt, type Cycle, type Run, type Settings } from './cycle.ts';
import { demoInput, fileInput, liveInput, type Input } from './inputs.ts';
import { canShare, insecure, micError, openMic, openShare, shareVideoBox, type LiveSource } from './capture.ts';
import { mediaPicker } from './mediapicker.ts';
import { MEDIA } from './media.ts';
import { ACCEPT, Player } from './player.ts';
import { sceneTags, stepChoice, type SceneItem } from './pickerlist.ts';
import { pickerSheet } from './gallerysheet.ts';
import { REGISTRY } from './graph/registry.ts';

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
/** Whether the URL asks for transitions at all (`at=` shows one only then). */
const urlTrans = galleryTrans(qs);
const hold = galleryHold(qs);
const oneShotAt = qs.has('at') ? Math.round(+qs.get('at')! * FPS) : null;

const lsGet = (k: string) => { try { return localStorage.getItem(k); } catch { return null; } };
/** Transition length in beats. Its own key: the app's `tlen` would also count as a choice for the room. */
let beats = galleryBeats(qs, lsGet('gallery.tlen'));
const token = qs.get('t') ?? lsGet('token') ?? '';
if (qs.get('t')) try { localStorage.setItem('token', qs.get('t')!); } catch { /* private mode */ }
const withToken = (p: string) => (token ? `${p}?t=${encodeURIComponent(token)}` : p);

/**
 * The vote panel: 👍/👎 and prev / next for the scene shown, and under it the transition row, votes posted
 * to the server. `scored`: the scene and transition scores, whenever they arrive or change.
 */
function votePanel(
  sceneOf: () => { id: string; name: string; evolve?: unknown } | null, stepScene: (by: -1 | 1) => void,
  stepTrans: (by: -1 | 1) => void, scored: (scenes: Record<string, number>, trans: Record<string, number>) => void,
) {
  const el = document.createElement('div'); el.id = 'vote';
  const row = document.createElement('div'); row.className = 'srow';
  const label = document.createElement('span'), up = document.createElement('button'), down = document.createElement('button');
  const note = document.createElement('span'); note.className = 'note';
  up.className = 'up'; up.textContent = '👍'; up.title = 'vote up (+)'; down.textContent = '👎'; down.title = 'vote down (-)';
  const post = async (body: object) => {
    const r = await fetch(withToken('/vote'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const j = await r.json() as { score?: number; retired?: boolean; error?: string };
    if (!r.ok || j.score === undefined) throw new Error(j.error ?? String(r.status));
    return { score: j.score, retired: j.retired };
  };
  const trans = transRow(async (t, vote) => {
    try {
      const j = await post({ transition: t.type, from: t.from, to: t.to, beats: t.beats, vote, tags: [] });
      transScores = { ...transScores, [t.type]: j.score };
      trans.saved(`${vote > 0 ? '👍' : '👎'} saved ${transName(t.type)}`);
      scored(scores, transScores);
    } catch (e) { trans.note(`vote failed: ${(e as Error).message}`); }
    show();
  }, stepTrans);
  row.append(label, up, down, stepButton(-1, 'previous scene (←)', stepScene), stepButton(1, 'next scene (→)', stepScene), note);
  el.append(row, trans.el);
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
  /** Scores from the server: on load, and again once a restarted server is back. */
  const load = () => fetch(withToken('/scores')).then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
    .then((j: { scores: Record<string, number>; live: string[]; transScores?: Record<string, number> }) => { scores = j.scores; live = j.live; transScores = j.transScores ?? {}; online = true; scored(scores, transScores); show(); })
    .catch(() => { online = false; show(); });
  load();
  const send = async (vote: 1 | -1) => {
    const sc = sceneOf(), id = sc?.id;
    if (!id || !online) return;
    try {
      // an evolving scene: the state on screen goes with the vote (the digest learns which mutations are liked)
      const j = await post({ scene: id, vote, tags: [], ...(sc.evolve ? { evolve: sc.evolve } : {}) });
      scores = { ...scores, [id]: j.score };
      if (j.retired) live = live.filter((x) => x !== id); else if (!live.includes(id)) live.push(id);
      note.textContent = `${vote > 0 ? '👍' : '👎'} saved ${sc.name}`;
      scored(scores, transScores);
    } catch (e) { note.textContent = `vote failed: ${(e as Error).message}`; }
    show();
  };
  up.onclick = () => send(1); down.onclick = () => send(-1);
  /** Key votes count only while the panel is on screen. */
  const voteTrans = (v: 1 | -1) => { if (sceneOf()) trans.vote(v); };
  return { el, show, send, voteTrans, trans, load, online: () => online };
}

/** The input picker. `change` takes over each newly opened input; `say` mirrors its status text. */
function inputPanel(change: (i: Input) => void, say: (text: string) => void) {
  const el = document.createElement('div'); el.id = 'input';
  const note = document.createElement('span'); note.className = 'note';
  const tell = (t: string) => { note.textContent = t; say(t); };
  const file = document.createElement('input'); file.type = 'file'; file.accept = ACCEPT; file.multiple = true; file.hidden = true; // multiple: a track and its .lrc
  let player: Player | null = null, asked = 0, active: Input | null = null;
  const buttons = new Map<string, HTMLButtonElement>();
  const press = (kind: string) => { for (const [k, b] of buttons) b.setAttribute('aria-pressed', String(k === kind)); };
  /** Open an input; a later pick wins over one still opening, and a failure keeps the current one. */
  const pick = async (kind: string, open: () => Promise<Input>, failed: string) => {
    const mine = ++asked;
    tell('');
    try {
      const input = await open();
      if (mine !== asked) return input.stop();
      change(active = input); press(kind);
    } catch (e) {
      const err = e as Error;
      if (mine === asked) tell(kind === 'mic' ? micError(err, insecure(), navigator)
        : err.name === 'NotAllowedError' && kind === 'share' ? '' : `${failed}: ${err.message}${kind === 'file' ? '' : insecure()}`);
    }
  };
  const demo = () => pick('demo', async () => demoInput(startTick), 'demo failed');
  const live = (kind: string, name: string, open: () => Promise<LiveSource>) => pick(kind, async () => {
    const input: Input = liveInput(await open(), name, () => { if (active === input) demo().then(() => tell(`${name} ended`)); });
    return input;
  }, `${name} failed`);
  file.onchange = () => {
    const list = [...(file.files ?? [])];
    file.value = '';
    if (!list.length) return;
    player ??= new Player();
    if (!player.setFiles(list)) { tell('no audio file there'); return; }
    const p = player, mine = asked + 1, progress = (s: string) => { if (mine === asked) tell(s); };
    pick('file', async () => {
      const input = await fileInput(p, (x) => progress(`analyzing ${(x * 100) | 0}%`), () => progress('tap to start the sound'));
      progress(p.names[0]);
      return input;
    }, 'file failed');
  };
  const shareVideo = shareVideoBox();
  for (const [kind, text, run] of [
    ['demo', 'demo track', demo],
    ['mic', 'mic', () => live('mic', 'mic', openMic)],
    ['share', 'tab / system audio', () => live('share', 'shared audio', () => openShare(shareVideo.box.checked))],
    ['file', 'audio file', () => file.click()],
  ] as const) {
    if (kind === 'share' && !canShare()) continue;
    const b = document.createElement('button'); b.textContent = text; b.onclick = () => { run(); };
    buttons.set(kind, b); el.append(b);
    if (kind === 'share') el.append(shareVideo.el);
  }
  // pictures: image / video files or the camera; a video's sound can take over as the input
  const media = mediaPicker({ sound: (v) => { live('video', 'video sound', async () => v); }, note: tell });
  el.append(media, note, file);
  press('demo');
  return el;
}

async function main() {
  const gpu = await initGpu();
  const stage = $('stage');
  const cells = Array.from({ length: 4 }, () => {
    const cell = document.createElement('div'); cell.className = 'cell';
    const cv = document.createElement('canvas'), tag = document.createElement('div'); tag.className = 'tag';
    cell.append(cv, tag); stage.append(cell);
    return { cell, tag, engine: new Engine(gpu, cv) };
  });
  const ids = cells[0].engine.scenes.map((s) => s.def.id);
  let input = demoInput(startTick), tickNow = startTick;
  const stills = qs.has('stop') || qs.has('at');
  /** Vote scores weighting `random` and the rotation. A new effect weighting applies from the next switch, so a running effect never changes. */
  let latestScores: Record<string, number> = {}, scores = latestScores, scoredSwitch = NaN, sceneScores: Record<string, number> = {};
  /** Varies the weighted walk between page loads; stills repeat. */
  const seed = stills ? 0 : (Math.random() * 2 ** 31) | 0;
  const cycleOf = (s: Settings): Cycle => {
    const rot = s.rot;
    return {
      ids, trans: s.trans, beats: s.beats, hold: s.hold, scores, stay: rot === 'stay',
      pick: rot === 'weighted' || rot === 'liked' ? (prev, n) => pickScene(rot, ids, sceneScores, prev, n, seed) : undefined,
    };
  };
  const idxOf = (id: string) => Math.max(0, ids.indexOf(id));
  const first: Settings = { rot: galleryRot(qs), trans: urlTrans || 'random', beats, hold };
  /** stop= stills count the cycle from time 0; otherwise it starts on `scene`. */
  let run: Run = { s: first, anchor: qs.has('stop') && first.rot !== 'stay' ? ZERO : holdAt(startTick, idxOf(current), beats), pending: null };
  const cyc = () => cycleOf(run.s);
  const chosen = () => run.pending?.s ?? run.s;
  const applyPending = () => { if (run.pending) run = { ...run, s: run.pending.s, pending: null }; };
  const oneShot = oneShotAt !== null && urlTrans !== '';
  const schedAt = (tick: number): SceneSched | undefined => {
    if (grid) return undefined;
    if (run.pending && tick >= run.pending.from) run = { s: run.pending.s, anchor: run.pending.anchor, pending: null };
    if (oneShot) return step(cyc(), 0, current, ids[(idxOf(current) + 1) % ids.length], oneShotAt!);
    const n = switchAt(cyc(), run.anchor, tick);
    if (n !== scoredSwitch) { scores = latestScores; scoredSwitch = n; }
    return cycleSched(cyc(), run.anchor, tick);
  };
  const shownId = () => cells[0].engine.scene.def.id;
  /** The URL keeps the scene and the settings, so a reload stays on them. */
  const settingsUrl = (u: URL) => {
    const s = chosen(), set = (k: string, v: string | null) => (v === null ? u.searchParams.delete(k) : u.searchParams.set(k, v));
    set('scene', current); set('grid', grid ? '1' : null);
    set('trans', s.trans === 'random' ? null : s.trans);
    set('rot', s.rot === 'weighted' ? null : s.rot);
    set('hold', s.hold === undefined ? null : String(s.hold));
    return u;
  };
  const saveUrl = () => { try { history.replaceState(null, '', settingsUrl(new URL(location.href))); } catch { /* sandboxed frames may refuse */ } };
  const showNext = () => { const t = chosen().trans; votes.trans.next(t === 'random' ? 'random' : t === 'all' ? 'all, in order' : transName(t)); };
  const set = (patch: Partial<Settings>) => {
    if (patch.beats !== undefined) {
      try { localStorage.setItem('gallery.tlen', String(patch.beats)); } catch { /* private mode */ }
      try { const u = new URL(location.href); if (u.searchParams.has('len')) { u.searchParams.set('len', String(patch.beats)); history.replaceState(null, '', u); } } catch { /* sandboxed */ }
    }
    const leaveGrid = grid && patch.rot !== undefined && patch.rot !== 'stay';
    if (oneShot) run = { ...run, s: { ...run.s, ...patch } };
    else run = change(cycleOf, run, patch, tickNow);
    if (leaveGrid) { grid = false; layout(); }
    saveUrl(); showNext();
  };
  /** A scene whose section or evolve step the picker holds. */
  let held: string | null = null;
  const release = () => { if (held !== null) cells[0].engine.scenes.find((s) => s.def.id === held)?.force(null); held = null; };
  /** Hold the shown scene on variant `to` (a force index), blending from `from`. */
  const holdVariant = (from: number, to: number) => {
    release();
    const sc = cells[0].engine.scene;
    sc.force([{ at: -1e9, idx: from }, { at: tickNow, idx: to }]);
    held = sc.def.id;
  };
  const votes = votePanel(
    () => (grid || !hud ? null : { id: cells[0].engine.scene.def.id, name: cells[0].engine.scene.def.name, evolve: cells[0].engine.scene.evolve() ?? undefined }),
    (by) => stepScene(by),
    (by) => set({ trans: stepChoice(['random', ...transIds()], chosen().trans, by) }),
    (sc, tr) => { if (!stills) { sceneScores = sc; latestScores = tr; } sheet.refresh(); }, // stills repeat, votes or not
  );
  /** The tick space starts over (new input, looped file): sims replay, the cycle carries on from the scene showing. */
  const restart = (tick: number) => {
    const n = switchAt(cyc(), run.anchor, tickNow) + 1;
    applyPending();
    run = { ...run, anchor: holdAt(tick, idxOf(shownId()), run.s.beats, n) };
    tickNow = tick;
    release();
    for (const c of cells) c.engine.invalidate(-Infinity);
  };
  // ---- controls: the picker button and its status line top left, the vote panel bottom right ----
  const tools = document.createElement('div'); tools.id = 'tools';
  const menu = document.createElement('button'); menu.id = 'menu'; menu.textContent = '☰ picker'; menu.title = 'scenes, transitions, input, display (o)';
  const status = document.createElement('span'); status.id = 'status';
  menu.onclick = () => sheet.open();
  tools.append(menu, status);
  document.body.append(tools);
  const inputEl = inputPanel((next) => {
    input.stop(); input = next;
    restart(Math.floor(input.tick(performance.now())));
  }, (t) => { status.textContent = t; });
  autoHideUi(() => [tools, votes.el]);
  /** The next / previous scene in list order, with the current transition. Not in the grid. */
  const stepScene = (by: -1 | 1) => { if (!grid) go(stepChoice(ids, shownId(), by)); };
  toggleUiOnDoubleTap((el) => el === stage || el.matches('#stage .cell, #stage canvas'), (x) => {
    const zone = tapZone(x, innerWidth);
    if (zone) stepScene(zone);
  });
  /** The picker and the scene voted on follow what's showing (the cycle moves it). */
  let marked = '';
  const mark = () => {
    marked = shownId();
    votes.show();
    sheet.refresh();
  };

  const layout = () => {
    stage.classList.toggle('grid', grid);
    cells.forEach((c, i) => {
      c.cell.classList.toggle('hide', !grid && i > 0);
      c.engine.setScene(grid ? i : current);
      c.engine.transition = null;
      c.tag.textContent = grid ? c.engine.scene.def.name : '';
    });
    $('hud').classList.toggle('hide', !info);
    tools.classList.toggle('hide', !hud || qs.has('stop'));
    mark();
  };
  const go = (id: string) => {
    if (id === 'grid') grid = !grid;
    else if (grid || id !== shownId()) {
      // switch to the picked scene with a transition and carry on from it
      const n = switchAt(cyc(), run.anchor, tickNow), from = idxOf(shownId());
      applyPending();
      run = { ...run, anchor: grid ? holdAt(tickNow, idxOf(id), run.s.beats, n) : { at: tickNow, n: n + 1, idx: idxOf(id), prev: from } };
      grid = false; current = id;
    }
    saveUrl();
    layout();
  };
  const tags = new Map(cells[0].engine.scenes.map((s) => [s.def.id, sceneTags(s.graph, (p) => REGISTRY.get(p)?.manifest.tags ?? [])]));
  const sheet = pickerSheet({
    scenes: (): SceneItem[] => cells[0].engine.scenes.map(({ graph: g }) => ({
      id: g.id, name: g.name, vendor: g.author.vendor, tags: tags.get(g.id) ?? [], created: g.created ?? '', score: sceneScores[g.id] ?? 0,
    })),
    online: () => votes.online(),
    transScore: (id) => latestScores[id] ?? 0,
    shown: shownId,
    go,
    settings: chosen,
    change: set,
    input: inputEl,
    restart: restartControl(withToken, () => votes.load()),
    now: () => {
      const sc = cells[0].engine.scene;
      return { id: sc.def.id, name: sc.def.name, sections: sc.graph.sections ? [...sc.sections] : [], section: sc.section(), evolve: sc.evolve(), held: held === sc.def.id };
    },
    nextStep: () => {
      const k = cells[0].engine.scene.evolve()?.step;
      if (k !== undefined) holdVariant(k - 1, k); // force index k = step k + 1
    },
    forceSection: (id) => {
      const sc = cells[0].engine.scene, at = (s: string) => sc.sections.indexOf(s) - 1; // -1 = base
      holdVariant(at(sc.section()?.id ?? id), at(id));
    },
    release,
    info: () => info,
    setInfo: (on) => { info = on; layout(); },
    grid: () => grid,
    toggleGrid: () => go('grid'),
    link: () => {
      const u = settingsUrl(new URL(location.href));
      for (const k of ['t', 'start', 'stop', 'at', 'hud', 'grid']) u.searchParams.delete(k); // never the room token
      u.searchParams.set('scene', shownId()); u.searchParams.set('len', String(chosen().beats));
      return u.href;
    },
  });
  addEventListener('keydown', (e) => {
    // typing in the picker (search, a link to copy) is not a shortcut
    if (e.target instanceof HTMLInputElement && e.target.type !== 'checkbox') return;
    if (e.key === 'o' || e.key === '/') { e.preventDefault(); sheet.open(); }
    else if (e.key === 'h' && document.body.classList.contains('ui-off')) document.body.classList.remove('ui-off'); // hidden by double-tap: h brings it back
    else if (e.key === 'h') { hud = !hud; layout(); }
    else if (e.key === 'i') { info = !info; layout(); }
    else if (e.key === 'g') go('grid');
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      // a focused selector keeps its arrows; Alt / Cmd + arrow stays the browser's back / forward
      if (!(e.target instanceof HTMLSelectElement) && !e.altKey && !e.ctrlKey && !e.metaKey) stepScene(e.key === 'ArrowLeft' ? -1 : 1);
    }
    else if (e.key.toLowerCase() === 't') set({ trans: stepChoice(['random', 'all', ...transIds()], chosen().trans, e.shiftKey ? -1 : 1) });
    else if (+e.key >= 1 && +e.key <= ids.length) go(ids[+e.key - 1]);
    else if (e.key === '+' || e.key === '=') votes.send(1);
    else if (e.key === '-' || e.key === '_') votes.send(-1);
    else if ((e.key === TRANS_KEYS.up || e.key === TRANS_KEYS.down) && !e.repeat && !e.ctrlKey && !e.metaKey) votes.voteTrans(e.key === TRANS_KEYS.up ? 1 : -1);
  });
  layout();
  showNext();

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
    const shownTrans = cells[0].engine.transition;
    if (held !== null && held !== shownId() && held !== shownTrans?.from && held !== shownTrans?.to) release();
    if (marked !== shownId()) mark();
    if (sched) votes.trans.ran(ranTransition(sched, tick));
    if (info) {
      const sc = cells[0].engine.scene;
      $('hud').textContent = [
        `${grid ? 'grid' : sc.def.name}  ·  ${input.label(tick)}`,
        `tick ${tick}  hash ${hashes.join(' ')}`,
        !grid ? `rotation: ${run.s.rot}  ·  transitions: ${run.s.trans === 'all' || run.s.trans === 'random' ? run.s.trans : transName(run.s.trans)} ${run.s.beats} beats  ·  ${(() => {
          const tr = cells[0].engine.transition;
          return tr ? `${transName(tr.type)} ${tr.from}→${tr.to} ${((tr.p16 / 65536) * 100) | 0}%` : 'between';
        })()}` : null,
        !grid && sc.status ? sc.status() : null,
        MEDIA.shareLine(),
        `keys: + - vote scene  ·  ${TRANS_KEYS.up} ${TRANS_KEYS.down} vote transition  ·  ← → scene  ·  o picker  ·  t transition  ·  g grid  ·  h UI  ·  i info`,
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
