// Frame times for the HUD: the median and p95 of the last ~2 s of frames, and the worst frame of
// the last scene switch (so a drop during a transition can be read off a phone). A frame's cost
// shows up in the gap before the next one, so a switch's window runs one frame past its end.

const HIST = 120;

export interface SwitchFrames {
  type: string;
  /** Longest frame interval (ms) during the switch, and its average. */
  worst: number; avg: number;
  /** Longest of the first three intervals: the start-of-switch hitch. */
  start: number;
  frames: number;
}

export class FrameStats {
  private dts = new Float64Array(HIST);
  private n = 0;
  private last = 0;
  private cur: (SwitchFrames & { sum: number; tail: boolean }) | null = null;
  /** The last switch that finished. */
  lastSwitch: SwitchFrames | null = null;

  /** Once per drawn frame, after drawing it: `trans` = the transition it drew (its type), or null. */
  frame(now: number, trans: string | null): void {
    const dt = this.last ? now - this.last : 0;
    this.last = now;
    if (dt > 0 && dt < 5000) this.dts[this.n++ % HIST] = dt;
    // the interval after a switch's last frame belonged to it; the one after that doesn't
    if (this.cur?.tail) this.finish();
    const c = this.cur;
    if (c && dt > 0) {
      c.frames++; c.sum += dt; c.worst = Math.max(c.worst, dt);
      if (c.frames <= 3) c.start = Math.max(c.start, dt);
    }
    if (trans && (!c || c.type !== trans)) {
      if (c) this.finish();
      this.cur = { type: trans, worst: 0, avg: 0, start: 0, frames: 0, sum: 0, tail: false };
    } else if (!trans && c) c.tail = true;
  }

  private finish(): void {
    const c = this.cur!;
    this.cur = null;
    if (c.frames) this.lastSwitch = { type: c.type, worst: c.worst, avg: c.sum / c.frames, start: c.start, frames: c.frames };
  }

  /** Median and p95 frame interval (ms) over the last HIST frames. */
  recent(): { p50: number; p95: number } {
    const k = Math.min(this.n, HIST);
    if (!k) return { p50: 0, p95: 0 };
    const s = Array.from(this.dts.subarray(0, k)).sort((a, b) => a - b);
    return { p50: s[Math.floor(k / 2)], p95: s[Math.min(k - 1, Math.ceil(0.95 * k) - 1)] };
  }

  /** One HUD line, e.g. `frame 16.7 ms (60 fps, p95 18.0)  ·  last switch blend: worst 41.2 ms, start 33.0, avg 17.1`. */
  line(name: (type: string) => string = (t) => t): string {
    const r = this.recent(), f = (v: number) => v.toFixed(1);
    const s = this.lastSwitch;
    return `frame ${f(r.p50)} ms (${r.p50 ? Math.round(1000 / r.p50) : 0} fps, p95 ${f(r.p95)})` +
      (s ? `  ·  last switch ${name(s.type)}: worst ${f(s.worst)} ms, start ${f(s.start)}, avg ${f(s.avg)}` : '  ·  no switch yet');
  }
}
