// Synced app page. The server owns the room state (mode, scene schedule, presets, views); this
// page renders it through WebGPU on the shared tick and relays this host's inputs as events.
import { FPS, STRIDE } from '../core/constants.ts';
import { fileSource, mapSource, silence, type FeatureSource } from '../core/features.ts';
import { EventLog, withEvents } from '../core/events.ts';
import { Analyzer, N } from '../core/analysis.ts';
import { modeTick, sceneAt, DEFAULT_PRESETS, DEFAULT_GRID, type ClientMsg, type Quant, type RoomState, type ServerMsg } from '../core/protocol.ts';
import { initGpu } from './gpu/gpu.ts';
import { VIEWS } from './gpu/post.ts';
import { Engine } from './engine.ts';

/** Debug/test hook: recent tick -> scene-state hash, so tools can compare hosts at equal ticks. */
declare global { interface Window { __ek?: { hashes: Map<number, string>; scene: string; view: number; events: number } } }

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
const defaultView = Math.max(0, Math.min(VIEWS.length - 1, +(qs.get('view') ?? 0) | 0));

// ---- connection, clock sync (NTP-style, min-RTT of last 20 samples) ----
let ws: WebSocket | null = null, clockOff = 0, rtt = 0, me = 0;
const samples: { rtt: number; off: number }[] = [];
const sNow = () => performance.now() + clockOff;
const send = (m: ClientMsg) => { if (ws?.readyState === 1) ws.send(JSON.stringify(m)); };
const sendBin = (d: Uint8Array<ArrayBuffer>) => { if (ws?.readyState === 1) ws.send(d); };
function pingBurst() { for (let i = 0; i < 5; i++) setTimeout(() => send({ t: 'ping', c: performance.now() }), i * 60); }

let room: RoomState = {
  mode: 'idle', epoch: -1, scene: { id: DEFAULT_PRESETS[0], prev: DEFAULT_PRESETS[0], at: 0 },
  presets: DEFAULT_PRESETS, grid: DEFAULT_GRID, hosts: [],
};
let fileFeat: Uint8Array | null = null, frames = 0, lastTick = -Infinity;
const live = new Map<number, Uint8Array>();
const events = new EventLog();
const listeners = { state: [] as (() => void)[], lateEvent: [] as ((tick: number) => void)[] };
let leaderLive: { an: Analyzer; analyser: AnalyserNode; td: Float32Array<ArrayBuffer>; last: number; ac: AudioContext; stream: MediaStream; pending: boolean } | null = null;

function connect() {
  ws = new WebSocket(withToken(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`));
  ws.binaryType = 'arraybuffer';
  ws.onopen = () => { samples.length = 0; pingBurst(); send({ t: 'hello', name: hostName }); msg('connected'); };
  ws.onclose = (e) => { msg(e.code === 1006 && !token ? 'not connected: open the join URL with ?t=' : 'disconnected, retrying'); setTimeout(connect, 1000); };
  ws.onmessage = (e) => {
    if (typeof e.data !== 'string') {
      const u = new Uint8Array(e.data), dv = new DataView(e.data);
      if (u[0] === 1) live.set(dv.getUint32(1, true), u.slice(5, 5 + STRIDE));
      else if (u[0] === 2) { frames = dv.getUint32(1, true); fileFeat = u.slice(5); }
      return;
    }
    const m = JSON.parse(e.data) as ServerMsg;
    if (m.t === 'pong') {
      const t1 = performance.now();
      samples.push({ rtt: t1 - m.c, off: m.s - (m.c + t1) / 2 });
      if (samples.length > 20) samples.shift();
      const best = samples.reduce((a, b) => (b.rtt < a.rtt ? b : a));
      clockOff = best.off; rtt = best.rtt;
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
      listeners.state.forEach((f) => f());
    } else if (m.t === 'log') {
      if (m.epoch === room.epoch) { events.reset(m.events); listeners.lateEvent.forEach((f) => f(-Infinity)); }
    } else if (m.t === 'ev') {
      events.add(m.ev);
      if (window.__ek) window.__ek.events++;
      if (m.ev.tick <= lastTick) listeners.lateEvent.forEach((f) => f(m.ev.tick)); // arrived late: replay
    }
  };
}
connect();
setInterval(pingBurst, 3000);

// ---- leader: file ----
$<HTMLInputElement>('file').onchange = async () => {
  const f = $<HTMLInputElement>('file').files?.[0]; if (!f) return;
  if (!audBox.checked) { audBox.checked = true; audBox.onchange?.(new Event('change')); } // the uploader usually wants to hear it
  msg('uploading');
  const buf = await f.arrayBuffer();
  await fetch(withToken('/track'), { method: 'POST', headers: { 'content-type': f.type || 'application/octet-stream' }, body: buf.slice(0) });
  msg('decoding');
  const ac = new AudioContext();
  const ab = await ac.decodeAudioData(buf);
  ac.close();
  const n = ab.length, mono = new Float32Array(n);
  for (let ch = 0; ch < ab.numberOfChannels; ch++) { const d = ab.getChannelData(ch); for (let i = 0; i < n; i++) mono[i] += d[i] / ab.numberOfChannels; }
  const an = new Analyzer(ab.sampleRate), nf = Math.ceil((n / ab.sampleRate) * FPS);
  const out = new Uint8Array(5 + nf * STRIDE), td = new Float32Array(N);
  new DataView(out.buffer).setUint32(1, nf, true); out[0] = 2;
  for (let fr = 0; fr < nf; fr++) {
    const c = Math.round((fr * ab.sampleRate) / FPS) - N / 2;
    for (let i = 0; i < N; i++) { const s = c + i; td[i] = s >= 0 && s < n ? mono[s] : 0; }
    out.set(an.frame(td), 5 + fr * STRIDE);
    if (fr % 600 === 0) { msg(`analyzing ${((100 * fr) / nf) | 0}%`); await new Promise((r) => setTimeout(r)); }
  }
  sendBin(out);
  send({ t: 'play' });
  msg('playing in 2.5 s');
};

// ---- leader: live (capture needs a secure context: localhost or https) ----
const RAW_AUDIO = { echoCancellation: false, noiseSuppression: false, autoGainControl: false };
const insecure = () => (isSecureContext ? '' : ' (capture needs localhost or https: open the 127.0.0.1 link, or use `tailscale serve`)');

/** Analyze `stream` on this host and stream features to the room as the live leader. */
function startLive(stream: MediaStream, label: string) {
  stopLeaderLive();
  const ac = new AudioContext(), analyser = ac.createAnalyser();
  analyser.fftSize = N;
  ac.createMediaStreamSource(stream).connect(analyser); // analysis only: not routed to the speakers
  leaderLive = { an: new Analyzer(ac.sampleRate), analyser, td: new Float32Array(N), last: -1, ac, stream, pending: true };
  // the user pressed "Stop sharing" in Chrome's bar, or the device went away
  for (const t of stream.getAudioTracks()) t.onended = () => { if (leaderLive?.stream === stream) { send({ t: 'stop' }); stopLeaderLive(); msg('capture ended'); } };
  send({ t: 'live' });
  msg(label);
}
function stopLeaderLive() {
  if (!leaderLive) return;
  leaderLive.stream.getTracks().forEach((t) => t.stop()); leaderLive.ac.close(); leaderLive = null;
}

$('live').onclick = async () => {
  try { startLive(await navigator.mediaDevices.getUserMedia({ audio: RAW_AUDIO }), 'live: mic / line-in'); }
  catch (e) { msg(`mic failed: ${(e as Error).message}${insecure()}`); }
};

// Music already playing elsewhere: a Chrome tab ("Share tab audio") or any app via
// "Entire screen" + "Share system audio" (Windows/ChromeOS). The source keeps playing normally.
$('capture').onclick = async () => {
  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: true, // required by Chrome; dropped below
      audio: { ...RAW_AUDIO, suppressLocalAudioPlayback: false },
      systemAudio: 'include', selfBrowserSurface: 'exclude', surfaceSwitching: 'include', preferCurrentTab: false,
    } as DisplayMediaStreamOptions);
    const audio = stream.getAudioTracks();
    stream.getVideoTracks().forEach((t) => t.stop());
    if (!audio.length) { msg('no audio was shared: pick a tab with "Share tab audio" on, or Entire screen with "Share system audio"'); return; }
    startLive(new MediaStream(audio), `live: capturing "${audio[0].label || 'tab/app audio'}"`);
  } catch (e) {
    if ((e as Error).name !== 'NotAllowedError') msg(`capture failed: ${(e as Error).message}${insecure()}`);
  }
};
setInterval(() => {
  const L = leaderLive;
  if (!L || room.mode !== 'live') return;
  const cur = Math.floor(((sNow() - room.start) * FPS) / 1000);
  if (cur < 0) return;
  if (L.last < cur - 30) L.last = cur - 1; // don't burst after a stall
  L.analyser.getFloatTimeDomainData(L.td);
  while (L.last < cur) {
    L.last++;
    const b = L.an.frame(L.td), m = new Uint8Array(5 + STRIDE);
    m[0] = 1; new DataView(m.buffer).setUint32(1, L.last, true); m.set(b, 5);
    live.set(L.last, b); sendBin(m);
  }
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
  const t = (sNow() - room.start) / 1000;
  if (t < 0 || t > frames / FPS) { au.pause(); return; }
  if (au.paused) { au.currentTime = t; au.play().catch(() => msg('click page to allow audio')); return; }
  const drift = au.currentTime - t;
  if (Math.abs(drift) > 0.12) { au.currentTime = t; au.playbackRate = 1; }
  else au.playbackRate = Math.max(0.97, Math.min(1.03, 1 - drift * 0.5));
}, 250);

// ---- controls ----
const quant = () => $<HTMLSelectElement>('quant').value as Quant;
const pick = $<HTMLSelectElement>('scene');
pick.onchange = () => send({ t: 'scene', id: pick.value, quant: quant() });
$('prev').onclick = () => send({ t: 'scene', step: -1, quant: quant() });
$('next').onclick = () => send({ t: 'scene', step: 1, quant: quant() });
$('hit').onclick = () => send({ t: 'ev', type: 'hit' });
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
  pick.replaceChildren(...room.presets.map((id) => new Option(names.get(id) ?? id, id)));
}

// ---- render ----
async function start() {
  const gpu = await initGpu();
  const engine = new Engine(gpu, $<HTMLCanvasElement>('c'));
  const names = new Map(engine.scenes.map((s) => [s.def.id, s.def.name]));
  const onState = () => { renderHosts(names); pick.value = room.scene.id; };
  listeners.state.push(onState); onState();
  listeners.lateEvent.push((t) => engine.invalidate(t));

  let hudOn = true;
  addEventListener('keydown', (e) => {
    if ((e.target as HTMLElement).tagName === 'INPUT' || (e.target as HTMLElement).tagName === 'SELECT') return;
    if (e.key === 'h') { hudOn = !hudOn; for (const id of ['hud', 'panel']) $(id).classList.toggle('hide', !hudOn); if (!hudOn) $('hosts').classList.add('hide'); }
    else if (e.key === ' ') { e.preventDefault(); send({ t: 'ev', type: 'hit' }); }
    else if (e.key === '[') send({ t: 'scene', step: -1, quant: quant() });
    else if (e.key === ']') send({ t: 'scene', step: 1, quant: quant() });
  });
  $('fs').onclick = () => document.documentElement.requestFullscreen?.();

  const loop = () => {
    requestAnimationFrame(loop);
    const f = modeTick(room, sNow() + offsetMs);
    let F: FeatureSource, label: string;
    if (room.mode === 'file' && fileFeat) {
      F = fileSource(fileFeat, frames);
      label = (f < 0 ? `starts in ${(-f / FPS).toFixed(1)}s` : `file ${f}/${frames}`) + (audBox.checked ? '' : '  (no sound here: tick "audio here")');
    } else if (room.mode === 'live') {
      F = mapSource(live); label = leaderLive ? 'live (leader)' : 'live';
      for (const k of live.keys()) if (k < f - 2000) live.delete(k);
    } else { F = silence; label = 'idle'; }
    events.prune(f - 2000);
    engine.setScene(sceneAt(room.scene, f));
    const self = room.hosts.find((h) => h.id === me);
    engine.view = self?.view ?? defaultView;
    const hash = engine.frame(f, withEvents(F, events));
    lastTick = Math.max(lastTick, f);
    const dbg = (window.__ek ??= { hashes: new Map(), scene: '', view: 0, events: 0 });
    dbg.hashes.set(f, hash); if (dbg.hashes.size > 240) dbg.hashes.delete(dbg.hashes.keys().next().value!); dbg.scene = engine.scene.def.id; dbg.view = engine.view;
    if (hudOn) {
      const st = engine.scene.status?.();
      const pending = room.scene.at > f ? `  →  ${names.get(room.scene.id)} in ${((room.scene.at - f) / FPS).toFixed(2)}s` : '';
      $('hud').textContent = [
        `${label}  ·  ${engine.scene.def.name}${pending}`,
        `tick ${f}  hash ${hash}`,
        st,
        `${hostName}  view ${VIEWS[engine.view]}  ·  rtt ${rtt.toFixed(1)}ms  offset ${offsetMs}ms`,
      ].filter(Boolean).join('\n');
    }
  };
  loop();
}
start().catch((e: Error) => { const el = $('err'); el.style.display = 'grid'; el.textContent = e.message; });
