// The gate's visual sanity checks over render results. Pure, unit-tested (test/lab.test.ts).
import type { RunResult, FrameStat } from '../../src/web/lab.ts';

export const LIMITS = {
  /** A frame is "black" below this mean luma; the run fails when more than `blackShare` of frames are. */
  blackLuma: 0.01, blackShare: 0.8,
  /** A frame is "blown out" when this share of its pixels are white; fails above `whiteShare` of frames. */
  whitePixels: 0.9, whiteShare: 0.5,
  /** Mean thumbnail change (0..1) below which output counts as frozen / identical to silence. */
  still: 0.002,
  /** ms per frame at 1080p on the gate GPU. */
  sceneMs: 12, pieceMs: 4,
};

const thumbDiff = (a: number[], b: number[]) => { let s = 0; for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]); return s / a.length / 255; };

/** Mean change between consecutive checked frames. */
export function motion(stats: FrameStat[]): number {
  if (stats.length < 2) return 0;
  let s = 0;
  for (let i = 1; i < stats.length; i++) s += thumbDiff(stats[i - 1].thumb, stats[i].thumb);
  return s / (stats.length - 1);
}

/** Mean difference from the same ticks rendered on silence: how much the audio changes the picture. */
export function reactivity(run: FrameStat[], silent: FrameStat[]): number {
  const n = Math.min(run.length, silent.length);
  if (!n) return 0;
  let s = 0;
  for (let i = 0; i < n; i++) s += thumbDiff(run[i].thumb, silent[i].thumb);
  return s / n;
}

export interface Check { fixture: string; failures: string[]; notes: string[] }

/** Checks for one render (one fixture). Reactivity is judged across fixtures (see `judgeReactive`). */
export function judgeRun(fixture: string, r: RunResult): Check {
  const failures: string[] = [], notes: string[] = [];
  if (!r.ok) failures.push(`render failed: ${r.error}`);
  if (r.errors.length) {
    // our own one-line messages first (they name the piece file), then WebGPU's, without repeats
    const lines = [...new Set(r.errors.map((e) => e.split('\n')[0].trim()))].sort((a, b) => +b.startsWith('[') - +a.startsWith('['));
    failures.push(`WebGPU / shader errors:\n  ${lines.slice(0, 6).join('\n  ')}`);
  }
  const st = r.stats;
  if (st.length) {
    const black = st.filter((s) => s.luma < LIMITS.blackLuma).length / st.length;
    const white = st.filter((s) => s.white > LIMITS.whitePixels).length / st.length;
    const nan = st.reduce((a, s) => a + s.nan, 0);
    const mot = motion(st);
    // a scene may be calm on quiet music: dark or still there is a warning, not a failure
    const soft = fixture === 'quiet' ? notes : failures, tag = fixture === 'quiet' ? 'warning: ' : '';
    if (black > LIMITS.blackShare) soft.push(`${tag}black: ${(black * 100).toFixed(0)}% of frames have mean luma < ${LIMITS.blackLuma}`);
    if (white > LIMITS.whiteShare) failures.push(`blown out: ${(white * 100).toFixed(0)}% of frames are > ${LIMITS.whitePixels * 100}% white`);
    if (nan) failures.push(`NaN/Inf: ${nan} sampled HDR pixels`);
    if (mot < LIMITS.still) soft.push(`${tag}frozen: frames barely change (motion ${mot.toFixed(4)})`);
    notes.push(`luma ${(st.reduce((a, s) => a + s.luma, 0) / st.length).toFixed(3)}, motion ${mot.toFixed(4)}`);
  }
  return { fixture, failures, notes };
}

/** Fails when no fixture changes the picture compared with silence. */
export function judgeReactive(per: { fixture: string; reactivity: number }[]): string | null {
  const best = Math.max(0, ...per.map((p) => p.reactivity));
  return best < LIMITS.still ? `doesn't react to audio: same picture on silence (best ${best.toFixed(4)} over ${per.map((p) => p.fixture).join(', ')})` : null;
}

export function judgeCost(ms: number, budget: number, what: string): string | null {
  return ms > budget ? `too slow: ${ms.toFixed(2)} ms/frame for ${what} (budget ${budget} ms)` : null;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** JUnit XML: one testcase per item and check. */
export function junit(suite: string, cases: { name: string; classname: string; failure?: string; time?: number; out?: string }[]): string {
  const fails = cases.filter((c) => c.failure).length;
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites><testsuite name="${esc(suite)}" tests="${cases.length}" failures="${fails}">\n` +
    cases.map((c) => `  <testcase name="${esc(c.name)}" classname="${esc(c.classname)}" time="${(c.time ?? 0).toFixed(3)}">` +
      (c.failure ? `<failure message="${esc(c.failure.split('\n')[0].slice(0, 300))}">${esc(c.failure)}</failure>` : '') +
      (c.out ? `<system-out>${esc(c.out)}</system-out>` : '') + '</testcase>').join('\n') +
    '\n</testsuite></testsuites>\n';
}
