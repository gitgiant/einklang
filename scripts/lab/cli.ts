// einklang-lab: the agents' sandbox. Run as `npm run lab -- <command>`.
//
//   validate                       manifests, scenes, port types, imports, folder sizes (no browser)
//   render <scene|piece> [opts]    render a scene (or a piece in its harness) against a fixture:
//                                  contact sheet, webm and stats in lab/out/<id>/<fixture>/, plus the checks
//     --fixture quiet|techno|dense|silence|<lab/fixtures/x.feat>|all   (default techno)
//     --seconds 4  --res 640x360  --cpu (force SwiftShader)  --no-video
//   gate [--all] [--junit file]    the merge gate: validate, then render every changed scene/piece
//                                  (or all with --all) 8 s per fixture at 1080p on the GPU and check:
//                                  errors, NaN, black, blown out, frozen, no audio reaction, ms/frame
//   new <kind> <vendor-slug> [--driver]   scaffold a piece (auto-shader unless --driver)
//   fixtures                       list fixtures
// Spec: docs/prd-lab.md.
import { mkdirSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { loadPieces, loadScenes, LAB } from './load.ts';
import { lintPieces } from './lint.ts';
import { openLab, type Lab } from './browser.ts';
import { judgeCost, judgeReactive, judgeRun, junit, reactivity, LIMITS } from './checks.ts';
import { validateScene } from '../../src/core/graph/validate.ts';
import { harness } from '../../src/core/graph/harness.ts';
import { FIXTURES } from '../../src/core/fixtures.ts';
import type { Registry, SceneGraph } from '../../src/core/graph/types.ts';
import type { RunOpts, RunResult } from '../../src/web/lab.ts';
import { PIECE_KINDS, type PieceKind } from '../../lab/api/index.ts';

const OUT = resolve(LAB, 'out');
const argv = process.argv.slice(2);
const flag = (n: string) => argv.includes(`--${n}`);
const opt = (n: string, d: string) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const positional = argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && argv[i - 1].startsWith('--') && !['--cpu', '--all', '--driver', '--no-video'].includes(argv[i - 1])));
const say = (s: string) => process.stdout.write(s + '\n');
/** Ticks start here so modulators have history to look back at. */
const START = 600;

async function validate(): Promise<{ reg: Registry; scenes: SceneGraph[]; errors: string[] }> {
  const { reg, errors } = await loadPieces();
  const scenes = loadScenes();
  const ids = new Set<string>();
  for (const s of scenes) {
    errors.push(...validateScene(s, reg));
    if (ids.has(s.id)) errors.push(`${s.id}: duplicate scene id`);
    ids.add(s.id);
  }
  errors.push(...lintPieces());
  return { reg, scenes, errors };
}

/** A scene id, a piece id (rendered in its harness), or a path to a scene file. */
function target(name: string, reg: Registry, scenes: SceneGraph[]): { id: string; scene: SceneGraph; base?: SceneGraph; piece: boolean } {
  const s = scenes.find((x) => x.id === name);
  if (s) return { id: s.id, scene: s, piece: false };
  if (reg.has(name)) {
    const h = harness(name, reg), b = harness(name, reg, true);
    if (typeof h === 'string') throw new Error(h);
    return { id: name, scene: h, base: typeof b === 'string' ? undefined : b, piece: true };
  }
  throw new Error(`no scene or piece named ${name}`);
}

const save = (dir: string, r: RunResult, video: boolean) => {
  mkdirSync(dir, { recursive: true });
  if (r.sheet) writeFileSync(join(dir, 'sheet.png'), Buffer.from(r.sheet, 'base64'));
  if (video && r.video) writeFileSync(join(dir, 'video.webm'), Buffer.from(r.video, 'base64'));
  writeFileSync(join(dir, 'stats.json'), JSON.stringify({ ok: r.ok, error: r.error, errors: r.errors, adapter: r.adapter, msPerFrame: r.msPerFrame, frames: r.stats.map(({ thumb: _t, ...s }) => s) }, null, 1));
};

interface ItemResult { id: string; failures: string[]; notes: string[]; ms: number; dir: string }

/** Render one scene/piece over fixtures with the checks; artifacts go to lab/out/<id>/. */
async function check(lab: Lab, t: ReturnType<typeof target>, fixtures: string[], seconds: number, opts: { video: boolean; budget: boolean }): Promise<ItemResult> {
  const ticks = Math.round(seconds * 60), dir = join(OUT, t.id), perf = lab.cpu ? 30 : 120;
  // SwiftShader is ~50x slower: fewer video frames there
  const base: Omit<RunOpts, 'scene' | 'fixture'> = { start: START, ticks, every: 10, sheet: 12, fps: opts.video ? (lab.cpu ? 15 : 30) : 0, videoWidth: 640, perfFrames: 0 };
  const failures: string[] = [], notes: string[] = [], react: { fixture: string; reactivity: number }[] = [];
  let ms = 0;
  for (const [i, fx] of fixtures.entries()) {
    const r = await lab.run({ ...base, scene: t.scene, fixture: fx, perfFrames: i === 0 ? perf : 0 });
    save(join(dir, fx), r, opts.video);
    const c = judgeRun(fx, r);
    failures.push(...c.failures.map((f) => `[${fx}] ${f}`)); notes.push(`[${fx}] ${c.notes.join(', ')}`);
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
  return { id: t.id, failures, notes, ms, dir };
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
    const { reg, scenes, errors } = await validate();
    for (const e of errors) say(`✗ ${e}`);
    say(errors.length ? `${errors.length} problem(s)` : `ok: ${reg.size} pieces, ${scenes.length} scenes`);
    process.exit(errors.length ? 1 : 0);
  }
  if (cmd === 'fixtures') {
    say(`built in: ${[...FIXTURES, 'silence'].join(', ')}`);
    const dir = join(LAB, 'fixtures');
    if (existsSync(dir)) say(`files: ${readdirSync(dir).filter((f) => f.endsWith('.feat')).join(', ') || '-'}`);
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
  if (cmd === 'render' || cmd === 'gate') {
    const v = await validate();
    if (v.errors.length) {
      for (const e of v.errors) say(`✗ ${e}`);
      if (cmd === 'gate') { writeJunit([{ name: 'validate', classname: 'lab', failure: v.errors.join('\n') }]); process.exit(1); }
      say('(validation problems: rendering anyway)');
    }
    const gate = cmd === 'gate';
    const [w, h] = (gate ? '1920x1080' : opt('res', flag('cpu') ? '640x360' : '1280x720')).split('x').map(Number);
    let items: ReturnType<typeof target>[];
    if (gate) {
      const ch = flag('all') ? null : changed();
      const pieceIds = new Set<string>(), sceneIds = new Set<string>();
      if (ch) {
        for (const f of ch) {
          const m = f.match(/^lab\/pieces\/[^/]+\/([^/]+)\//), s = f.match(/^lab\/scenes\/([^/]+)\.json$/);
          if (m && v.reg.has(m[1])) pieceIds.add(m[1]);
          if (s && v.scenes.some((x) => x.id === s[1])) sceneIds.add(s[1]);
        }
        // an edited piece changes every scene that uses it
        for (const s of v.scenes) if (s.nodes.some((n) => pieceIds.has(n.piece))) sceneIds.add(s.id);
      } else for (const s of v.scenes) sceneIds.add(s.id);
      items = [...[...pieceIds].filter((p) => typeof harness(p, v.reg) !== 'string'), ...sceneIds].map((n) => target(n, v.reg, v.scenes));
      say(`gate: ${items.length ? items.map((i) => i.id).join(', ') : 'nothing changed under lab/'}${ch ? '' : ' (all scenes)'}`);
    } else {
      if (!positional[1]) throw new Error('usage: render <scene|piece> [--fixture f|all] [--seconds n] [--res WxH] [--cpu] [--no-video]');
      items = [target(positional[1], v.reg, v.scenes)];
    }
    if (!items.length) { writeJunit([{ name: 'nothing to gate', classname: 'lab' }]); return; }
    const lab = await openLab({ width: w, height: h, cpu: flag('cpu'), log: say });
    say(`WebGPU: ${lab.adapter}${lab.cpu ? ' (CPU)' : ''}  ·  ${w}x${h}`);
    const fx = opt('fixture', gate ? 'all' : 'techno');
    const fixtures = fx === 'all' ? [...FIXTURES] : fx.split(',');
    const results: ItemResult[] = [];
    try {
      for (const it of items) {
        const r = await check(lab, it, fixtures, gate ? 8 : +opt('seconds', '4'), { video: !flag('no-video'), budget: gate && !lab.cpu });
        report(r); results.push(r);
      }
    } finally { await lab.close(); }
    if (gate) {
      if (lab.cpu) say('note: no GPU here, so the ms/frame budget was not enforced');
      writeJunit(results.map((r) => ({ name: r.id, classname: 'lab.gate', failure: r.failures.length ? r.failures.join('\n') : undefined, time: r.ms / 1000 })));
      const md = ['# Lab gate', '', `WebGPU: ${lab.adapter}, ${w}x${h}, fixtures ${fixtures.join(', ')}`, '',
        ...results.flatMap((r) => [`## ${r.failures.length ? '✗' : '✓'} ${r.id}`, '', ...r.notes.map((n) => `- ${n}`), ...r.failures.map((f) => `- **${f}**`), ''])].join('\n');
      mkdirSync(OUT, { recursive: true });
      writeFileSync(join(OUT, 'gate.md'), md);
      process.exit(results.some((r) => r.failures.length) ? 1 : 0);
    }
    return;
  }
  say(`usage: npm run lab -- validate | render <scene|piece> | gate [--all] | new <kind> <vendor-slug> | fixtures   (see scripts/lab/cli.ts)`);
  process.exit(cmd ? 1 : 0);
}

function writeJunit(cases: Parameters<typeof junit>[1]): void {
  const p = opt('junit', '');
  if (p) writeFileSync(p, junit('einklang-lab', cases));
}

main().catch((e: Error) => { say(`error: ${e.message}`); process.exit(2); });
