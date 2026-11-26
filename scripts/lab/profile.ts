// Profile mode (`npm run lab -- profile`, and part of every gate on a GPU): how much a scene switch
// costs. Each frame is timed on its own (encode + submit + wait for the GPU), with CPU ms per
// engine section and GPU ms per section from timestamp queries when the adapter has them:
//   cold    the first switch on a fresh page (new device, no shader cache): pipelines, targets, B
//   warm    the same switch again
//   scenes  radial -> each scene, first time that scene draws (its own cold start) + A+B steady cost
//   trans   radial -> tunnel with each transition: first frame + the mix's own cost
// Numbers only; nothing here fails the gate.
import type { Lab } from './browser.ts';
import type { ProfileFrame, ProfileOpts } from '../../src/web/lab.ts';
import { TICKS_PER_BEAT } from '../../src/core/constants.ts';

export interface SwitchStat {
  label: string;
  /** Wall ms (serialized: encode + submit + GPU) of the first transition frame. */
  first: number;
  /** Over the transition frames. */
  p50: number; p95: number; max: number; maxAt: number;
  /** A alone before the switch, B alone after (p50). */
  before: number; after: number;
  /** Mean ms per section over the transition frames (from the 2nd frame on). */
  gpu: Record<string, number> | null; cpu: Record<string, number>;
  frames: number;
}

/** Nearest-rank percentile (q 0..1) of `xs`; 0 when empty. */
export function pct(xs: readonly number[], q: number): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1))];
}

const mean = (rows: Record<string, number>[]): Record<string, number> => {
  const sum: Record<string, number> = {};
  for (const r of rows) for (const [k, v] of Object.entries(r)) sum[k] = (sum[k] ?? 0) + v;
  for (const k of Object.keys(sum)) sum[k] /= rows.length || 1;
  return sum;
};

/** Stats for one profiled switch (frames with `at` < 0: before, 0..ticks-1: the transition, after that: B alone). */
export function summarize(label: string, frames: readonly ProfileFrame[], ticks: number): SwitchStat {
  const before = frames.filter((f) => f.at < 0), tr = frames.filter((f) => f.at >= 0 && f.at < ticks), after = frames.filter((f) => f.at >= ticks);
  const walls = tr.map((f) => f.wall), steady = tr.slice(1);
  let max = 0, maxAt = 0;
  for (const f of tr) if (f.wall > max) { max = f.wall; maxAt = f.at; }
  const gpuRows = steady.map((f) => f.gpu).filter((g): g is Record<string, number> => !!g);
  return {
    label, first: tr[0]?.wall ?? 0, p50: pct(walls, 0.5), p95: pct(walls, 0.95), max, maxAt,
    before: pct(before.slice(Math.floor(before.length / 2)).map((f) => f.wall), 0.5), after: pct(after.map((f) => f.wall), 0.5),
    gpu: gpuRows.length ? mean(gpuRows) : null, cpu: mean(steady.map((f) => f.cpu)), frames: tr.length,
  };
}

const ms = (v: number) => v.toFixed(2);
const sections = (r: Record<string, number> | null, keys: string[]) => (r ? keys.map((k) => ms(r[k] ?? 0)).join(' / ') : 'n/a');

export function statTable(rows: SwitchStat[]): string[] {
  return [
    '| switch | A alone p50 | first frame | p50 | p95 | max (at tick) | B alone p50 | GPU a / b / mix / post | CPU a / b / mix / post |',
    '|---|---:|---:|---:|---:|---:|---:|---|---|',
    ...rows.map((r) => `| ${r.label} | ${ms(r.before)} | ${ms(r.first)} | ${ms(r.p50)} | ${ms(r.p95)} | ${ms(r.max)} (${r.maxAt}) | ${ms(r.after)} | ${sections(r.gpu, ['a', 'b', 'mix', 'post'])} | ${sections(r.cpu, ['a', 'b', 'mix', 'post'])} |`),
  ];
}

export interface ProfileReport { adapter: string; res: string; timestamps: boolean; cold: SwitchStat[]; scenes: SwitchStat[]; transitions: SwitchStat[] }

/**
 * Run the profile in `lab` (a page of its own: it reloads it for the cold start). `quick` (no GPU):
 * the cold and warm switch and two transitions only.
 */
export async function profileShow(lab: Lab, o: { scenes: string[]; transitions: string[]; from: string; to: string; fixture?: string; quick?: boolean; res: string; log: (s: string) => void }): Promise<ProfileReport> {
  await lab.reload();
  const fixture = o.fixture ?? 'techno', beat = TICKS_PER_BEAT;
  let tick = 600, timestamps = false;
  const one = async (label: string, x: Omit<ProfileOpts, 'fixture' | 'start'>): Promise<SwitchStat> => {
    const r = await lab.profile({ ...x, fixture, start: tick, sub: 128 });
    tick += x.before + x.ticks + x.after + 1;
    if (!r.ok) throw new Error(`profile ${label}: ${r.error}`);
    timestamps = r.timestamps;
    return summarize(label, r.frames, x.ticks);
  };
  const cold: SwitchStat[] = [], scenes: SwitchStat[] = [], transitions: SwitchStat[] = [];
  const long = { before: 60, ticks: 8 * beat, after: 30 };
  cold.push(await one(`cold: ${o.from} → ${o.to}, core-blend 8 beats (fresh page)`, { from: o.from, to: o.to, trans: 'core-blend', ...long }));
  cold.push(await one(`warm: the same switch again`, { from: o.from, to: o.to, trans: 'core-blend', ...long }));
  o.log(`profile: cold switch first frame ${ms(cold[0].first)} ms, max ${ms(cold[0].max)} ms; warm ${ms(cold[1].first)} / ${ms(cold[1].max)} ms`);
  const short = { before: 30, ticks: 4 * beat, after: 10 };
  for (const s of o.quick ? [] : o.scenes.filter((x) => x !== o.from && x !== o.to)) {
    scenes.push(await one(`${o.from} → ${s}`, { from: o.from, to: s, trans: 'core-blend', ...short }));
  }
  for (const t of o.quick ? o.transitions.slice(0, 2) : o.transitions) {
    transitions.push(await one(t, { from: o.from, to: o.to, trans: t, before: 20, ticks: 4 * beat, after: 5 }));
  }
  return { adapter: lab.adapter, res: o.res, timestamps, cold, scenes, transitions };
}

export function profileMd(r: ProfileReport): string[] {
  return [
    '## Switch profile', '',
    `${r.adapter}, ${r.res}; frames timed one by one (encode + submit + GPU done), ms. GPU per section from timestamp queries: ${r.timestamps ? 'yes' : 'not available here'}.`,
    'Sections: a = outgoing scene, b = incoming scene, mix = core-transition, post = core-post (+ canvas).', '',
    '### First switch', '', ...statTable(r.cold), '',
    ...(r.scenes.length ? ['### Into each scene (its first time on screen, core-blend 4 beats)', '', ...statTable(r.scenes), ''] : []),
    '### Each transition (radial → tunnel, 4 beats, warm)', '', ...statTable(r.transitions), '',
  ];
}
