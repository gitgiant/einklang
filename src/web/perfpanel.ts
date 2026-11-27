// The debug menu's frame-time view, in the app's debug panel and the gallery (key `d`): a histogram of
// frame intervals over a chosen window, the numbers next to it, and a table of the recent scenes and
// transitions. Hidden, it only tallies each frame (framehist.ts); shown, it redraws at ~4 Hz and times
// about ten frames a second on the GPU where the device has timestamp queries.
import { BUCKETS, FrameRecorder, SPANS, grade, reportText, segmentRows, statLines, type ReportInput, type Segment, type ShownTrans, type Span } from './framehist.ts';
import { FrameProfiler } from './gpu/profile.ts';
import type { Engine } from './engine.ts';
import type { Gpu } from './gpu/gpu.ts';

const DRAW_MS = 250, GPU_MS = 100, GPU_KEEP = 600;
const COLORS = { good: '#4c8', ok: '#fc4', bad: '#f55' };
const CSS = `
.perf { display: flex; flex-direction: column; gap: 6px; font: 11px/1.35 ui-monospace, Consolas, monospace; }
.perf .bar { display: flex; flex-wrap: wrap; gap: 4px; align-items: center; }
.perf button { font: inherit; min-height: 32px; padding: 4px 8px; color: #ddd; background: #222; border: 1px solid #555; border-radius: 4px; cursor: pointer; touch-action: manipulation; }
.perf button[aria-pressed=true] { color: #000; background: #ddd; }
.perf button.close { margin-left: auto; min-width: 36px; }
.perf canvas.hist { display: block; width: 100%; height: 130px; }
.perf .stats { white-space: pre-wrap; }
.perf table { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; }
.perf :is(th, td) { text-align: right; padding: 1px 0 1px 6px; font-weight: normal; white-space: nowrap; }
.perf th { color: #999; }
.perf :is(th, td):first-child { text-align: left; padding-left: 0; white-space: normal; overflow-wrap: anywhere; width: 100%; }
.perf textarea { width: 100%; height: 8em; font: 16px monospace; color: #ddd; background: #000; user-select: text; -webkit-user-select: text; }
`;

export interface PerfHost {
  gpu: Gpu;
  sceneName(id: string): string;
  transName(type: string): string;
  /** The ✕ button. */
  close(): void;
}

export class PerfView {
  readonly el = document.createElement('div');
  private rec = new FrameRecorder();
  private host: PerfHost;
  private span: Span = '30s';
  private cv = document.createElement('canvas');
  private stats = document.createElement('div');
  private table = document.createElement('table');
  private said = document.createElement('div');
  private next = 0;
  private visible = false;
  private longTasks = false;
  private prof: FrameProfiler | null = null;
  private sampling = false;
  private reading = false;
  private nextSample = 0;
  private gpuSamples: { at: number; ms: number }[] = [];
  /** Bumped by reset, so a read still in flight is dropped. */
  private epoch = 0;

  constructor(host: PerfHost) {
    this.host = host;
    if (!document.getElementById('perf-css')) {
      const s = document.createElement('style'); s.id = 'perf-css'; s.textContent = CSS; document.head.append(s);
    }
    this.el.className = 'perf';
    const bar = () => { const d = document.createElement('div'); d.className = 'bar'; return d; };
    const button = (text: string, run: () => void) => {
      const b = document.createElement('button'); b.type = 'button'; b.textContent = text;
      b.onclick = () => { run(); b.blur(); }; // keys stay with the page
      return b;
    };
    const spans = bar(), actions = bar();
    const buttons = SPANS.map((s) => button(s.name, () => { this.span = s.id; press(); this.draw(); }));
    const press = () => buttons.forEach((b, i) => b.setAttribute('aria-pressed', String(SPANS[i].id === this.span)));
    press();
    spans.append(...buttons);
    const close = button('✕', () => host.close()); close.className = 'close'; close.setAttribute('aria-label', 'close debug');
    actions.append(button('reset', () => this.reset()), button('copy as text', () => { this.copy(); }), close);
    this.cv.className = 'hist';
    this.stats.className = 'stats';
    this.el.append(actions, this.said, spans, this.cv, this.stats, this.table);
    try {
      this.longTasks = PerformanceObserver.supportedEntryTypes.includes('longtask');
      if (this.longTasks) new PerformanceObserver((l) => { for (const e of l.getEntries()) this.rec.longTask(e.startTime); }).observe({ type: 'longtask', buffered: false });
    } catch { this.longTasks = false; }
    document.addEventListener('visibilitychange', () => this.rec.gap());
  }

  show(on: boolean): void { this.visible = on; this.next = 0; if (!on) this.said.replaceChildren(); }

  /** Before drawing a frame with `engine`: now and then, have its GPU passes timed. */
  before(engine: Engine): void {
    if (!this.visible || this.reading || !this.host.gpu.device.features.has('timestamp-query') || performance.now() < this.nextSample) return;
    this.nextSample = performance.now() + GPU_MS;
    engine.profiler = this.prof ??= new FrameProfiler(this.host.gpu.device);
    this.sampling = true;
  }

  /** After drawing it: `now` = its rAF time, then what it drew. */
  frame(engine: Engine, now: number, scene: string, trans: ShownTrans | null): void {
    if (this.sampling) {
      this.sampling = false; this.reading = true;
      engine.profiler = null;
      const epoch = this.epoch;
      this.prof!.read().then((p) => {
        const ms = Object.values(p.gpu ?? {}).reduce((a, b) => a + b, 0);
        if (ms > 0 && epoch === this.epoch) { this.gpuSamples.push({ at: now, ms }); if (this.gpuSamples.length > GPU_KEEP) this.gpuSamples.shift(); }
      }).catch(() => { /* device lost */ }).finally(() => { this.reading = false; });
    }
    this.rec.frame(now, scene, trans);
    if (this.visible && now >= this.next) { this.next = now + DRAW_MS; this.draw(); }
  }

  private reset(): void {
    this.rec.reset(); this.gpuSamples = []; this.epoch++; this.said.replaceChildren(); this.draw();
  }

  private gpuLine(now: number): string {
    if (!this.host.gpu.device.features.has('timestamp-query')) return 'GPU ms: n/a (no timestamp queries here)';
    const from = this.rec.since(this.span, now), s = this.gpuSamples.filter((x) => x.at >= from).map((x) => x.ms).sort((a, b) => a - b);
    if (!s.length) return 'GPU ms: no samples yet';
    const at = (q: number) => s[Math.max(0, Math.ceil(q * s.length) - 1)].toFixed(1);
    return `GPU ms per frame: median ${at(0.5)}  p95 ${at(0.95)}  worst ${at(1)} (${s.length} sampled while open)`;
  }

  private data(): ReportInput {
    const now = performance.now(), { host } = this;
    const label = (s: Segment) => (s.trans ? `${host.transName(s.trans.type)}: ${host.sceneName(s.trans.from)} → ${host.sceneName(s.trans.to)}` : host.sceneName(s.scene));
    return {
      span: this.span, summary: this.rec.summary(this.span, now), refresh: this.rec.refresh, longTasks: this.longTasks,
      gpu: this.gpuLine(now), rows: segmentRows(this.rec, label),
    };
  }

  private draw(): void {
    if (!this.visible) return;
    const d = this.data();
    this.histogram(d);
    this.stats.textContent = statLines(d).join('\n');
    const row = (tag: 'th' | 'td', cells: string[]) => {
      const tr = document.createElement('tr');
      tr.append(...cells.map((t) => { const c = document.createElement(tag); c.textContent = t; return c; }));
      return tr;
    };
    this.table.replaceChildren(row('th', ['scene / transition', 'med', 'p95', 'worst', 'drop']),
      ...d.rows.map((r) => row('td', [r.name, ...(r.frames ? [r.median.toFixed(1), r.p95.toFixed(1), r.worst.toFixed(0), String(r.dropped)] : ['-', '-', '-', '-'])])));
  }

  private histogram({ summary, refresh }: ReportInput): void {
    const dpr = devicePixelRatio || 1, w = this.cv.clientWidth, h = this.cv.clientHeight;
    if (!w || !h) return; // not on screen (the UI is hidden)
    if (this.cv.width !== Math.round(w * dpr) || this.cv.height !== Math.round(h * dpr)) { this.cv.width = Math.round(w * dpr); this.cv.height = Math.round(h * dpr); }
    const c = this.cv.getContext('2d')!;
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, w, h);
    c.fillStyle = '#0008'; c.fillRect(0, 0, w, h);
    c.font = '10px ui-monospace, Consolas, monospace'; c.textAlign = 'center';
    const slot = w / BUCKETS.length, top = 14, base = h - 26, max = Math.max(1, ...summary.buckets);
    BUCKETS.forEach((b, i) => {
      const x = i * slot, mid = x + slot / 2, pct = summary.buckets[i], bh = pct ? Math.max(1, (pct / max) * (base - top)) : 0;
      const col = COLORS[grade(i, refresh.interval)];
      c.fillStyle = col; c.fillRect(x + 3, base - bh, slot - 6, bh);
      c.fillRect(x + 3, base, slot - 6, 1);
      c.fillStyle = '#ddd';
      if (pct) c.fillText(`${pct < 10 ? pct.toFixed(1) : pct.toFixed(0)}%`, mid, base - bh - 3);
      c.fillText(b.fps, mid, base + 12);
      c.fillStyle = '#999'; c.fillText(b.ms, mid, base + 23, slot - 2);
    });
  }

  /** The report onto the clipboard; where there is none (plain http), shown selected to copy by hand. */
  private async copy(): Promise<void> {
    const { device, adapterInfo } = this.host.gpu;
    const text = reportText(this.data(), [
      `${navigator.userAgent}`,
      `${innerWidth}x${innerHeight} @${devicePixelRatio}x  ·  WebGPU ${adapterInfo}${device.features.has('timestamp-query') ? ' (timestamps)' : ''}`,
    ]);
    this.said.replaceChildren();
    try { await navigator.clipboard.writeText(text); this.said.textContent = 'copied'; return; } catch { /* no clipboard */ }
    const t = document.createElement('textarea'); t.readOnly = true; t.value = text; t.setAttribute('aria-label', 'frame report');
    this.said.append('copy the report:', t); t.focus(); t.select();
  }
}
