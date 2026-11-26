// Synced app page. The server owns the room state (mode, scene schedule, presets, views); this
// page renders it through WebGPU on the shared tick and relays this host's inputs as events.
import { CC_PARAMS, FPS, INSTRUMENT_DELAY, LIVE_DELAY, K_BAR, K_BPM, K_PHASE, N_PARAMS } from '../core/constants.ts';
import { fileSource, mapSource, silence, type FeatureSource } from '../core/features.ts';
import { EventLog, withEvents } from '../core/events.ts';
import {
  modeTick, modeTickF, fixedScene, flowNAt, sceneAt, FLOW_N_DEFAULT, DEFAULT_PRESETS, DEFAULT_GRID, TRANS_BEATS, AUTO_BARS, DEFAULT_TRANS_BEATS,
  type ClientMsg, type Quant, type RoomState, type SceneStep, type ServerMsg, type TransType,
} from '../core/protocol.ts';
import './transitions.ts'; // installs the transition registry (lab/transitions/)
import { transName, transitions } from '../core/transitions.ts';
import { initGpu } from './gpu/gpu.ts';
import { VIEWS } from '../core/post.ts';
import { Engine } from './engine.ts';
import { MidiRelay } from './midi.ts';
import { ACCEPT, Player } from './player.ts';
import { DebugPanel, Rate, type Counters } from './debug.ts';
import { PadRelay } from './pads.ts';
import { fxAt, PAD_COLORS, type Fx } from '../core/fx.ts';
import { parseLrc } from '../core/lrc.ts';
import { autoHideUi } from './idle.ts';
import { toggleUiOnDoubleTap } from './doubletap.ts';
import { LiveAnalyzer, canShare, insecure, micError, openMic, openShare } from './capture.ts';
import { mainTrans, restoreAuto } from './defaults.ts';

/** Debug/test hook: recent tick -> scene-state hash, so tools can compare hosts at equal ticks. */
declare global {
  interface Window {
    __ek?: {
      hashes: Map<number, string>; scene: string; view: number; events: number; wave?: boolean;
      /** Transition drawn on the last frame ('' = none), and every type drawn since load. */
      trans: string; transSeen: string[];
    };
  }
}

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const lsGet = (k: string) => { try { return localStorage.getItem(k); } catch { return null; } };
const lsSet = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } };
const msg = (s: string) => { $('msg').textContent = s; };

const qs = new URLSearchParams(location.search);
// Room token: from the join URL (?t=), remembered for reloads. Prod also gets a cookie; the Vite
// dev server doesn't, so it's sent explicitly on every request.
const token = qs.get('t') ?? lsGet('token') ?? '';
if (qs.get('t')) lsSet('token', qs.get('t')!);
const withToken = (path: string) => `${path}${path.includes('?') ? '&' : '?'}t=${encodeURIComponent(token)}`;

// Per-host settings: display-latency trim, name, default view.
let offsetMs = +(qs.get('offset') ?? lsGet('offset') ?? 0);
const offIn = $<HTMLInputElement>('off');
offIn.value = String(offsetMs);
offIn.oninput = () => { offsetMs = +offIn.value || 0; lsSet('offset', String(offsetMs)); };
const hostName = qs.get('name') ?? lsGet('name') ?? `host-${Math.random().toString(36).slice(2, 6)}`;
lsSet('name', hostName);
/** Display-rate interpolation between ticks (?interp=0 shows whole ticks only, for comparison). */
const interp = qs.get('interp') !== '0';
const defaultView = Math.max(0, Math.min(VIEWS.length - 1, +(qs.get('view') ?? 0) | 0));

// ---- connection, clock sync (NTP-style, min-RTT of last 20 samples) ----
/** This host's flow particle capability once measured (or forced with ?cap=), re-sent on every connect. */
let benchN: number | null = null;
let ws: WebSocket | null = null, clockOff = 0, rtt = 0, me = 0;
const samples: { rtt: number; off: number }[] = [];
const sNow = () => performance.now() + clockOff;
const net: Counters & { connects: number; lateEvents: number; liveGaps: number; lateFrames: number; lastPong: number } =
  { msgsIn: 0, bytesIn: 0, msgsOut: 0, bytesOut: 0, connects: 0, lateEvents: 0, liveGaps: 0, lateFrames: 0, lastPong: 0 };
const send = (m: ClientMsg) => {
  if (ws?.readyState !== 1) return;
  const s = JSON.stringify(m); ws.send(s); net.msgsOut++; net.bytesOut += s.length;
};
const sendBin = (d: Uint8Array<ArrayBuffer>) => { if (ws?.readyState === 1) { ws.send(d); net.msgsOut++; net.bytesOut += d.length; } };
function pingBurst() { for (let i = 0; i < 5; i++) setTimeout(() => send({ t: 'ping', c: performance.now() }), i * 60); }

let room: RoomState = {
  mode: 'idle', epoch: -1, scene: fixedScene(DEFAULT_PRESETS[0]),
  presets: DEFAULT_PRESETS, grid: DEFAULT_GRID, hosts: [], clock: null, playlist: null,
  flow: { n: FLOW_N_DEFAULT, prev: FLOW_N_DEFAULT, at: 0 },
  scores: {}, auto: null,
};
let fileFeat: Uint8Array | null = null, frames = 0, lastTick = -Infinity;
const live = new Map<number, Uint8Array>();
const events = new EventLog();
const listeners = { state: [] as (() => void)[], lateEvent: [] as ((tick: number) => void)[], vote: [] as ((m: Extract<ServerMsg, { t: 'vote' }>) => void)[] };
/** This host's capture while it leads live mode; `pending` until the server confirms it. */
let leaderLive: { an: LiveAnalyzer; pending: boolean } | null = null;
/** This connection has offered the device's remembered auto-rotation to a fresh room. */
let autoRestored = false;

function connect() {
  ws = new WebSocket(withToken(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`));
  ws.binaryType = 'arraybuffer';
  ws.onopen = () => {
    net.connects++; autoRestored = false; samples.length = 0; pingBurst(); send({ t: 'hello', name: hostName }); msg('connected');
    if (benchN !== null) send({ t: 'bench', n: benchN });
  };
  ws.onclose = (e) => { msg(e.code === 1006 && !token ? 'not connected: open the join URL with ?t=' : 'disconnected, retrying'); setTimeout(connect, 1000); };
  ws.onmessage = (e) => {
    net.msgsIn++; net.bytesIn += typeof e.data === 'string' ? e.data.length : (e.data as ArrayBuffer).byteLength;
    if (typeof e.data !== 'string') {
      const u = new Uint8Array(e.data), dv = new DataView(e.data);
      if (u[0] === 1) {
        const tick = dv.getUint32(1, true);
        live.set(tick, u.slice(5));
        // past the render delay: the stateless scenes pick it up next frame, sims rewind and replay
        if (tick <= lastTick) { net.lateFrames++; listeners.lateEvent.forEach((f) => f(tick)); }
      }
      else if (u[0] === 2) { frames = dv.getUint32(1, true); fileFeat = u.slice(5); }
      return;
    }
    const m = JSON.parse(e.data) as ServerMsg;
    if (m.t === 'pong') {
      const t1 = performance.now();
      samples.push({ rtt: t1 - m.c, off: m.s - (m.c + t1) / 2 });
      if (samples.length > 20) samples.shift();
      const best = samples.reduce((a, b) => (b.rtt < a.rtt ? b : a));
      clockOff = best.off; rtt = best.rtt; net.lastPong = t1;
    } else if (m.t === 'welcome') me = m.you;
    else if (m.t === 'state') {
      const { t: _, ...s } = m;
      if (s.epoch !== room.epoch) { events.reset(); live.clear(); lastTick = -Infinity; }
      room = s;
      // a state sent before the server saw our 'live' must not cancel the capture we just started
      if (room.mode === 'live' && leaderLive) leaderLive.pending = false;
      else if (room.mode !== 'live' && !leaderLive?.pending) stopLeaderLive();
      if (room.mode !== 'file') { fileFeat = null; $<HTMLAudioElement>('au').pause(); }
      if (room.mode === 'file' && $<HTMLInputElement>('aud').checked) loadAudio();
      if (!autoRestored) {
        autoRestored = true;
        const restore = restoreAuto(room.auto, lsGet);
        if (restore) send(restore);
      }
      listeners.state.forEach((f) => f());
    } else if (m.t === 'log') {
      if (m.epoch === room.epoch) { events.reset(m.events); listeners.lateEvent.forEach((f) => f(-Infinity)); }
    } else if (m.t === 'ev') {
      events.add(m.ev);
      if (window.__ek) window.__ek.events++;
      if (m.ev.tick <= lastTick) { net.lateEvents++; listeners.lateEvent.forEach((f) => f(m.ev.tick)); } // arrived late: replay
    } else if (m.t === 'track') playIndex(m.index);
    else if (m.t === 'vote') listeners.vote.forEach((f) => f(m));
  };
}
connect();
setInterval(pingBurst, 3000);

// ---- leader: file(s) / folder ----
// The host that loads tracks owns the playlist: any host's prev/next is relayed to it, and it
// auto-advances at the end of each track, preparing the next one while the current one plays.
const player = new Player();
let playing = -1, advancing = false;
const fileIn = $<HTMLInputElement>('file'), folderIn = $<HTMLInputElement>('folder');
fileIn.accept = ACCEPT;
fileIn.onchange = () => loadFiles(fileIn.files);
folderIn.onchange = () => loadFiles(folderIn.files);
$('fileBtn').onclick = () => fileIn.click();
$('folderBtn').onclick = () => folderIn.click();

function loadFiles(list: FileList | null) {
  if (!list?.length) return;
  const n = player.setFiles(list);
  fileIn.value = ''; folderIn.value = '';
  if (!n) { msg('no audio files there'); return; }
  if (!audBox.checked) { audBox.checked = true; audBox.onchange?.(new Event('change')); } // the uploader usually wants to hear it
  playing = -1;
  playIndex(0);
}

async function playIndex(i: number, tries = 0): Promise<void> {
  const n = player.files.length;
  if (!n) return;
  i = ((i % n) + n) % n;
  const name = player.names[i], tag = n > 1 ? ` (${i + 1}/${n})` : '';
  try {
    const p = await player.prepare(i, (x) => msg(`analyzing ${name}${tag} ${(x * 100) | 0}%`));
    msg(`uploading ${name}${tag}`);
    await fetch(withToken('/track'), { method: 'POST', headers: { 'content-type': p.type }, body: p.bytes.slice(0) });
    sendBin(p.feat.slice());
    const lrc = await player.lyrics(i).catch(() => null), lyrics = lrc ? parseLrc(lrc) : [];
    send({ t: 'play', name, ...(lyrics.length ? { lyrics } : {}) });
    send({ t: 'playlist', names: player.names, index: i });
    player.index = playing = i;
    msg(`${name}${tag}: playing in 2.5 s`);
    if (n > 1) player.prepare((i + 1) % n).catch(() => {}); // ready before this one ends
  } catch (e) {
    msg((e as Error).message);
    if (n > 1 && tries < n - 1) return playIndex(i + 1, tries + 1);
  }
}

// auto-advance: the owner moves on once the track has ended everywhere
setInterval(() => {
  if (advancing || playing < 0 || room.mode !== 'file' || room.paused !== null || room.playlist?.owner !== me) return;
  if (modeTick(room, sNow()) < room.frames + 30) return;
  advancing = true;
  if (player.files.length > 1) playIndex(playing + 1).finally(() => { advancing = false; });
  else { send({ t: 'pause' }); advancing = false; }
}, 200);

// ---- leader: live (capture needs a secure context: localhost or https) ----
const delay = (t: number) => `${t}-tick delay, ${((t * 1000) / FPS).toFixed(0)} ms`;

/** Analyze `stream` on this host and stream features to the room as the live leader. */
/** `delay`: ticks every host renders behind (INSTRUMENT_DELAY for line-in, LIVE_DELAY for captured audio). */
function startLive(stream: MediaStream, label: string, delay: number) {
  stopLeaderLive();
  const an: LiveAnalyzer = new LiveAnalyzer(stream, () => { if (leaderLive?.an === an) { send({ t: 'stop' }); stopLeaderLive(); msg('capture ended'); } });
  leaderLive = { an, pending: true };
  send({ t: 'live', delay });
  msg(label);
}
function stopLeaderLive() {
  if (!leaderLive) return;
  leaderLive.an.close(); leaderLive = null;
}

$('live').onclick = async () => {
  try { startLive(await openMic(), `live: instrument / line-in (${delay(INSTRUMENT_DELAY)})`, INSTRUMENT_DELAY); }
  catch (e) { msg(micError(e as Error, insecure(), navigator)); }
};

$('capture').hidden = !canShare();
$('capture').onclick = async () => {
  try {
    const stream = await openShare();
    startLive(stream, `live: capturing "${stream.getAudioTracks()[0].label || 'tab/app audio'}" (${delay(LIVE_DELAY)})`, LIVE_DELAY);
  } catch (e) {
    if ((e as Error).name !== 'NotAllowedError') msg(`capture failed: ${(e as Error).message}${insecure()}`);
  }
};
setInterval(() => {
  if (!leaderLive || room.mode !== 'live') return;
  const cur = Math.floor(((sNow() - room.start) * FPS) / 1000);
  leaderLive.an.pull(cur, (tick, m) => { live.set(tick, m.slice(5)); sendBin(m); });
}, 8);

$('stop').onclick = () => { send({ t: 'stop' }); stopLeaderLive(); };

// ---- audio follow (file mode) ----
const au = $<HTMLAudioElement>('au');
let audTrack = -1;
function loadAudio() { if (room.mode === 'file' && audTrack !== room.track) { au.src = withToken(`/track?${room.track}`); audTrack = room.track; } }
const audBox = $<HTMLInputElement>('aud');
audBox.checked = lsGet('audioHere') === '1';
audBox.onchange = () => { lsSet('audioHere', audBox.checked ? '1' : '0'); if (audBox.checked && room.mode === 'file') loadAudio(); else au.pause(); };
setInterval(() => {
  if (!$<HTMLInputElement>('aud').checked || room.mode !== 'file' || !au.src) return;
  if (room.paused !== null) { au.pause(); return; }
  const t = (sNow() - room.start) / 1000;
  if (t < 0 || t > frames / FPS) { au.pause(); return; }
  if (au.paused) { au.currentTime = t; au.play().catch(() => msg('click page to allow audio')); return; }
  const drift = au.currentTime - t;
  if (Math.abs(drift) > 0.12) { au.currentTime = t; au.playbackRate = 1; }
  else au.playbackRate = Math.max(0.97, Math.min(1.03, 1 - drift * 0.5));
}, 250);

// ---- controls ----
const quant = () => $<HTMLSelectElement>('quant').value as Quant;
// transition + length: remembered per device, sent with every switch (picker, < >, [ ], pad L1/R1)
const transSel = $<HTMLSelectElement>('trans'), lenSel = $<HTMLSelectElement>('tlen');
transSel.add(new Option('random', 'random'));
for (const t of transitions()) transSel.add(new Option(t.name, t.id));
for (const b of TRANS_BEATS) lenSel.add(new Option(b === 0 ? 'cut' : b === 0.5 ? '½' : String(b), String(b)));
const remembered = mainTrans(lsGet);
transSel.value = remembered.type;
lenSel.value = String(remembered.beats); if (!lenSel.value) lenSel.value = String(DEFAULT_TRANS_BEATS);
/** A running auto-rotation takes the new transition settings too. */
const transChanged = () => { if (room.auto) send({ t: 'auto', bars: room.auto.bars, trans: transReq() }); };
transSel.onchange = () => { lsSet('trans', transSel.value); transChanged(); };
lenSel.onchange = () => { lsSet('tlen', lenSel.value); transChanged(); };
const transReq = () => ({ type: transSel.value as TransType | 'random', beats: +lenSel.value });
/** `next` picks a random other scene weighted by votes (👍 doubles, 👎 halves); `prev` steps back in list order. */
const switchScene = (to: { id?: string; step?: number; weighted?: boolean }) => send({ t: 'scene', ...to, quant: quant(), trans: transReq() });
const pick = $<HTMLSelectElement>('scene');
pick.onchange = () => switchScene({ id: pick.value });
$('prev').onclick = () => switchScene({ step: -1 });
$('next').onclick = () => switchScene({ weighted: true });
// auto-rotation (server-side, by vote weight), with this host's transition settings
const autoSel = $<HTMLSelectElement>('auto');
for (const b of AUTO_BARS) autoSel.add(new Option(b ? `every ${b} bars` : 'off', String(b)));
autoSel.onchange = () => { lsSet('auto', autoSel.value); send({ t: 'auto', bars: +autoSel.value, trans: transReq() }); };
$('hit').onclick = () => send({ t: 'ev', type: 'hit' });

// ---- transport bar (any host drives it; the server keeps everyone on the same position) ----
const fmt = (s: number) => `${Math.floor(Math.max(0, s) / 60)}:${String(Math.floor(Math.max(0, s) % 60)).padStart(2, '0')}`;
function playPause() {
  if (room.mode === 'file') send({ t: room.paused !== null ? 'resume' : 'pause' });
  else if (room.playlist) send({ t: 'track', index: room.playlist.index });
  else fileIn.click();
}
$('tPlay').onclick = playPause;
$('tPrev').onclick = () => {
  // like any player: restart the track unless we're near its start
  if (room.mode === 'file' && modeTick(room, sNow()) > 3 * FPS) send({ t: 'seek', frame: 0 });
  else send({ t: 'track', step: -1 });
};
$('tNext').onclick = () => send({ t: 'track', step: 1 });
const prog = $('prog');
const seekAt = (x: number) => {
  if (room.mode !== 'file') return;
  const r = prog.getBoundingClientRect();
  send({ t: 'seek', frame: Math.round(Math.max(0, Math.min(1, (x - r.left) / r.width)) * room.frames) });
};
let dragging = false;
prog.onpointerdown = (e) => { dragging = true; prog.setPointerCapture(e.pointerId); showSeek(e.clientX); };
prog.onpointermove = (e) => { if (dragging) showSeek(e.clientX); };
prog.onpointerup = (e) => { if (dragging) { dragging = false; seekAt(e.clientX); } };
function showSeek(x: number) {
  const r = prog.getBoundingClientRect();
  $('progFill').style.width = `${Math.max(0, Math.min(1, (x - r.left) / r.width)) * 100}%`;
}

/** Called every frame: position, time, title, buttons. */
function updateBar(f: number) {
  const r = room, pl = r.playlist, file = r.mode === 'file' ? r : null;
  const pos = file ? Math.max(0, Math.min(f, file.frames)) : 0;
  if (!dragging) $('progFill').style.width = file?.frames ? `${(pos / file.frames) * 100}%` : '0';
  $('tTime').textContent = file ? (f < 0 ? `starts in ${(-f / FPS).toFixed(1)}s` : `${fmt(pos / FPS)} / ${fmt(file.frames / FPS)}`) : r.mode === 'live' ? 'live' : '';
  const title = file ? file.name || 'track' : pl ? `${pl.names[pl.index]} (stopped)` : r.mode === 'live' ? 'live input' : 'no track: load files or a folder';
  $('tName').textContent = title + (pl && pl.names.length > 1 ? `  ·  ${pl.index + 1}/${pl.names.length}` : '');
  $('tPlay').textContent = file && file.paused === null ? '❚❚' : '▶';
  prog.classList.toggle('off', !file);
}

// ---- MIDI (opt-in per host, remembered: two hosts on one device would double every note) ----
const midi = new MidiRelay(send, (perf) => perf + clockOff);
const midiBtn = $<HTMLButtonElement>('midi');
async function setMidi(on: boolean) {
  try {
    if (on) await midi.enable(); else midi.disable();
    lsSet('midi', on ? '1' : '0');
    msg(on ? `midi: ${midi.status.inputs.length ? midi.status.inputs.join(', ') : 'no inputs yet (hotplug works)'}` : 'midi off');
  } catch (e) { msg(`midi failed: ${(e as Error).message}`); }
  midiBtn.setAttribute('aria-pressed', String(midi.enabled));
  midiBtn.textContent = midi.enabled ? 'midi on' : 'midi';
}
midiBtn.onclick = () => setMidi(!midi.enabled);
if (lsGet('midi') === '1') setMidi(true);

$('hostsBtn').onclick = () => $('hosts').classList.toggle('hide');

function renderHosts(names: Map<string, string>) {
  const el = $('hosts');
  el.replaceChildren();
  for (const h of room.hosts) {
    const name = document.createElement('span');
    name.textContent = h.name + (h.id === me ? ' (this)' : '');
    if (h.id === me) name.className = 'me';
    const sel = document.createElement('select');
    sel.add(new Option('own default', ''));
    VIEWS.forEach((v, i) => sel.add(new Option(v, String(i))));
    sel.value = h.view === null ? '' : String(h.view);
    sel.onchange = () => send({ t: 'view', host: h.id, view: sel.value === '' ? null : +sel.value });
    el.append(name, sel);
  }
  if (!room.hosts.length) el.textContent = 'no hosts';
  // scores is absent in states from a server older than #24
  const sc = (id: string) => { const s = room.scores?.[id]; return s ? `  ${s > 0 ? '+' : ''}${s}` : ''; };
  pick.replaceChildren(...room.presets.map((id) => new Option((names.get(id) ?? id) + sc(id), id)));
  autoSel.value = String(room.auto?.bars ?? 0);
}

autoHideUi(() => [$('panel'), $('bar'), $('hosts')]);
toggleUiOnDoubleTap((el) => el.id === 'c');

// ---- votes (owner only: anyone with the room token) ----
let toastTimer = 0;
function toast(text: string) {
  const el = $('toast');
  el.textContent = text; el.classList.add('on');
  clearTimeout(toastTimer); toastTimer = window.setTimeout(() => el.classList.remove('on'), 2200);
}

// ---- render ----
async function start() {
  const gpu = await initGpu();
  const engine = new Engine(gpu, $<HTMLCanvasElement>('c'));
  // particle budget: benchmark before the first frame, report it; the room's N comes back in the state
  engine.budget.n = (t) => flowNAt(room.flow, t);
  benchN = engine.budget.cap = qs.has('cap') ? Math.max(1, +qs.get('cap')! | 0) : await engine.bench();
  send({ t: 'bench', n: benchN });
  const names = new Map(engine.scenes.map((s) => [s.def.id, s.def.name]));
  const onState = () => { renderHosts(names); pick.value = room.scene.id; };
  listeners.state.push(onState); onState();
  listeners.vote.push((v) => toast(`${v.vote > 0 ? '👍' : '👎'} ${names.get(v.scene) ?? v.scene}  ${v.score > 0 ? '+' : ''}${v.score}${v.retired ? '  · retired' : ''}${v.host ? `  · ${v.host}` : '  · gallery'}`));
  /** Vote on the scene showing now (during a transition: the one coming in). A 👎 also skips. */
  const vote = (v: 1 | -1) => send({ t: 'vote', scene: sceneAt(room.scene, lastF), vote: v, quant: quant(), trans: transReq() });
  listeners.lateEvent.push((t) => engine.invalidate(t));

  let hudOn = true, lastHash = '', lastF = 0;
  const rate = new Rate();
  const nameOf = (id: number | null) => (id === null ? 'none' : (room.hosts.find((h) => h.id === id)?.name ?? `#${id}`) + (id === me ? ' (this)' : ''));
  const panel = new DebugPanel(() => {
    const r = rate.sample(net), f = lastF;
    const hasWave = window.__ek?.wave ? 'streamed' : 'none (scope synthesizes)';
    const ageS = net.lastPong ? ((performance.now() - net.lastPong) / 1000).toFixed(1) : '-';
    const rtts = samples.map((x) => x.rtt), minR = rtts.length ? Math.min(...rtts) : 0, maxR = rtts.length ? Math.max(...rtts) : 0;
    let newest = -Infinity; for (const k of live.keys()) if (k > newest) newest = k;
    const FE = withEvents(silence, events);
    return [
      ['hud', ($('hud').textContent ?? '').split('\n')],
      ['network', [
        `ws ${['connecting', 'open', 'closing', 'closed'][ws?.readyState ?? 3]}  connects ${net.connects}  me #${me}  ${location.host}`,
        `rtt ${rtt.toFixed(1)}ms (min ${minR.toFixed(1)} max ${maxR.toFixed(1)}, ${samples.length} samples)  clock offset ${clockOff.toFixed(1)}ms  last pong ${ageS}s ago`,
        `in ${r.msgsIn.toFixed(0)} msg/s ${(r.bytesIn / 1024).toFixed(1)} KiB/s   out ${r.msgsOut.toFixed(0)} msg/s ${(r.bytesOut / 1024).toFixed(1)} KiB/s`,
        `totals in ${net.msgsIn} (${(net.bytesIn / 1048576).toFixed(2)} MiB)  out ${net.msgsOut} (${(net.bytesOut / 1048576).toFixed(2)} MiB)`,
        room.mode === 'live' ? `live features: delay ${room.delay}t, ${live.size} buffered, newest ${newest}, lead ${newest - f} ticks, gaps ${net.liveGaps}, late ${net.lateFrames}${leaderLive ? ' (leader)' : ''}` : `live features: n/a (${room.mode})`,
        `events: ${window.__ek?.events ?? 0} received, ${net.lateEvents} late (replayed)`,
      ]],
      ['room', [
        `mode ${room.mode}  epoch ${room.epoch}${room.mode === 'file' ? `  track ${room.track}  frames ${room.frames}` : ''}  tick ${f}  hash ${lastHash}`,
        `scene ${room.scene.id} (prev ${room.scene.prev}, at ${room.scene.at})  presets ${room.presets.join(' ')}`,
        `transition: ${transLine(f)}`,
        `waveform ${hasWave}`,
        `grid origin ${room.grid.origin} tpb ${room.grid.tpb} (${((60 * FPS) / room.grid.tpb).toFixed(2)} bpm)`,
        `hosts: ${room.hosts.map((h) => `${h.name}#${h.id}${h.view === null ? '' : ` v${h.view}`}${h.cap === null ? '' : ` cap ${h.cap}`}`).join(', ') || 'none'}`,
        `flow N ${flowNAt(room.flow, f)}${room.flow.at > f ? ` → ${room.flow.n} at reseed ${room.flow.at}` : ''} (weakest host)  this host's cap ${benchN ?? '?'}${qs.has('cap') ? ' (forced)' : ' (benchmark)'}`,
      ]],
      ['midi', [
        `this host: ${midi.enabled ? `on, inputs: ${midi.status.inputs.join(', ') || 'none'}` : 'off'}`,
        midi.enabled ? `local clock ${midi.status.bpm ? `${midi.status.bpm} bpm, beat ${midi.status.beat}` : 'none'}   last ${midi.status.lastMsg || '-'}` : '',
        `room clock master: ${nameOf(room.clock)}   at tick: bpm ${FE.get(f, K_BPM)} phase ${FE.get(f, K_PHASE)} beat-in-bar ${FE.get(f, K_BAR)}`,
        `params: ${CC_PARAMS.map((c) => `cc${c}=${events.cc(f, c)}`).join('  ')}`,
      ].filter(Boolean)],
      ['pads', [
        `this host: ${[...pads.connected].map(([i, id]) => `#${i} ${id.slice(0, 40)}`).join(', ') || 'none'}`,
        ...lastFx.pads.map((p) => `slot ${p.slot} (${PAD_COLORS[p.slot % PAD_COLORS.length].map((x) => (x * 9) | 0).join('')})  center ${p.x.toFixed(2)},${p.y.toFixed(2)}  held ${p.held.toString(2)}  idle ${p.age}t`),
        `fx: trails ${lastFx.trails.toFixed(2)} bloom ${lastFx.bloom.toFixed(2)} rot ${lastFx.rotate.toFixed(2)} zoom ${lastFx.zoom.toFixed(2)}  marks ${lastFx.marks.length}${lastFx.frozenAt !== null ? `  FROZEN @${lastFx.frozenAt}` : ''}`,
      ]],
      ['page', [
        `${innerWidth}x${innerHeight} @${devicePixelRatio}x  canvas ${$<HTMLCanvasElement>('c').width}x${$<HTMLCanvasElement>('c').height}  view ${VIEWS[engine.view]}`,
        `secure ${isSecureContext}  visibility ${document.visibilityState}  offset ${offsetMs}ms`,
      ]],
    ];
  });
  $('dbgBtn').onclick = () => panel.toggle();
  // D-pad up/down cycles this host's own view (an override, like the hosts panel)
  const pads = new PadRelay(send, {
    scene: (step) => switchScene(step > 0 ? { weighted: true } : { step }),
    vote,
    view: (step) => send({ t: 'view', host: me, view: (((engine.view + step) % VIEWS.length) + VIEWS.length) % VIEWS.length }),
  });
  let lastFx: Fx = fxAt(events, 0);
  if (qs.get('debug') === '1') panel.toggle(true);
  addEventListener('keydown', (e) => {
    if ((e.target as HTMLElement).tagName === 'INPUT' || (e.target as HTMLElement).tagName === 'SELECT') return;
    if (e.key === 'h' && document.body.classList.contains('ui-off')) document.body.classList.remove('ui-off'); // hidden by double-tap: h brings it back
    else if (e.key === 'h') { hudOn = !hudOn; for (const id of ['panel', 'bar']) $(id).classList.toggle('hide', !hudOn); if (!hudOn) $('hosts').classList.add('hide'); }
    else if (e.key === 'p') playPause();
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      if (room.mode === 'file') send({ t: 'seek', frame: Math.max(0, Math.min(room.frames, modeTick(room, sNow())) + (e.key === 'ArrowLeft' ? -10 : 10) * FPS) });
    }
    else if (e.key === 'd') panel.toggle();
    else if (e.key === ' ') { e.preventDefault(); send({ t: 'ev', type: 'hit' }); }
    else if (e.key === '[') switchScene({ step: -1 });
    else if (e.key === ']') switchScene({ weighted: true });
    else if (e.key === '+' || e.key === '=') vote(1);
    else if (e.key === '-' || e.key === '_') vote(-1);
  });
  $('fs').onclick = () => document.documentElement.requestFullscreen?.();

  const loop = () => {
    requestAnimationFrame(loop);
    // display time: tick f plus a sub-tick (0..255) that closed-form scenes interpolate to
    const tF = modeTickF(room, sNow() + offsetMs), f = Math.floor(tF), sub = interp ? Math.floor((tF - f) * 256) : 0;
    let F: FeatureSource, label: string;
    if (room.mode === 'file' && fileFeat) {
      F = { ...fileSource(fileFeat, frames), lyrics: room.lyrics };
      label = (f < 0 ? `starts in ${(-f / FPS).toFixed(1)}s` : `file ${f}/${frames}${room.paused !== null ? ' (paused)' : ''}`) + (audBox.checked ? '' : '  (no sound here: tick "audio here")');
    } else if (room.mode === 'live') {
      F = mapSource(live); label = leaderLive ? 'live (leader)' : 'live';
      for (const k of live.keys()) if (k < f - 2000) live.delete(k);
    } else { F = silence; label = 'idle'; }
    if (room.mode === 'live' && f >= 0 && f !== lastF && !live.has(f)) net.liveGaps++;
    events.prune(f - 2000);
    const self = room.hosts.find((h) => h.id === me);
    engine.view = self?.view ?? defaultView;
    pads.poll();
    const FE = withEvents(F, events);
    const fx = (lastFx = fxAt(events, f));
    const hash = engine.frame(f, FE, fx, room.scene, sub);
    lastHash = hash; lastF = f;
    panel.frame(f);
    lastTick = Math.max(lastTick, f);
    const dbg = (window.__ek ??= { hashes: new Map(), scene: '', view: 0, events: 0, wave: false, trans: '', transSeen: [] as string[] });
    dbg.trans = engine.transition?.type ?? '';
    if (dbg.trans && !dbg.transSeen.includes(dbg.trans)) dbg.transSeen.push(dbg.trans);
    dbg.hashes.set(f, hash); if (dbg.hashes.size > 240) dbg.hashes.delete(dbg.hashes.keys().next().value!); dbg.scene = engine.scene.def.id; dbg.view = engine.view; dbg.wave = F.wave(f) !== null;
    if (hudOn) updateBar(f);
    if (panel.shown) {
      const st = engine.scene.status?.();
      const tr = engine.transition;
      const pending = tr ? `  →  ${names.get(tr.to)}  (${transName(tr.type)} ${((tr.p16 / 65536) * 100) | 0}%)`
        : room.scene.at > f ? `  →  ${names.get(room.scene.id)} in ${((room.scene.at - f) / FPS).toFixed(2)}s` : '';
      $('hud').textContent = [
        `${label}  ·  ${tr ? names.get(tr.from) : engine.scene.def.name}${pending}`,
        `tick ${f}  hash ${hash}`,
        st,
        FE.get(f, K_BPM) ? `midi ${FE.get(f, K_BPM)} bpm  beat ${FE.get(f, K_BAR) + 1}/4` : null,
        ccLine(f),
        `${hostName}  view ${VIEWS[engine.view]}  ·  rtt ${rtt.toFixed(1)}ms  offset ${offsetMs}ms`,
      ].filter(Boolean).join('\n');
    }
  };
  loop();
}
/** Running and pending switches at tick f, for the debug panel. */
function transLine(f: number): string {
  const steps: SceneStep[] = [...room.scene.earlier, room.scene].filter((s) => s.at + s.trans.ticks > f);
  if (!steps.length) return 'none';
  return steps.map((s) => {
    const t = s.trans, name = transName(t.type), len = t.ticks ? ` ${t.ticks}t (${(t.ticks / t.tpb).toFixed(2)} beats) seed ${hex(t.seed)}` : '';
    const when = s.at > f ? `pending, in ${s.at - f}t` : `running ${f - s.at}/${t.ticks}`;
    return `${s.prev}→${s.id} ${name}${len} at ${s.at}, ${when}`;
  }).join('  |  ');
}
const hex = (n: number) => (n >>> 0).toString(16).padStart(8, '0');

/** CC params that have been set, for the HUD. */
function ccLine(f: number): string | null {
  const set = CC_PARAMS.map((c) => [c, events.cc(f, c)]).filter(([, v]) => v >= 0);
  return set.length && N_PARAMS ? 'cc ' + set.map(([c, v]) => `${c}:${v}`).join(' ') : null;
}
start().catch((e: Error) => { const el = $('err'); el.style.display = 'grid'; el.textContent = e.message; });
