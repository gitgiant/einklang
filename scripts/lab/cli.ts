// einklang-lab: the agents' sandbox. Run as `npm run lab -- <command>`.
//
//   validate [--no-compile]        manifests, scenes, port types, imports, folder sizes, transitions
//                                  (lab/transitions/: schema, and the assembled shader compiles in headless Chrome)
//   render <scene|piece|transition> [opts]   render a scene (or a piece in its harness, or a transition
//                                  between two fixed scenes, contact sheet over its progress) against a fixture:
//                                  contact sheet, webm and stats in lab/out/<id>/<fixture>/, plus the checks
//     --fixture quiet|techno|dense|silence|<lab/fixtures/x.feat>|all   (default techno)
//     --seconds 4  --res 640x360  --cpu (force SwiftShader)  --no-video
//     --media test|image|video|none   what core-media shows (generated in the page; default test = image, then video)
//     --sections all|auto|<id>   a scene with sections: all (default) forces base then each variant in turn,
//                                  auto lets `when` pick (the fixtures have no song structure), <id> shows one
//   gate [--all] [--junit file]    the merge gate: validate, then render every changed scene/piece/transition
//                                  (or all with --all) 8 s per fixture at 1080p on the GPU and check:
//                                  errors, NaN, black, blown out, frozen, no audio reaction, ms/frame
//                                  (a transition: no audio check, budget 2 ms over core-blend)
//                                  a scene with sections renders base and then each variant in turn (forced) and
//                                  each one is also judged on its own frames
//                                  then (GPU only, skip with --no-profile) the switch profile below, into the log and gate.md
//   profile [--quick] [--res 1920x1080]   switch profile (scripts/lab/profile.ts): frame ms p50/p95/max over a scene
//                                  switch, the first-frame hitch, GPU ms per pass section (timestamp queries), and every
//                                  section change of the scenes with sections;
//                                  lab/out/profile.md + profile.json
//   new <kind> <vendor-slug> [--driver]   scaffold a piece (auto-shader unless --driver)
//   new transition <vendor-slug>   scaffold lab/transitions/<id>/ (transition.json + mix.wgsl)
//   fixtures                       list fixtures
//   import-space-sim [--src dir]   copy space_sim's own .vox assets into lab/assets/vox/ (+ index.json)
//   sprite gen "<prompt>" --name id [--size 32] [--frames 4] [--palette <style|#hex,..>] [--colors 16]
//                                  AI sprite via the image API: only with the brief's EINKLANG_IMAGEGEN=N and the host's
//                                  monthly cap (scripts/lab/imagegen.ts); --from-png f --license L skips the API
//   sprite import <png|aseprite.json|gif|vox|x.sprite.json> --license L [--source S] [--name id] [--frame WxH] [--count n]
//                                  -> lab/assets/sprites/<name>.spr (+ index.json)
//   font bake <file.ttf|builtin:pixel5x8> --name id --license L [--source S] [--size 48] [--license-file f]
//                                  -> lab/assets/fonts/<id>.efont (msdf from a TrueType font, bitmap for the pixel font)
//   evolve show <scene> [--steps 12]   an evolving scene's states step by step (pieces + params, scores in effect)
//   evolve freeze <scene> <state> [--id id] [--name n]   write a state as a scene of its own with parent = <scene>:
//                                  <state> is a key from FEEDBACK.md "Evolving scenes" (its voted params) or a step (s12 / 12)
//   feedback [--votes file]        vote digest: lab/feedback.json + lab/FEEDBACK.md from data/votes.jsonl, and
//                                  scenes at net <= -2 get status retired (commit the result)
// Spec: docs/prd-lab.md.
import { mkdirSync, writeFileSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { loadPieces, loadScenes, loadScores, loadStyles, LAB } from './load.ts';
import { freezeScene, stateAt, stateInfo, withEvolve, type EvolveInfo } from '../../src/core/graph/evolve.ts';
import { strHash } from '../../src/core/graph/eval.ts';
import { hex8 } from '../../src/core/math.ts';
import { applyStyle, validateStyle } from '../../src/core/graph/style.ts';
import { lintPieces } from './lint.ts';
import { importSpaceSim, DEFAULT_SRC, vendorAsset } from './import.ts';
import { importSprite, parsePalette } from './sprites.ts';
import { previewDir, spriteGen } from './imagegen.ts';
import { encodePng } from './png.ts';
import { bakeMsdf, bakePixelFont, parseTtf } from './fonts.ts';
import { encodeFont, encodeSheet, sheetRgba, type Sheet } from '../../lab/api/index.ts';
import { basename } from 'node:path';
import { digest, feedbackMd, type Digest } from './feedback.ts';
import { parseVotes } from '../../src/core/votes.ts';
import '../../src/server/transitions.ts'; // installs the transition registry
import { transitions } from '../../src/core/transitions.ts';
import { openLab, type Lab } from './browser.ts';
import { profileMd, profileShow } from './profile.ts';
import { judgeCost, judgeReactive, judgeRun, junit, reactivity, LIMITS } from './checks.ts';
import { validateScene } from '../../src/core/graph/validate.ts';
import { sectionIds } from '../../src/core/graph/sections.ts';
import { harness } from '../../src/core/graph/harness.ts';
import { FIXTURES } from '../../src/core/fixtures.ts';
import type { Registry, SceneGraph } from '../../src/core/graph/types.ts';
import type { RunOpts, RunResult } from '../../src/web/lab.ts';
import { PIECE_KINDS, type PieceKind } from '../../lab/api/index.ts';
import { newTransition, validateTransitions, curveList, TRANS_BUDGET_MS, TRANS_FROM, TRANS_TO } from './transitions.ts';

const OUT = resolve(LAB, 'out');
const argv = process.argv.slice(2);
const flag = (n: string) => argv.includes(`--${n}`);
const opt = (n: string, d: string) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const positional = argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && argv[i - 1].startsWith('--') && !['--cpu', '--all', '--driver', '--no-video', '--no-compile', '--no-profile', '--quick'].includes(argv[i - 1])));
const say = (s: string) => process.stdout.write(s + '\n');
/** Ticks start here so modulators have history to look back at. */
const START = 600;

async function validate(): Promise<{ reg: Registry; scenes: SceneGraph[]; transitions: string[]; errors: string[] }> {
  const { reg, errors } = await loadPieces();
  const styleList = loadStyles(), styles = new Map(styleList.map((s) => [s.id, s]));
  for (const s of styleList) errors.push(...validateStyle(s, reg));
  const scenes: SceneGraph[] = [], scores = loadScores();
  for (const g of loadScenes()) {
    try { scenes.push(withEvolve(applyStyle(g, styles, reg), reg, scores)); } catch (e) { errors.push((e as Error).message); }
  }
  const ids = new Set<string>();
  for (const s of scenes) {
    errors.push(...validateScene(s, reg));
    if (ids.has(s.id)) errors.push(`${s.id}: duplicate scene id`);
    ids.add(s.id);
  }
  errors.push(...lintPieces());
  const tr = await validateTransitions({ compile: !flag('no-compile'), note: say });
  errors.push(...tr.errors);
  return { reg, scenes, transitions: tr.ids, errors };
}

type Target = { id: string; scene: SceneGraph | string; base?: SceneGraph; piece: boolean; transition?: boolean };
/** A scene id, a piece id (rendered in its harness), or a transition id. */
function target(name: string, reg: Registry, scenes: SceneGraph[], transitions: string[] = []): Target {
  const s = scenes.find((x) => x.id === name);
  if (s) return { id: s.id, scene: s, piece: false };
  if (transitions.includes(name)) return { id: name, scene: TRANS_FROM, piece: false, transition: true };
  if (reg.has(name)) {
    const h = harness(name, reg), b = harness(name, reg, true);
    if (typeof h === 'string') throw new Error(h);
    return { id: name, scene: h, base: typeof b === 'string' ? undefined : b, piece: true };
  }
  throw new Error(`no scene, piece or transition named ${name}`);
}

const save = (dir: string, r: RunResult, video: boolean) => {
  mkdirSync(dir, { recursive: true });
  if (r.sheet) writeFileSync(join(dir, 'sheet.png'), Buffer.from(r.sheet, 'base64'));
  if (video && r.video) writeFileSync(join(dir, 'video.webm'), Buffer.from(r.video, 'base64'));
  writeFileSync(join(dir, 'stats.json'), JSON.stringify({ ok: r.ok, error: r.error, errors: r.errors, adapter: r.adapter, msPerFrame: r.msPerFrame, frames: r.stats.map(({ thumb: _t, ...s }) => s) }, null, 1));
};

interface ItemResult { id: string; failures: string[]; notes: string[]; ms: number; dir: string }

/** Render one scene/piece over fixtures with the checks; artifacts go to lab/out/<id>/. */
const DBG: { name: string; classname: string; failure: string }[] = [];
async function check(lab: Lab, t: Target, fixtures: string[], seconds: number, opts: { video: boolean; budget: boolean; media?: RunOpts['media']; sections?: string }): Promise<ItemResult> {
  if (t.transition) return checkTransition(lab, t.id, fixtures, seconds, opts);
  const ticks = Math.round(seconds * 60), dir = join(OUT, t.id), perf = lab.cpu ? 30 : 120;
  // SwiftShader is ~50x slower: fewer video frames there
  const base: Omit<RunOpts, 'scene' | 'fixture'> = { start: START, ticks, every: 10, sheet: 12, fps: opts.video ? (lab.cpu ? 15 : 30) : 0, videoWidth: 640, perfFrames: 0, media: opts.media, sections: opts.sections };
  const failures: string[] = [], notes: string[] = [], react: { fixture: string; reactivity: number }[] = [];
  let ms = 0;
  for (const [i, fx] of fixtures.entries()) {
    const r = await lab.run({ ...base, scene: t.scene, fixture: fx, perfFrames: i === 0 ? perf : 0 });
    save(join(dir, fx), r, opts.video);
    const c = judgeRun(fx, r);
    failures.push(...c.failures.map((f) => `[${fx}] ${f}`)); notes.push(`[${fx}] ${c.notes.join(', ')}`);
    // a scene with sections: the run forced each in turn; judge each one's frames on its own too
    for (const [sec, stats] of sectionStats(r)) {
      const sc = judgeRun(fx, { ...r, ok: true, errors: [], stats });
      failures.push(...sc.failures.map((f) => `[${fx}] section ${sec}: ${f}`));
      notes.push(`[${fx}] section ${sec}: ${sc.notes.join(', ')}`);
    }
    if (i === 0) ms = r.msPerFrame;
    if (r.ok && fx !== 'silence') {
      const quiet = await lab.run({ ...base, scene: t.scene, fixture: 'silence', fps: 0, sheet: 0 });
      if (!quiet.ok) failures.push(`[silence] render failed: ${quiet.error}`);
      react.push({ fixture: fx, reactivity: reactivity(r.stats, quiet.stats) });
    }
  }
  if (react.length) {
    const f = judgeReactive(react);
    if (f) failures.push(f);
    notes.push(`audio reaction ${react.map((x) => `${x.fixture} ${x.reactivity.toFixed(4)}`).join(', ')}`);
  }
  if (t.piece && t.base) {
    const b = await lab.run({ ...base, scene: t.base, fixture: fixtures[0], ticks: 30, every: 1000, sheet: 0, fps: 0, perfFrames: perf });
    ms = Math.max(0, ms - b.msPerFrame);
    notes.push(`cost ${ms.toFixed(2)} ms/frame over its harness (${b.msPerFrame.toFixed(2)} ms)`);
  } else notes.push(`cost ${ms.toFixed(2)} ms/frame (whole show: scene + post)`);
  if (opts.budget) {
    const f = judgeCost(ms, t.piece ? LIMITS.pieceMs : LIMITS.sceneMs, t.piece ? 'the piece' : 'the scene');
    if (f) failures.push(f);
  }
  if (t.id.includes('comic')) { // DEBUG: numbers and a rough look, reverted after the run
    const ramp = ' .:-=+*#%@';
    const art = (st: { thumb: number[]; section?: string }[]) => {
      const pick = Array.from({ length: 6 }, (_, i) => st[Math.min(st.length - 1, Math.floor((i + 0.5) * st.length / 6))]).filter(Boolean);
      const rows: string[] = [pick.map((f) => (f.section ?? '-').padEnd(32)).join(' ')];
      for (let y = 0; y < 8; y++) rows.push(pick.map((f) => { let l = ''; for (let x = 0; x < 32; x++) { let a = 0, n = 0; for (let yy = Math.floor(y * 4.5); yy < Math.floor((y + 1) * 4.5); yy++) for (let xx = 0; xx < 2; xx++) { a += f.thumb[yy * 64 + x * 2 + xx]; n++; } l += ramp[Math.min(9, Math.floor(a / n / 256 * 10))]; } return l; }).join(' '));
      return rows.join('\n');
    };
    const tech = await lab.run({ ...base, scene: t.scene, fixture: 'techno', fps: 0, sheet: 0 });
    const none = await lab.run({ ...base, scene: t.scene, fixture: 'techno', fps: 0, sheet: 0, media: 'none' });
    failures.unshift(`DEBUG ${t.id} ms ${ms.toFixed(2)} :: ${notes.join(' | ')}\n${art(tech.stats)}\n${none.ok ? art(none.stats) : 'none failed ' + none.error}`);
    const big = (f: { thumb: number[]; section?: string; tick: number }) => { const rows = []; for (let y = 0; y < 18; y++) { let l = ''; for (let x = 0; x < 64; x++) l += ramp[Math.min(9, Math.floor((f.thumb[2 * y * 64 + x] + f.thumb[(2 * y + 1) * 64 + x]) / 2 / 256 * 10))]; rows.push('|' + l + '|'); } return rows.join('\n'); };
    const at = (st: { thumb: number[]; section?: string; tick: number }[], n: number) => Array.from({ length: n }, (_, i) => st[Math.min(st.length - 1, Math.floor((i + 0.5) * st.length / n))]).filter(Boolean);
    for (const [tag, st, n] of [['media', tech.stats, t.piece ? 3 : 6], ['none', none.stats, 3]] as const) for (const f of at(st, n)) DBG.push({ name: `zz ${t.id} ${tag} ${f.section ?? '-'} t${f.tick}`, classname: 'lab.debug', failure: `frame\n${big(f)}` });
  }
  return { id: t.id, failures, notes, ms, dir };
}

/** A run's checked frames grouped by the section showing (empty for a scene without sections). */
function sectionStats(r: RunResult): Map<string, RunResult['stats']> {
  const m = new Map<string, RunResult['stats']>();
  for (const s of r.stats) if (s.section) { const l = m.get(s.section) ?? []; l.push(s); m.set(s.section, l); }
  return m.size > 1 ? m : new Map();
}

/**
 * A transition from TRANS_FROM to TRANS_TO over the whole run (the contact sheet walks its progress),
 * per fixture with the usual checks but no audio test (the scenes react, not the mix); cost = the
 * show mid-transition minus the same with core-blend.
 */
async function checkTransition(lab: Lab, id: string, fixtures: string[], seconds: number, opts: { video: boolean; budget: boolean }): Promise<ItemResult> {
  const ticks = Math.round(seconds * 60), dir = join(OUT, id), perf = lab.cpu ? 30 : 120;
  const base: Omit<RunOpts, 'fixture'> = { scene: TRANS_FROM, start: START, ticks, every: 10, sheet: 12, fps: opts.video ? (lab.cpu ? 15 : 30) : 0, videoWidth: 640, perfFrames: 0 };
  const failures: string[] = [], notes: string[] = [];
  for (const fx of fixtures) {
    const r = await lab.run({ ...base, fixture: fx, transition: { id, from: TRANS_FROM, to: TRANS_TO, at: START, ticks } });
    save(join(dir, fx), r, opts.video);
    const c = judgeRun(fx, r);
    failures.push(...c.failures.map((f) => `[${fx}] ${f}`)); notes.push(`[${fx}] ${c.notes.join(', ')}`);
  }
  // cost: 30 ticks in, then perf frames, all inside a transition that runs past them
  const cost = async (tid: string) => (await lab.run({ ...base, fixture: fixtures[0], ticks: 30, every: 1000, sheet: 0, fps: 0, perfFrames: perf,
    transition: { id: tid, from: TRANS_FROM, to: TRANS_TO, at: START, ticks: 30 + 2 * perf } })).msPerFrame;
  const mine = await cost(id), blend = id === 'core-blend' ? mine : await cost('core-blend'), ms = Math.max(0, mine - blend);
  notes.push(`cost ${ms.toFixed(2)} ms/frame over core-blend (show ${mine.toFixed(2)} ms, with blend ${blend.toFixed(2)} ms)`);
  if (opts.budget) { const f = judgeCost(ms, TRANS_BUDGET_MS, 'the transition (over core-blend)'); if (f) failures.push(f); }
  return { id, failures, notes, ms, dir };
}

/** The switch profile in a browser of its own (cold: no shader cache); markdown lines, also in lab/out/profile.md. */
async function runProfile(w: number, h: number, transitions: string[], all: SceneGraph[], o: { cpu: boolean; quick: boolean; gpuOnly?: boolean }): Promise<string[]> {
  const scenes = all.map((s) => s.id), acts = all.filter((s) => s.sections || s.evolve).map((s) => ({ scene: s.id, sections: sectionIds(s) }));
  const lab = await openLab({ width: w, height: h, cpu: o.cpu, cold: true, log: say });
  try {
    if (lab.cpu && o.gpuOnly) return ['## Switch profile', '', 'skipped: no GPU here', ''];
    const r = await profileShow(lab, { scenes, acts, transitions, from: TRANS_FROM, to: TRANS_TO, res: `${w}x${h}`, quick: o.quick || lab.cpu, log: say });
    const md = profileMd(r);
    mkdirSync(OUT, { recursive: true });
    writeFileSync(join(OUT, 'profile.md'), md.join('\n') + '\n');
    writeFileSync(join(OUT, 'profile.json'), JSON.stringify(r, null, 1));
    return md;
  } finally { await lab.close(); }
}

const report = (r: ItemResult) => {
  say(`${r.failures.length ? 'FAIL' : 'ok  '} ${r.id}`);
  for (const n of r.notes) say(`       ${n}`);
  for (const f of r.failures) say(`     ✗ ${f.replace(/\n/g, '\n       ')}`);
  say(`       artifacts: ${r.dir}`);
};

/** Files changed on this branch (vs its merge base with main) plus uncommitted and untracked ones; null = can't tell / nothing. */
function changed(): string[] | null {
  const git = (...a: string[]) => execFileSync('git', a, { cwd: resolve(LAB, '..'), encoding: 'utf8' }).trim();
  try {
    let base = '';
    for (const ref of ['origin/main', 'main']) { try { base = git('merge-base', 'HEAD', ref); break; } catch { /* next */ } }
    const files = [
      ...(base && base !== git('rev-parse', 'HEAD') ? git('diff', '--name-only', `${base}...HEAD`).split(/\r?\n/) : []),
      ...git('diff', '--name-only', 'HEAD').split(/\r?\n/),
      ...git('ls-files', '--others', '--exclude-standard').split(/\r?\n/),
    ].filter(Boolean);
    return files.length ? [...new Set(files)] : null;
  } catch { return null; }
}

async function main() {
  const cmd = positional[0];
  if (cmd === 'validate') {
    const { reg, scenes, transitions, errors } = await validate();
    for (const e of errors) say(`✗ ${e}`);
    say(errors.length ? `${errors.length} problem(s)` : `ok: ${reg.size} pieces, ${scenes.length} scenes, ${transitions.length} transitions`);
    process.exit(errors.length ? 1 : 0);
  }
  if (cmd === 'fixtures') {
    say(`built in: ${[...FIXTURES, 'silence'].join(', ')}`);
    const dir = join(LAB, 'fixtures');
    if (existsSync(dir)) say(`files: ${readdirSync(dir).filter((f) => f.endsWith('.feat')).join(', ') || '-'}`);
    return;
  }
  if (cmd === 'sprite' && positional[1] === 'import') {
    const file = positional[2];
    if (!file) throw new Error('usage: sprite import <file> --license L [--source S] [--name id] [--frame WxH] [--count n]');
    const fr = opt('frame', ''), m = /^(\d+)x(\d+)$/.exec(fr);
    if (fr && !m) throw new Error('--frame is WxH, e.g. 32x32');
    const sheet = importSprite(file, { frame: m ? [+m[1], +m[2]] : undefined, count: flag('count') ? +opt('count', '0') : undefined });
    const name = opt('name', basename(file).replace(/\.sprite\.json$|\.[a-z]+$/i, '')), key = `assets/sprites/${name}.spr`;
    vendorAsset(key, encodeSheet(sheet), { license: opt('license', ''), source: opt('source', basename(file)) });
    say(`${key}: ${sheet.frames} frame(s) ${sheet.w}x${sheet.h}, ${sheet.palette.length / 4 - 1} colours${sheet.tags.length ? `, tags ${sheet.tags.map((t) => t.name).join(' ')}` : ''}`);
    return;
  }
  if (cmd === 'sprite' && positional[1] === 'gen') {
    const prompt = positional[2], name = opt('name', '');
    if (!prompt || !name || !/^[a-z0-9-]+$/.test(name)) throw new Error('usage: sprite gen "<prompt>" --name <id> [--size 32] [--frames 4] [--palette <style id | #hex,#hex..>] [--colors 16] [--from-png file --license L]');
    const pal = opt('palette', '');
    const palette = !pal ? undefined : pal.startsWith('#') ? parsePalette(pal.split(/[\s,]+/).filter(Boolean)) : parsePalette(loadStyles().find((s) => s.id === pal)?.palette ?? (() => { throw new Error(`no style ${pal}`); })());
    const fromPng = opt('from-png', '');
    const r = await spriteGen(
      { prompt, frames: +opt('frames', '1'), size: +opt('size', '32'), palette, colors: +opt('colors', '16'), fromPng: fromPng ? readFileSync(fromPng) : undefined },
      { env: process.env, fetch, now: () => new Date() },
    );
    const key = `assets/sprites/${name}.spr`;
    if (r.provider === 'file') vendorAsset(key, encodeSheet(r.sheet), { license: opt('license', ''), source: `sprite gen --from-png ${basename(fromPng)}`, prompt });
    else vendorAsset(key, encodeSheet(r.sheet), { license: 'ai-generated', source: `sprite gen (${r.provider})`, model: r.model, prompt });
    // a look at the result (and the raw image), not vendored
    const dir = previewDir(LAB);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${name}.raw.png`), r.png);
    writeFileSync(join(dir, `${name}.png`), encodePng(sheetStrip(r.sheet)));
    say(`${key}: ${r.sheet.frames} frame(s) ${r.sheet.w}x${r.sheet.h}, ${r.sheet.palette.length / 4 - 1} colours (${r.provider}${r.provider === 'file' ? '' : ` ${r.model}`}); preview in lab/out/sprites/${name}.png`);
    return;
  }
  if (cmd === 'font' && positional[1] === 'bake') {
    const src = positional[2], name = opt('name', '');
    if (!src || !name || !/^[a-z0-9-]+$/.test(name)) throw new Error('usage: font bake <file.ttf|builtin:pixel5x8> --name <id> --license L [--source S] [--size 48] [--range 4] [--license-file OFL.txt]');
    const f = src === 'builtin:pixel5x8' ? bakePixelFont(name) : bakeMsdf(parseTtf(readFileSync(src)), { name, size: +opt('size', '48'), range: +opt('range', '4') });
    const license = opt('license', src.startsWith('builtin:') ? 'own' : ''), source = opt('source', src.startsWith('builtin:') ? `code-drawn (scripts/lab/pixelfont.ts)` : basename(src));
    f.license = license; f.source = source;
    const key = `assets/fonts/${name}.efont`;
    vendorAsset(key, encodeFont(f), { license, source, note: opt('note', '') || undefined });
    const lf = opt('license-file', '');
    if (lf) vendorAsset(`assets/fonts/${name}.LICENSE.txt`, readFileSync(lf), { license, source: `license text for ${key}` });
    say(`${key}: ${f.mode}, ${Object.keys(f.glyphs).length} glyphs, atlas ${f.atlasW}x${f.atlasH}`);
    return;
  }
  if (cmd === 'feedback') {
    const file = resolve(opt('votes', join(LAB, '../data/votes.jsonl')));
    const votes = existsSync(file) ? parseVotes(readFileSync(file, 'utf8')) : [];
    const { reg } = await loadPieces();
    const d = digest(votes, loadScenes(undefined, reg), reg, transitions());
    writeFileSync(join(LAB, 'feedback.json'), JSON.stringify(d, null, 1) + '\n');
    writeFileSync(join(LAB, 'FEEDBACK.md'), feedbackMd(d));
    const dir = join(LAB, 'scenes');
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.json'))) {
      const p = join(dir, f), g = JSON.parse(readFileSync(p, 'utf8'));
      if (d.retired.includes(g.id)) { g.status = 'retired'; writeFileSync(p, JSON.stringify(g, null, 2) + '\n'); }
    }
    say(`${votes.length} vote(s)${existsSync(file) ? '' : ` (no ${file})`} -> lab/feedback.json, lab/FEEDBACK.md${d.retired.length ? `; retired ${d.retired.join(', ')}` : ''}`);
    return;
  }
  if (cmd === 'evolve') {
    const { reg } = await loadPieces(), id = positional[2];
    const raw = loadScenes().find((g) => g.id === id), styled = loadScenes(undefined, reg).find((g) => g.id === id);
    if (!raw || !styled?.evolve) throw new Error(`${id ?? '(none)'}: not an evolving scene (${loadScenes().filter((g) => g.evolve).map((g) => g.id).join(', ')})`);
    const ev = styled.evolved!, idHash = strHash(id);
    if (positional[1] === 'show') {
      for (let k = 0; k < +opt('steps', '12'); k++) {
        const info = stateInfo(ev, stateAt(ev, idHash, k), idHash, reg);
        say(`s${k}  ${info.key}`);
        for (const [n, x] of Object.entries(info.slots)) say(`      ${n}: ${JSON.stringify(x.params)}`);
      }
      say(`pools: ${ev.slots.map((x) => `${x.node} [${x.cands.map((c) => `${c.piece} w${c.weight}`).join(', ')}]`).join('; ')}`);
      return;
    }
    if (positional[1] === 'freeze') {
      const state = positional[3];
      if (!state) throw new Error('usage: evolve freeze <scene> <state key | s<step>>');
      let slots: EvolveInfo['slots'];
      const step = /^s?(\d+)$/.exec(state);
      if (step) slots = stateInfo(ev, stateAt(ev, idHash, +step[1]), idHash, reg).slots;
      else {
        const d = JSON.parse(readFileSync(join(LAB, 'feedback.json'), 'utf8')) as Partial<Digest>, st = d.evolve?.[id]?.states?.[state];
        if (!st) throw new Error(`${id}: no votes on state ${state} in lab/feedback.json (run feedback first, or give a step: s12)`);
        slots = st.slots;
      }
      const child = freezeScene(raw, reg, { slots }, { id: opt('id', `${id}-f${hex8(strHash(JSON.stringify(slots))).slice(0, 5)}`), name: opt('name', '') || undefined, created: new Date().toISOString().slice(0, 10) });
      const errs = validateScene(withEvolve(child, reg), reg);
      if (errs.length) throw new Error(errs.join('\n'));
      const out = join(LAB, 'scenes', `${child.id}.json`);
      if (existsSync(out)) throw new Error(`${out} exists (pick another --id)`);
      writeFileSync(out, JSON.stringify(child, null, 2) + '\n');
      say(`${out}: ${Object.entries(slots).map(([n, x]) => `${n}=${x.piece}`).join(', ')} (parent ${id})`);
      return;
    }
    throw new Error('usage: evolve show|freeze <scene> ...');
  }
  if (cmd === 'import-space-sim') {
    const r = importSpaceSim(opt('src', DEFAULT_SRC));
    say(`copied ${r.files} files (${(r.bytes / 1048576).toFixed(1)} MB) into lab/assets/, provenance in lab/assets/index.json`);
    return;
  }
  if (cmd === 'new' && positional[1] === 'transition') {
    const dir = newTransition(positional[2] ?? '');
    say(`created ${dir}\ncurves: ${curveList()}\nnext: edit it, then \`npm run lab -- render ${positional[2]}\``);
    return;
  }
  if (cmd === 'new') {
    const kind = positional[1] as PieceKind, id = positional[2];
    if (!PIECE_KINDS.includes(kind) || !id || !/^[a-z0-9]+(-[a-z0-9]+)+$/.test(id)) throw new Error(`usage: new <${PIECE_KINDS.join('|')}> <vendor-slug> [--driver]`);
    const dir = join(LAB, 'pieces', kind, id);
    if (existsSync(dir)) throw new Error(`${dir} exists`);
    mkdirSync(dir, { recursive: true });
    const [vendor] = id.split('-'), driver = flag('driver') || kind === 'modulator' || kind === 'color';
    const out = kind === 'modulator' ? { out: { type: 'signal' } } : kind === 'color' ? { palette: { type: 'palette' } } : { out: { type: 'tex' } };
    const ins = kind === 'effect' ? { in: { type: 'tex' } } : kind === 'generator' ? { palette: { type: 'palette', optional: true } } : kind === 'utility' ? { a: { type: 'tex' }, b: { type: 'tex' } } : undefined;
    writeFileSync(join(dir, 'piece.json'), JSON.stringify({
      id, kind, name: id.split('-').slice(1).join(' '), doc: 'TODO: one sentence on what it shows and what drives it.',
      ports: { ...(ins ? { in: ins } : {}), out },
      params: { amount: { type: 'float', default: 0.5, min: 0, max: 1, doc: 'TODO' } },
      ...(driver ? {} : { shader: 'main.wgsl' }), budget: { ms: 1, scales: 'res' }, tags: [],
      author: { vendor, model: 'TODO' },
    }, null, 2) + '\n');
    if (!driver) writeFileSync(join(dir, 'main.wgsl'), kind === 'effect'
      ? 'fn shade(uv: vec2f) -> vec4f {\n  let c = tex_in(uv).rgb;\n  return vec4f(mix(c, 1.0 - c, p_amount() * bass()), 1.0);\n}\n'
      : kind === 'utility'
        ? 'fn shade(uv: vec2f) -> vec4f {\n  return vec4f(mix(tex_a(uv).rgb, tex_b(uv).rgb, p_amount()), 1.0);\n}\n'
        : 'fn shade(uv: vec2f) -> vec4f {\n  let r = length((uv - 0.5) * vec2f(aspect(), 1.0));\n  let ring = exp(-abs(r - 0.2 - bass() * p_amount()) * 60.0);\n  return vec4f(palette(fract(r + time() * 0.1)) * ring, 1.0);\n}\n');
    else writeFileSync(join(dir, 'driver.ts'), kind === 'color'
      ? "import { definePiece, oklch } from '../../../api/index.ts';\n\nexport default definePiece({\n  cpu: ({ params, audio }) => ({\n    palette: { stops: [0, 1, 2, 3, 4].map((i) => oklch(0.4 + i * 0.12, 0.15, (params.amount as number) + i * 0.08 + audio.pal)) },\n  }),\n});\n"
      : kind === 'modulator'
        ? "import { definePiece } from '../../../api/index.ts';\n\nexport default definePiece({\n  // pure function of (tick, audio, params): no state between calls\n  cpu: ({ audio, params }) => ({ out: Math.min(1, audio.rms * 2 * (params.amount as number)) }),\n});\n"
        : "import { definePiece } from '../../../api/index.ts';\n\nexport default definePiece({\n  gpu: ({ device, shader }) => {\n    // build pipelines here (shader('file.wgsl') compiles a file from this folder)\n    return {\n      frame({ enc, out }) {\n        const rp = enc.beginRenderPass({ colorAttachments: [{ view: out.out.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }] });\n        rp.end();\n      },\n    };\n  },\n});\n");
    say(`created ${dir}\nnext: edit it, then \`npm run lab -- render ${id}\``);
    return;
  }
  if (cmd === 'profile') {
    const v = await validate();
    const [w, h] = opt('res', '1920x1080').split('x').map(Number);
    const md = await runProfile(w, h, v.transitions, v.scenes, { cpu: flag('cpu'), quick: flag('quick') });
    for (const l of md) say(l);
    return;
  }
  if (cmd === 'render' || cmd === 'gate') {
    const v = await validate();
    if (v.errors.length) {
      for (const e of v.errors) say(`✗ ${e}`);
      if (cmd === 'gate') { writeJunit([{ name: 'validate', classname: 'lab', failure: v.errors.join('\n') }]); process.exit(1); }
      say('(validation problems: rendering anyway)');
    }
    const gate = cmd === 'gate';
    const [w, h] = (gate ? '1920x1080' : opt('res', flag('cpu') ? '640x360' : '1280x720')).split('x').map(Number);
    let items: Target[];
    if (gate) {
      const ch = flag('all') ? null : changed();
      const pieceIds = new Set<string>(), sceneIds = new Set<string>(), transIds = new Set<string>();
      if (ch) {
        for (const f of ch) {
          const m = f.match(/^lab\/pieces\/[^/]+\/([^/]+)\//), s = f.match(/^lab\/scenes\/([^/]+)\.json$/);
          if (m && v.reg.has(m[1])) pieceIds.add(m[1]);
          if (s && v.scenes.some((x) => x.id === s[1])) sceneIds.add(s[1]);
          // a transition folder; the shared prelude (or its assembly) changes them all
          const tm = f.match(/^lab\/transitions\/([^/]+)\//);
          if (tm && v.transitions.includes(tm[1])) transIds.add(tm[1]);
          if (f.startsWith('lab/pieces/utility/core-transition/') || f === 'src/core/transwgsl.ts') for (const id of v.transitions) transIds.add(id);
          // a style pack changes every scene that uses it; a shared asset every piece that declares it
          const st = f.match(/^lab\/styles\/([^/]+)\.json$/);
          if (st) for (const x of v.scenes) if (x.style === st[1]) sceneIds.add(x.id);
          if (f.startsWith('lab/assets/')) for (const [id, d] of v.reg) if (d.manifest.assets?.some((a) => `lab/${a.path}` === f)) pieceIds.add(id);
        }
        // an edited piece changes every scene that uses it (an evolving scene's candidates too)
        for (const s of v.scenes) if (s.nodes.some((n) => pieceIds.has(n.piece)) || s.evolved?.slots.some((x) => x.cands.some((c) => pieceIds.has(c.piece)))) sceneIds.add(s.id);
      } else { for (const s of v.scenes) sceneIds.add(s.id); for (const id of v.transitions) transIds.add(id); }
      items = [...[...pieceIds].filter((p) => typeof harness(p, v.reg) !== 'string'), ...sceneIds, ...transIds].map((n) => target(n, v.reg, v.scenes, v.transitions));
      say(`gate: ${items.length ? items.map((i) => i.id).join(', ') : 'nothing changed under lab/'}${ch ? '' : ' (all scenes and transitions)'}`);
    } else {
      if (!positional[1]) throw new Error('usage: render <scene|piece|transition> [--fixture f|all] [--seconds n] [--res WxH] [--cpu] [--no-video]');
      items = [target(positional[1], v.reg, v.scenes, v.transitions)];
    }
    // the switch profile goes into every gate on a GPU (numbers only, never a failure)
    const profile = async (cpu: boolean): Promise<{ name: string; classname: string; out?: string; failure?: string }[]> => {
      if (!gate || cpu || flag('no-profile')) return [];
      try {
        const md = await runProfile(w, h, v.transitions, v.scenes, { cpu: false, quick: false, gpuOnly: true });
        for (const l of md) say(l);
        return [{ name: 'switch profile', classname: 'lab.profile', out: md.join('\n')}];
      } catch (e) { say(`profile failed: ${(e as Error).message}`); return [{ name: 'switch profile', classname: 'lab.profile', out: `failed: ${(e as Error).message}` }]; }
    };
    if (!items.length) {
      const pr = gate && !flag('cpu') ? await profile(false) : [];
      writeJunit([{ name: 'nothing to gate', classname: 'lab' }, ...pr]);
      return;
    }
    const lab = await openLab({ width: w, height: h, cpu: flag('cpu'), log: say });
    say(`WebGPU: ${lab.adapter}${lab.cpu ? ' (CPU)' : ''}  ·  ${w}x${h}`);
    const fx = opt('fixture', gate ? 'all' : 'techno');
    const fixtures = fx === 'all' ? [...FIXTURES] : fx.split(',');
    const results: ItemResult[] = [];
    try {
      for (const it of items) {
        const r = await check(lab, it, fixtures, gate ? 8 : +opt('seconds', '4'), { video: !flag('no-video'), budget: gate && !lab.cpu, media: opt('media', 'test') as RunOpts['media'], sections: gate ? 'all' : opt('sections', 'all') });
        report(r); results.push(r);
      }
    } finally { await lab.close(); }
    if (gate) {
      if (lab.cpu) say('note: no GPU here, so the ms/frame budget was not enforced');
      const pr = await profile(lab.cpu);
      writeJunit([...results.map((r) => ({ name: r.id, classname: 'lab.gate', failure: r.failures.length ? r.failures.join('\n') : undefined, time: r.ms / 1000 })), ...pr, ...DBG]);
      const md = ['# Lab gate', '', `WebGPU: ${lab.adapter}, ${w}x${h}, fixtures ${fixtures.join(', ')}`, '',
        ...results.flatMap((r) => [`## ${r.failures.length ? '✗' : '✓'} ${r.id}`, '', ...r.notes.map((n) => `- ${n}`), ...r.failures.map((f) => `- **${f}**`), '']),
        ...(pr[0]?.out ? [pr[0].out] : [])].join('\n');
      mkdirSync(OUT, { recursive: true });
      writeFileSync(join(OUT, 'gate.md'), md);
      process.exit(results.some((r) => r.failures.length) ? 1 : 0);
    }
    return;
  }
  say(`usage: npm run lab -- validate | render <scene|piece|transition> | gate [--all] | new <kind|transition> <vendor-slug> | fixtures | feedback | import-space-sim   (see scripts/lab/cli.ts)`);
  process.exit(cmd ? 1 : 0);
}

/** A sheet's frames side by side, 4x scaled, for looking at. */
function sheetStrip(s: Sheet, k = 4): { w: number; h: number; data: Uint8Array } {
  const w = s.w * s.frames * k, h = s.h * k, data = new Uint8Array(w * h * 4);
  for (let f = 0; f < s.frames; f++) {
    const px = sheetRgba(s, f);
    for (let y = 0; y < h; y++) for (let x = 0; x < s.w * k; x++) data.set(px.subarray(((Math.floor(y / k) * s.w) + Math.floor(x / k)) * 4, ((Math.floor(y / k) * s.w) + Math.floor(x / k)) * 4 + 4), (y * w + f * s.w * k + x) * 4);
  }
  return { w, h, data };
}

function writeJunit(cases: Parameters<typeof junit>[1]): void {
  const p = opt('junit', '');
  if (p) writeFileSync(p, junit('einklang-lab', cases));
}

main().catch((e: Error) => { say(`error: ${e.message}`); process.exit(2); });
