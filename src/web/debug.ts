// Debug panel (key `d`): frame-time graph with hitch markers, fps, tick continuity, and whatever
// text sections the page hands it (network, room, MIDI, ...). Costs nothing while hidden except
// the per-frame bookkeeping.
const HIST = 300;

export interface Counters { msgsIn: number; bytesIn: number; msgsOut: number; bytesOut: number }

export class DebugPanel {
  readonly el: HTMLDivElement;
  private cv: HTMLCanvasElement;
  private txt: HTMLPreElement;
  private dts = new Float32Array(HIST);
  private n = 0;
  private last = 0;
  private lastTick = NaN;
  /** Recent hitches: wall time, frame ms. */
  private hitches: { at: number; ms: number }[] = [];
  private tickSkips = 0;
  private tickRepeats = 0;
  private longTasks = 0;
  private visible = false;
  private nextText = 0;
  private sections: () => [string, string[]][];

  /** `controls` sit above the readouts. */
  constructor(sections: () => [string, string[]][], ...controls: HTMLElement[]) {
    this.sections = sections;
    this.el = document.createElement('div');
    this.el.id = 'debug';
    this.el.className = 'hide';
    this.cv = document.createElement('canvas');
    this.cv.width = HIST * 2; this.cv.height = 90;
    this.txt = document.createElement('pre');
    this.txt.id = 'debug-text';
    this.el.append(...controls, this.cv, this.txt);
    document.body.append(this.el);
    try {
      new PerformanceObserver((l) => { this.longTasks += l.getEntries().length; }).observe({ type: 'longtask', buffered: false });
    } catch { /* not supported */ }
  }

  get shown(): boolean { return this.visible; }
  toggle(on = !this.visible): void { this.visible = on; this.el.classList.toggle('hide', !on); }

  /** Call once per rendered frame with the tick it showed. */
  frame(tick: number): void {
    const now = performance.now();
    if (this.last) {
      const dt = now - this.last;
      this.dts[this.n++ % HIST] = dt;
      const med = this.median();
      if (this.n > 30 && dt > Math.max(med * 1.8, med + 8)) {
        this.hitches.push({ at: now, ms: dt });
        if (this.hitches.length > 50) this.hitches.shift();
      }
    }
    this.last = now;
    if (tick > this.lastTick + 1) this.tickSkips += tick - this.lastTick - 1;
    else if (tick === this.lastTick) this.tickRepeats++;
    this.lastTick = tick;
    if (this.visible) { this.draw(); if (now >= this.nextText) { this.nextText = now + 250; this.write(now); } }
  }

  private recent(): Float32Array { const k = Math.min(this.n, HIST); return this.dts.slice(0, k); }
  private median(): number {
    const r = this.recent().sort(); return r.length ? r[r.length >> 1] : 16.7;
  }

  private draw(): void {
    const c = this.cv.getContext('2d')!, w = this.cv.width, h = this.cv.height, med = this.median();
    c.clearRect(0, 0, w, h);
    c.fillStyle = '#0008'; c.fillRect(0, 0, w, h);
    const scale = h / 50; // 50 ms full height
    for (const [ms, col] of [[16.7, '#3a6'], [33.3, '#a63']] as const) {
      c.fillStyle = col; c.fillRect(0, h - ms * scale, w, 1);
    }
    const k = Math.min(this.n, HIST);
    for (let i = 0; i < k; i++) {
      const dt = this.dts[(this.n - k + i) % HIST], bh = Math.min(h, dt * scale);
      c.fillStyle = dt > Math.max(med * 1.8, med + 8) ? '#f44' : dt > med * 1.25 ? '#fc4' : '#7fe3ff';
      c.fillRect(i * 2, h - bh, 2, bh);
    }
  }

  private write(now: number): void {
    const r = this.recent(), med = this.median();
    const sorted = Float32Array.from(r).sort(), p99 = sorted[Math.floor(sorted.length * 0.99)] ?? 0;
    const avg = r.reduce((a, b) => a + b, 0) / (r.length || 1);
    const last10 = this.hitches.filter((x) => now - x.at < 10000);
    const lines: string[] = [
      `fps ${(1000 / avg).toFixed(1)}  median ${med.toFixed(2)}ms  p99 ${p99.toFixed(1)}ms  max ${(sorted[sorted.length - 1] ?? 0).toFixed(1)}ms`,
      `hitches: ${last10.length} in 10s, ${this.hitches.length} kept   long tasks ${this.longTasks}`,
      `ticks: ${this.tickSkips} skipped, ${this.tickRepeats} repeated (since load)`,
      this.hitches.length ? 'last: ' + this.hitches.slice(-6).reverse().map((x) => `${x.ms.toFixed(0)}ms ${((now - x.at) / 1000).toFixed(1)}s ago`).join(', ') : 'last: none',
    ];
    const out = ['── frames', ...lines];
    for (const [title, ls] of this.sections()) out.push(`── ${title}`, ...ls);
    this.txt.textContent = out.join('\n');
  }
}

/** Per-second rates from a running counter. */
export class Rate {
  private prev = { t: performance.now(), c: { msgsIn: 0, bytesIn: 0, msgsOut: 0, bytesOut: 0 } as Counters };
  private rate: Counters = { msgsIn: 0, bytesIn: 0, msgsOut: 0, bytesOut: 0 };
  sample(c: Counters): Counters {
    const now = performance.now(), dt = (now - this.prev.t) / 1000;
    if (dt >= 1) {
      for (const k of Object.keys(c) as (keyof Counters)[]) this.rate[k] = (c[k] - this.prev.c[k]) / dt;
      this.prev = { t: now, c: { ...c } };
    }
    return this.rate;
  }
}
