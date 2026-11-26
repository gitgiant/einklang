// Room: the server-authoritative state (mode, scene schedule, presets, beat grid, host views),
// the tick-stamped event stream, and the replay logs late joiners need to catch up.
import { RESEED_TICKS, STRIDE } from '../core/constants.ts';
import {
  DEFAULT_GRID, DEFAULT_PRESETS, INPUT_DELAY, modeTick, nextBoundary, sceneAt,
  type ClientMsg, type HostInfo, type Mode, type RoomState, type ServerMsg, type TickEvent,
} from '../core/protocol.ts';
import type { WsConn } from './ws.ts';

/** Keep features and events for two reseed periods: covers a sim fast-forward from the last reseed. */
const KEEP_TICKS = 2 * RESEED_TICKS;
const MAX_EVENT_BYTES = 1024;

interface Client { id: number; ws: WsConn; name: string | null }

export class Room {
  private clients = new Map<number, Client>();
  private nextId = 1;
  private leader: Client | null = null;
  private fileFeat: Buffer | null = null;
  private ring: Buffer[] = [];
  private log: TickEvent[] = [];
  private viewByName = new Map<string, number | null>();
  trackId = 0;
  state: RoomState = {
    mode: 'idle', epoch: 0,
    scene: { id: DEFAULT_PRESETS[0], prev: DEFAULT_PRESETS[0], at: 0 },
    presets: [...DEFAULT_PRESETS], grid: { ...DEFAULT_GRID }, hosts: [],
  };
  private now: () => number;

  constructor(now: () => number = () => performance.now()) { this.now = now; }

  /** The tick hosts are rendering right now. */
  tickNow(): number { return modeTick(this.state, this.now()); }

  join(ws: WsConn): void {
    const c: Client = { id: this.nextId++, ws, name: null };
    this.clients.set(c.id, c);
    ws.onmessage = (d) => this.onMessage(c, d);
    ws.onclose = () => {
      this.clients.delete(c.id);
      if (this.leader === c) this.leader = null;
      if (c.name !== null) this.broadcastState();
    };
    this.send(c, { t: 'welcome', you: c.id });
    this.send(c, { t: 'state', ...this.state });
    if (this.state.mode === 'file' && this.fileFeat) ws.send(this.fileFeat);
    if (this.state.mode === 'live') for (const m of this.ring) ws.send(m);
    this.send(c, { t: 'log', epoch: this.state.epoch, events: this.log });
  }

  private send(c: Client, m: ServerMsg): void { c.ws.json(m); }
  private broadcast(m: ServerMsg): void { const s = JSON.stringify(m); for (const c of this.clients.values()) c.ws.send(s); }

  private broadcastState(): void {
    this.state.hosts = [...this.clients.values()]
      .filter((c) => c.name !== null)
      .map((c): HostInfo => ({ id: c.id, name: c.name!, view: this.viewByName.get(c.name!) ?? null }));
    this.broadcast({ t: 'state', ...this.state });
  }

  /** New timeline: tick space restarts, so the logs and the scene schedule restart too. */
  private setMode(m: Mode): void {
    const cur = sceneAt(this.state.scene, this.tickNow());
    const { epoch, presets, hosts } = this.state;
    this.state = { ...m, epoch: epoch + 1, presets, hosts, scene: { id: cur, prev: cur, at: 0 }, grid: { ...DEFAULT_GRID } };
    this.ring = []; this.log = [];
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
        const ev: TickEvent = { tick: this.tickNow() + INPUT_DELAY, src: c.id, type: m.type, payload: m.payload };
        this.log.push(ev);
        const oldest = ev.tick - KEEP_TICKS;
        while (this.log.length && this.log[0].tick < oldest) this.log.shift();
        return this.broadcast({ t: 'ev', ev });
      }
      case 'scene': return this.requestScene(m.id, m.step, m.quant);
      case 'view': {
        const host = this.clients.get(m.host);
        if (!host?.name) return;
        this.viewByName.set(host.name, m.view === null ? null : Math.max(0, Math.min(7, m.view | 0)));
        return this.broadcastState();
      }
      case 'play':
        if (!this.fileFeat) return;
        this.leader = c;
        this.setMode({ mode: 'file', start: this.now() + 2500, frames: this.fileFeat.readUInt32LE(1), track: this.trackId });
        for (const o of this.clients.values()) o.ws.send(this.fileFeat);
        return this.broadcastState();
      case 'live':
        this.leader = c;
        this.setMode({ mode: 'live', start: this.now() + 300 });
        return this.broadcastState();
      case 'stop':
        this.leader = null; this.fileFeat = null;
        this.setMode({ mode: 'idle' });
        return this.broadcastState();
    }
  }

  private onBinary(c: Client, m: Buffer): void {
    if (m[0] === 2 && m.length >= 5 && m.length === 5 + m.readUInt32LE(1) * STRIDE) this.fileFeat = m;
    else if (m[0] === 1 && m.length === 5 + STRIDE && this.state.mode === 'live' && c === this.leader) {
      this.ring.push(m); if (this.ring.length > KEEP_TICKS) this.ring.shift();
      for (const o of this.clients.values()) if (o !== c) o.ws.send(m);
    }
  }

  /** Schedule a scene switch on the next beat/bar boundary at least INPUT_DELAY ticks ahead. */
  requestScene(id: string | undefined, step: number | undefined, quant: 'now' | 'beat' | 'bar'): void {
    const { presets, scene, grid } = this.state, t = this.tickNow();
    const showing = sceneAt(scene, t);
    let next = id;
    if (next === undefined) {
      const base = scene.at > t ? scene.id : showing; // stepping again before a pending switch lands
      const i = presets.indexOf(base);
      next = presets[(((i + (step ?? 1)) % presets.length) + presets.length) % presets.length];
    }
    if (!presets.includes(next)) return;
    this.state.scene = { id: next, prev: showing, at: nextBoundary(t + INPUT_DELAY, grid, quant) };
    this.broadcastState();
  }
}
