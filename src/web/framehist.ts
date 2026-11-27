// The logic behind the debug menu's frame-time histogram (perfpanel.ts draws it): tallies of frame
// intervals over the last seconds, the current scene, since load, and each recent scene / transition,
// plus the display's refresh rate as seen from requestAnimationFrame. No DOM, so node tests it.

/** Fine bins of the tallies: percentiles come out to this precision (ms); longer frames share the last bin. */
const BIN = 0.1, BINS = 5001;
/** Slack on bucket edges: rAF intervals jitter (Safari rounds to 1 ms), a 60 Hz frame is a 60 fps one. */
export const SLACK = 0.7;
/** Upper edges (ms) of the histogram's buckets; the last one is open. */
export const EDGES = [1000 / 120, 1000 / 90, 1000 / 60, 20, 1000 / 30, 50, Infinity];
export const BUCKETS: readonly { ms: string; fps: string }[] = [
  { ms: '<8.3', fps: '120' }, { ms: '8.3-11.1', fps: '90' }, { ms: '11.1-16.7', fps: '60' }, { ms: '16.7-20', fps: '50' },
  { ms: '20-33', fps: '30' }, { ms: '33-50', fps: '20' }, { ms: '>50', fps: '<20' },
];
export const bucketOf = (ms: number): number => EDGES.findIndex((e) => ms <= e + SLACK);

/** A frame this much longer than the refresh interval counts as dropped. */
export const DROP = 1.5;
export type Grade = 'good' | 'ok' | 'bad';
/** How bucket `i` rates on a display refreshing every `interval` ms. */
export function grade(i: number, interval: number): Grade {
  if ((i ? EDGES[i - 1] : 0) < interval * 0.95) return 'good'; // holds the refresh interval, or faster
  return EDGES[i] <= interval * DROP + 0.01 ? 'ok' : 'bad';
}

export interface Summary {
  frames: number;
  /** All the intervals added up (ms). */
  time: number;
  avg: number; median: number; p95: number; p99: number; worst: number; fps: number;
  dropped: number;
  /** % of frames per bucket. */
  buckets: number[];
}

export class Tally {
  private bins = new Uint32Array(BINS);
  private frames = 0;
  private time = 0;
  private worst = 0;

  add(ms: number): void {
    this.bins[Math.min(BINS - 1, Math.round(ms / BIN))]++;
    this.frames++; this.time += ms;
    if (ms > this.worst) this.worst = ms;
  }

  summary(interval: number): Summary {
    const n = this.frames, buckets = BUCKETS.map(() => 0);
    // nearest-rank percentiles
    const ranks = [0.5, 0.95, 0.99].map((q) => Math.max(1, Math.ceil(q * n - 1e-9))), at = [0, 0, 0];
    let seen = 0, dropped = 0;
    for (let i = 0; i < BINS && seen < n; i++) {
      const c = this.bins[i];
      if (!c) continue;
      const ms = i === BINS - 1 ? this.worst : i * BIN;
      ranks.forEach((r, k) => { if (seen < r && seen + c >= r) at[k] = ms; });
      seen += c;
      buckets[bucketOf(ms)] += c;
      if (ms > interval * DROP) dropped += c;
    }
    const avg = n ? this.time / n : 0;
    return {
      frames: n, time: this.time, avg, median: at[0], p95: at[1], p99: at[2], worst: this.worst, fps: avg ? 1000 / avg : 0,
      dropped, buckets: buckets.map((c) => (n ? (100 * c) / n : 0)),
    };
  }
}

const RATES = [60, 72, 75, 90, 100, 120, 144, 165, 180, 240];
/**
 * The display's refresh rate from rAF intervals: the short end (10th percentile) of each batch,
 * snapped to a common rate; the fastest seen holds, so slow stretches don't lower it. Never under
 * 60 Hz: a page that only manages 30 fps is dropping frames, not on a 30 Hz display.
 */
export class Refresh {
  private batch: number[] = [];
  hz = 60;
  /** False until a first batch is in. */
  measured = false;
  get interval(): number { return 1000 / this.hz; }
  add(ms: number): void {
    this.batch.push(ms);
    if (this.batch.length < 90) return;
    const low = this.batch.sort((a, b) => a - b)[this.batch.length / 10 | 0];
    this.batch.length = 0;
    const hz = 1000 / Math.max(1, low), near = RATES.reduce((a, b) => (Math.abs(Math.log(b / hz)) < Math.abs(Math.log(a / hz)) ? b : a));
    this.hz = this.measured ? Math.max(this.hz, near) : near;
    this.measured = true;
  }
}

export type Span = '5s' | '30s' | 'scene' | 'load';
export const SPANS: readonly { id: Span; name: string }[] = [
  { id: '5s', name: '5 s' }, { id: '30s', name: '30 s' }, { id: 'scene', name: 'since scene start' }, { id: 'load', name: 'since load' },
];

export interface ShownTrans { type: string; from: string; to: string }
/** A stretch showing one scene alone, or one transition. */
export interface Segment { scene: string; trans: ShownTrans | null; tally: Tally }

/** 30 s of frames at 240 Hz, with room to spare. */
const RING = 8192;
export const SEGMENTS = 10;
/** A longer gap is the page having slept, not a frame. */
const MAX_FRAME = 5000;

export class FrameRecorder {
  private at = new Float64Array(RING);
  private dt = new Float32Array(RING);
  private n = 0;
  private last = 0;
  private all = new Tally();
  private sceneTally = new Tally();
  private scene = '';
  private sceneAt = 0;
  private tasks: number[] = [];
  private taskCount = 0;
  refresh = new Refresh();
  /** Newest first. */
  segments: Segment[] = [];

  /**
   * Once per drawn frame: `now` = its rAF time, then what it draws. The interval that ends here is
   * the previous frame's cost, so it counts for what that one drew.
   */
  frame(now: number, scene: string, trans: ShownTrans | null): void {
    const ms = this.last ? now - this.last : 0;
    this.last = now;
    if (ms > 0 && ms < MAX_FRAME) {
      const i = this.n++ % RING;
      this.at[i] = now; this.dt[i] = ms;
      this.refresh.add(ms);
      this.all.add(ms); this.sceneTally.add(ms); this.segments[0]?.tally.add(ms);
    }
    // "since scene start" starts with the switch into the scene
    const target = trans ? trans.to : scene;
    if (target !== this.scene) { this.scene = target; this.sceneAt = now; this.sceneTally = new Tally(); }
    const s = this.segments[0], t = s?.trans;
    if (!s || (trans ? !t || t.type !== trans.type || t.from !== trans.from || t.to !== trans.to : t !== null || s.scene !== scene)) {
      this.segments.unshift({ scene: target, trans: trans && { type: trans.type, from: trans.from, to: trans.to }, tally: new Tally() });
      if (this.segments.length > SEGMENTS) this.segments.pop();
    }
  }

  /** The page was hidden: the next interval is not a frame. */
  gap(): void { this.last = 0; }

  longTask(startedAt: number): void {
    this.taskCount++;
    this.tasks.push(startedAt);
    if (this.tasks.length > 1000) this.tasks.shift();
  }

  /** Where `span` begins, in rAF time. */
  since(span: Span, now: number): number {
    return span === '5s' ? now - 5000 : span === '30s' ? now - 30000 : span === 'scene' ? this.sceneAt : 0;
  }

  summary(span: Span, now: number): Summary & { longTasks: number } {
    const from = this.since(span, now), interval = this.refresh.interval;
    let tally = span === 'scene' ? this.sceneTally : this.all;
    if (span === '5s' || span === '30s') {
      tally = new Tally();
      for (let k = 1; k <= Math.min(this.n, RING); k++) {
        const i = (this.n - k) % RING;
        if (this.at[i] <= from) break;
        tally.add(this.dt[i]);
      }
    }
    return { ...tally.summary(interval), longTasks: span === 'load' ? this.taskCount : this.tasks.filter((t) => t >= from).length };
  }

  /** Forget everything measured. */
  reset(): void {
    this.n = 0; this.last = 0; this.scene = ''; this.sceneAt = 0; this.tasks = []; this.taskCount = 0;
    this.all = new Tally(); this.sceneTally = new Tally(); this.refresh = new Refresh(); this.segments = [];
  }
}

export interface ReportInput {
  span: Span;
  summary: Summary & { longTasks: number };
  refresh: Refresh;
  /** Whether the browser reports long tasks at all. */
  longTasks: boolean;
  /** The GPU line. */
  gpu: string;
  rows: SegmentRow[];
}
export interface SegmentRow { name: string; frames: number; median: number; p95: number; worst: number; dropped: number }

export const segmentRows = (r: FrameRecorder, label: (s: Segment) => string): SegmentRow[] =>
  r.segments.map((s) => {
    const t = s.tally.summary(r.refresh.interval);
    return { name: label(s), frames: t.frames, median: t.median, p95: t.p95, worst: t.worst, dropped: t.dropped };
  });

const f = (v: number) => v.toFixed(1);
/** The numbers next to the histogram. */
export function statLines({ summary: s, refresh, longTasks, gpu }: ReportInput): string[] {
  return [
    `fps ${f(s.fps)}   display ${refresh.hz} Hz${refresh.measured ? '' : ' (assumed)'}   ${s.frames} frames, ${f(s.time / 1000)} s`,
    `frame ms: avg ${f(s.avg)}  median ${f(s.median)}  p95 ${f(s.p95)}  p99 ${f(s.p99)}  worst ${f(s.worst)}`,
    `dropped ${s.dropped} (${f(s.frames ? (100 * s.dropped) / s.frames : 0)}%, > ${f(refresh.interval * DROP)} ms)   long tasks ${longTasks ? s.longTasks : 'n/a'}`,
    gpu,
  ];
}

/** Everything as plain text, for pasting into a chat. */
export function reportText(r: ReportInput, device: string[] = []): string {
  return [
    `einklang frames · ${SPANS.find((s) => s.id === r.span)!.name}`,
    ...device,
    ...statLines(r),
    '',
    'frame ms (fps)    % of frames',
    ...BUCKETS.map((b, i) => `${`${b.ms} (${b.fps})`.padEnd(18)}${f(r.summary.buckets[i]).padStart(5)}%`),
    '',
    'recent scenes and transitions, newest first (median / p95 / worst ms, dropped / frames)',
    ...r.rows.map((x) => `${x.name}: ${x.frames ? `${f(x.median)} / ${f(x.p95)} / ${f(x.worst)}, ${x.dropped}/${x.frames}` : '-'}`),
  ].join('\n');
}
