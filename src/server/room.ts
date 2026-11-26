// Room: the server-authoritative state (mode, scene schedule, presets, beat grid, host views),
// the tick-stamped event stream, and the replay logs late joiners need to catch up.
import { FPS, RESEED_TICKS, STRIDE, WAVE_BYTES } from '../core/constants.ts';
import {
  CUT, DEFAULT_GRID, DEFAULT_PRESETS, INPUT_DELAY, TRANSITIONS, fixedScene, modeTick, modeTickF, nextBoundary, sceneAt,
  type ClientMsg, type ClockMsg, type HostInfo, type Mode, type Quant, type RoomState, type SceneStep, type ServerMsg,
  type TickEvent, type TransSched, type TransType,
} from '../core/protocol.ts';
import { pickRandom } from '../core/transitions.ts';
import { stateKey } from '../core/events.ts';
import type { WsConn } from './ws.ts';

/** Keep features and events for two reseed periods: covers a sim fast-forward from the last reseed. */
const KEEP_TICKS = 2 * RESEED_TICKS;
const MAX_EVENT_BYTES = 1024;
/** The clock master keeps the job until it has been silent this long (or leaves). */
export const CLOCK_TIMEOUT_MS = 2000;
const TRANSPORT = new Set(['start', 'stop', 'continue']);
const MAX_PADS = 8;
/** Switches that may be pending or running at once (a request past this is dropped). */
const MAX_QUEUE = 8;
const clampInt = (x: unknown, lo: number, hi: number) => (Number.isFinite(x) ? Math.max(lo, Math.min(hi, Math.round(x as number))) : 0);
const int7 = (x: unknown) => (Number.isInteger(x) && (x as number) >= 0 && (x as number) <= 127 ? (x as number) : -1);

/** Client events are relayed as-is, except MIDI ones, which are reduced to their known fields. */
function sanitize(type: string, p: unknown): { ok: boolean; payload?: unknown } {
  const o = (typeof p === 'object' && p ? p : {}) as Record<string, unknown>;
  if (type === 'beat') return { ok: false }; // only the server stamps beats
  if (type === 'note') { const n = int7(o.n), v = int7(o.v); return { ok: n >= 0 && v > 0, payload: { n, v } }; }
  if (type === 'cc') { const c = int7(o.c), v = int7(o.v); return { ok: c >= 0 && v >= 0, payload: { c, v } }; }
  if (type === 'transport') return { ok: TRANSPORT.has(o.op as string), payload: { op: o.op } };
  return { ok: true, payload: p };
}

interface Client { id: number; ws: WsConn; name: string | null }

export class Room {
  private clients = new Map<number, Client>();
  private nextId = 1;
  private leader: Client | null = null;
  private fileFeat: Buffer | null = null;
  private ring: Buffer[] = [];
  private log: TickEvent[] = [];
  private viewByName = new Map<string, number | null>();
  /** Latest event per state key (CCs, pads, palette, freeze): kept past the log window, carried into new timelines. */
  private latest = new Map<string, TickEvent>();
  /** Pad slots: `${host}:${local index}` -> slot 0..MAX_PADS-1. */
  private padSlots = new Map<string, number>();
  private palette = 0;
  private frozen = false;
  private taps: number[] = [];
  private clock: { id: number; last: number; beatTick: number } | null = null;
  /** Last effect the server scheduled, so `random` never repeats it. */
  private lastTrans: TransType | null = null;
  trackId = 0;
  state: RoomState = {
    mode: 'idle', epoch: 0,
    scene: fixedScene(DEFAULT_PRESETS[0]),
    presets: [...DEFAULT_PRESETS], grid: { ...DEFAULT_GRID }, hosts: [], clock: null, playlist: null,
  };
  private now: () => number;
  private rand: () => number;

  constructor(now: () => number = () => performance.now(), rand: () => number = Math.random) { this.now = now; this.rand = rand; }

  /** The tick hosts are rendering right now. */
  tickNow(): number { return modeTick(this.state, this.now()); }

  join(ws: WsConn): void {
    const c: Client = { id: this.nextId++, ws, name: null };
    this.clients.set(c.id, c);
    ws.onmessage = (d) => this.onMessage(c, d);
    ws.onclose = () => {
      this.clients.delete(c.id);
      if (this.leader === c) this.leader = null;
      if (this.clock?.id === c.id) { this.clock = null; this.state.clock = null; }
      if (this.state.playlist?.owner === c.id) this.state.playlist = null;
      for (const [k, s] of this.padSlots) if (k.startsWith(`${c.id}:`)) {
        this.padSlots.delete(k);
        this.emit({ tick: this.tickNow() + INPUT_DELAY, src: c.id, type: 'pad', payload: { s, b: 0, a: [0, 0, 0, 0], t: [0, 0], gone: 1 } });
        this.latest.delete(`pad:${s}`);
      }
      if (c.name !== null) this.broadcastState();
    };
    this.send(c, { t: 'welcome', you: c.id });
    this.send(c, { t: 'state', ...this.state });
    if (this.state.mode === 'file' && this.fileFeat) ws.send(this.fileFeat);
    if (this.state.mode === 'live') for (const m of this.ring) ws.send(m);
    const inLog = new Set(this.log), stale = [...this.latest.values()].filter((e) => !inLog.has(e));
    this.send(c, { t: 'log', epoch: this.state.epoch, events: [...stale, ...this.log] });
  }

  private send(c: Client, m: ServerMsg): void { c.ws.json(m); }
  private broadcast(m: ServerMsg): void { const s = JSON.stringify(m); for (const c of this.clients.values()) c.ws.send(s); }

  private broadcastState(): void {
    this.state.hosts = [...this.clients.values()]
      .filter((c) => c.name !== null)
      .map((c): HostInfo => ({ id: c.id, name: c.name!, view: this.viewByName.get(c.name!) ?? null }));
    this.broadcast({ t: 'state', ...this.state });
  }

  /**
   * New timeline: tick space restarts, so the logs and the scene schedule restart too. Pause and
   * resume keep tick space (the track position), so they keep the schedule: a transition freezes.
   */
  private setMode(m: Mode, keepScene = false): void {
    const cur = sceneAt(this.state.scene, this.tickNow());
    const { epoch, presets, hosts, clock, playlist } = this.state;
    const scene = keepScene ? this.state.scene : fixedScene(cur);
    this.state = { ...m, epoch: epoch + 1, presets, hosts, clock, playlist, scene, grid: { ...DEFAULT_GRID } };
    this.ring = []; this.log = [];
    if (this.clock) this.clock.beatTick = -Infinity;
  }

  /** Announce a new timeline; the knobs keep their positions in it. */
  private newTimeline(): void {
    this.broadcastState();
    const tick = this.tickNow() + INPUT_DELAY;
    for (const e of [...this.latest.values()]) this.emit({ ...e, tick });
  }

  private emit(ev: TickEvent): void {
    this.log.push(ev);
    const key = stateKey(ev);
    if (key !== null) this.latest.set(key, ev);
    const oldest = ev.tick - KEEP_TICKS;
    while (this.log.length && this.log[0].tick < oldest) this.log.shift();
    this.broadcast({ t: 'ev', ev });
  }

  private onMessage(c: Client, d: Buffer | string): void {
    if (typeof d !== 'string') return this.onBinary(c, d);
    let m: ClientMsg;
    try { m = JSON.parse(d); } catch { return; }
    switch (m.t) {
      case 'ping': return this.send(c, { t: 'pong', c: m.c, s: this.now() });
      case 'hello':
        c.name = String(m.name).slice(0, 40) || `host ${c.id}`;
        return this.broadcastState();
      case 'ev': {
        if (typeof m.type !== 'string' || m.type.length > 32) return;
        if (m.payload !== undefined && JSON.stringify(m.payload).length > MAX_EVENT_BYTES) return;
        let { ok, payload } = sanitize(m.type, m.payload);
        if (m.type === 'pad') payload = this.padPayload(c, m.payload);
        else if (m.type === 'palette') { this.palette = (this.palette + clampInt((m.payload as { step?: number })?.step ?? 1, -8, 8) + 256) % 256; payload = { v: this.palette }; }
        else if (m.type === 'freeze') { this.frozen = !this.frozen; payload = { on: this.frozen ? 1 : 0 }; }
        if (!ok || payload === null) return;
        return this.emit({ tick: this.tickNow() + INPUT_DELAY, src: c.id, type: m.type, payload });
      }
      case 'tap': return this.onTap();
      case 'clock': return this.onClock(c, m);
      case 'scene': return this.requestScene(m.id, m.step, m.quant, m.trans);
      case 'view': {
        const host = this.clients.get(m.host);
        if (!host?.name) return;
        this.viewByName.set(host.name, m.view === null ? null : Math.max(0, Math.min(7, m.view | 0)));
        return this.broadcastState();
      }
      case 'play':
        if (!this.fileFeat) return;
        this.leader = c;
        this.setMode({
          mode: 'file', start: this.now() + 2500, frames: this.fileFeat.readUInt32LE(1), track: this.trackId,
          name: String(m.name ?? '').slice(0, 200), paused: null,
        });
        for (const o of this.clients.values()) o.ws.send(this.fileFeat);
        return this.newTimeline();
      case 'pause': case 'resume': case 'seek': {
        const s = this.state;
        if (s.mode !== 'file') return;
        const pos = s.paused ?? Math.max(0, Math.min(s.frames, this.tickNow()));
        const frame = m.t === 'seek' ? Math.max(0, Math.min(s.frames - 1, Math.floor(+m.frame || 0))) : pos;
        const paused = m.t === 'pause' || (m.t === 'seek' && s.paused !== null) ? frame : null;
        if (m.t === 'pause' && s.paused !== null) return;
        if (m.t === 'resume' && s.paused === null) return;
        // playing: the track (re)starts at `frame` 300 ms from now, long enough for the state to arrive
        this.setMode({ ...s, mode: 'file', start: this.now() + 300 - (frame * 1000) / FPS, paused }, m.t !== 'seek');
        return this.newTimeline();
      }
      case 'playlist': {
        if (!Array.isArray(m.names)) return;
        const names = m.names.slice(0, 1000).map((n) => String(n).slice(0, 120));
        this.state.playlist = { owner: c.id, names, index: Math.max(0, Math.min(names.length - 1, m.index | 0)) };
        return this.broadcastState();
      }
      case 'track': {
        const pl = this.state.playlist, owner = pl && this.clients.get(pl.owner);
        if (!pl || !owner || !pl.names.length) return;
        const n = pl.names.length, i = m.index !== undefined ? m.index | 0 : pl.index + ((m.step ?? 1) | 0);
        return this.send(owner, { t: 'track', index: ((i % n) + n) % n });
      }
      case 'live':
        this.leader = c;
        this.setMode({ mode: 'live', start: this.now() + 300 });
        return this.newTimeline();
      case 'stop':
        this.leader = null; this.fileFeat = null;
        this.setMode({ mode: 'idle' });
        return this.newTimeline();
    }
  }

  /** Pad state from a host, tagged with a room-wide slot (its color). null = no free slot. */
  private padPayload(c: Client, p: unknown): unknown {
    const o = (typeof p === 'object' && p ? p : {}) as Record<string, unknown>;
    const key = `${c.id}:${clampInt(o.l, 0, 15)}`;
    let s = this.padSlots.get(key);
    if (s === undefined) {
      const used = new Set(this.padSlots.values());
      for (let i = 0; i < MAX_PADS && s === undefined; i++) if (!used.has(i)) s = i;
      if (s === undefined) return null;
      this.padSlots.set(key, s);
    }
    const a = Array.isArray(o.a) ? o.a : [], t = Array.isArray(o.t) ? o.t : [];
    return {
      s, b: clampInt(o.b, 0, 0x1ffff),
      a: [0, 1, 2, 3].map((i) => clampInt(a[i], -100, 100)), t: [0, 1].map((i) => clampInt(t[i], 0, 100)),
    };
  }

  /** Tap tempo: sets the beat grid from the taps, unless a MIDI clock is running. */
  private onTap(): void {
    const now = this.now();
    if (this.taps.length && now - this.taps[this.taps.length - 1] > 2000) this.taps = [];
    this.taps.push(now); if (this.taps.length > 8) this.taps.shift();
    if (this.taps.length < 3 || (this.clock && now - this.clock.last < CLOCK_TIMEOUT_MS)) return;
    const beatMs = (now - this.taps[0]) / (this.taps.length - 1), tpb = (beatMs * FPS) / 1000;
    if (tpb < 9 || tpb > 180) return;
    this.state.grid = { origin: Math.round(modeTickF(this.state, now) * 100) / 100, tpb: Math.round(tpb * 1000) / 1000 };
    this.broadcastState();
  }

  /**
   * MIDI clock. The first host to send one is master until it's silent for CLOCK_TIMEOUT_MS.
   * It reports each beat after the fact, so the server stamps the *next* beat where it will
   * fall (beats are predictable; the network isn't) and re-anchors the bar grid on it.
   */
  private onClock(c: Client, m: ClockMsg): void {
    if (!(m.bpm >= 20 && m.bpm <= 400) || !Number.isFinite(m.at) || !Number.isInteger(m.n)) return;
    const now = this.now(), cl = this.clock;
    if (cl && cl.id !== c.id && now - cl.last < CLOCK_TIMEOUT_MS) return;
    if (!cl || cl.id !== c.id) {
      this.clock = { id: c.id, last: now, beatTick: -Infinity }; this.state.clock = c.id; this.broadcastState();
    }
    const k = this.clock!;
    k.last = now;
    if (this.state.mode === 'file' && this.state.paused !== null) return; // frozen timeline: no beats to place
    const bpm100 = Math.round(m.bpm * 100), beatMs = 6e6 / bpm100, tpb = (6000 * FPS) / bpm100;
    let n = m.n + 1, at = m.at + beatMs;
    const earliest = this.tickNow() + INPUT_DELAY;
    while (modeTickF(this.state, at) < earliest) { at += beatMs; n++; }
    const tickF = modeTickF(this.state, at), tick = Math.round(tickF);
    if (tick - k.beatTick < tpb / 2) return; // already stamped this one (or a restart landed on it)
    k.beatTick = tick;
    this.emit({ tick, src: c.id, type: 'beat', payload: { bpm: bpm100, n } });

    // bar grid: beat n%4 of a bar lands on tickF; only rebroadcast on a real tempo/phase change
    const origin = tickF - (n & 3) * tpb, g = this.state.grid, bar = 4 * tpb;
    const drift = Math.abs(((((origin - g.origin) % bar) + bar * 1.5) % bar) - bar / 2);
    if (Math.abs(tpb - g.tpb) > tpb * 0.005 || drift > 1) {
      this.state.grid = { origin: Math.round(origin * 100) / 100, tpb: Math.round(tpb * 1000) / 1000 };
      this.broadcastState();
    }
  }

  private onBinary(c: Client, m: Buffer): void {
    const frames = m.length >= 5 ? m.readUInt32LE(1) : 0;
    if (m[0] === 2 && (m.length === 5 + frames * STRIDE || m.length === 5 + frames * (STRIDE + WAVE_BYTES))) this.fileFeat = m;
    else if (m[0] === 1 && (m.length === 5 + STRIDE || m.length === 5 + STRIDE + WAVE_BYTES) && this.state.mode === 'live' && c === this.leader) {
      this.ring.push(m); if (this.ring.length > KEEP_TICKS) this.ring.shift();
      for (const o of this.clients.values()) if (o !== c) o.ws.send(m);
    }
  }

  /**
   * Schedule a scene switch on the next beat/bar boundary at least INPUT_DELAY ticks ahead. While
   * a switch is pending or running, the new one queues for the first boundary after it ends; a
   * pending cut is replaced instead (stepping before it lands, as before transitions).
   */
  requestScene(id: string | undefined, step: number | undefined, quant: Quant, req?: { type?: unknown; beats?: unknown }): void {
    const { presets, scene, grid } = this.state, t = this.tickNow();
    // each step counts from the most recently scheduled scene
    const i = presets.indexOf(scene.id), next = id ?? presets[(((i + ((step ?? 1) | 0)) % presets.length) + presets.length) % presets.length];
    if (!presets.includes(next)) return;
    // a paused track never reaches a later tick: cut on the frozen one
    if (this.state.mode === 'file' && this.state.paused !== null) {
      this.state.scene = { id: next, prev: sceneAt(scene, t), at: t, trans: CUT, earlier: [] };
      return this.broadcastState();
    }
    const strip = ({ id, prev, at, trans }: SceneStep): SceneStep => ({ id, prev, at, trans });
    const chain = [...scene.earlier, strip(scene)].filter((s) => s.at + s.trans.ticks > t);
    let prev = sceneAt(scene, t);
    const last = chain[chain.length - 1];
    if (last && last.at > t && last.trans.ticks === 0) { chain.pop(); prev = last.prev; }
    if (chain.length >= MAX_QUEUE) return;
    const before = chain[chain.length - 1];
    if (before) prev = before.id;
    const earliest = Math.max(t + INPUT_DELAY, before ? before.at + before.trans.ticks : -Infinity);
    const trans = this.resolveTrans(req);
    this.state.scene = { id: next, prev, at: nextBoundary(earliest, grid, quant), trans, earlier: chain };
    this.broadcastState();
  }

  /** `{type, beats}` from a request -> a concrete effect, its length frozen to ticks, and a seed. */
  private resolveTrans(req?: { type?: unknown; beats?: unknown }): TransSched {
    const beats = Number(req?.beats), tpb = this.state.grid.tpb;
    const ticks = Number.isFinite(beats) ? Math.round(Math.max(0, Math.min(16, beats)) * tpb) : 0;
    let type: TransType = req?.type === 'random' ? pickRandom(this.lastTrans, this.rand())
      : (TRANSITIONS as readonly unknown[]).includes(req?.type) ? (req!.type as TransType) : 'cut';
    if (ticks === 0) type = 'cut';
    if (type === 'cut') return { ...CUT, tpb };
    this.lastTrans = type;
    return { type, ticks, seed: Math.floor(this.rand() * 0x100000000) >>> 0, tpb };
  }
}
