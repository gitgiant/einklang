// End-to-end sync check with real WebGPU: one server, two browser hosts. Verifies token auth,
// a bar-quantized scene switch landing on both, per-host views, and equal scene-state hashes
// at equal ticks (including after a manual hit event). Usage: npm run build && npm run e2e
import puppeteer, { type Page } from 'puppeteer-core';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { startServer } from '../src/server/main.ts';
import { RESEED_TICKS } from '../src/core/constants.ts';

const chrome = process.env.CHROME ?? ['C:/Program Files/Google/Chrome/Application/chrome.exe', '/usr/bin/google-chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find(existsSync);
if (!chrome) throw new Error('Chrome not found; set CHROME=');
const TOKEN = 'e2e';
const srv = await startServer({ port: 0, pub: resolve(import.meta.dirname, '../dist'), token: TOKEN, hosts: ['127.0.0.1'] });
const port = (srv.servers[0].address() as { port: number }).port;
// one browser per host: background tabs don't get animation frames
const launch = () => puppeteer.launch({ executablePath: chrome, headless: true, args: ['--enable-unsafe-webgpu', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
const browsers = await Promise.all([launch(), launch()]);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let failed = false;
const check = (ok: boolean, what: string) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failed = true; };

type Dbg = { hashes: [number, string][]; scene: string; view: number; events: number; transSeen: string[] };
const dbg = (p: Page) => p.evaluate(() => { const d = window.__ek!; return { hashes: [...d.hashes], scene: d.scene, view: d.view, events: d.events, transSeen: [...d.transSeen] }; }) as Promise<Dbg>;
function compare(a: Dbg, b: Dbg): { shared: number; diff: number } {
  const hb = new Map(b.hashes);
  let shared = 0, diff = 0;
  for (const [t, h] of a.hashes) if (hb.has(t)) { shared++; if (hb.get(t) !== h) diff++; }
  return { shared, diff };
}

try {
  const open = async (q: string, i: number) => {
    const p = await browsers[i].newPage();
    await p.setViewport({ width: 640, height: 360 });
    p.on('pageerror', (e) => { console.log('pageerror', e); failed = true; });
    await p.goto(`http://127.0.0.1:${port}/?t=${TOKEN}&debug=1&${q}`);
    await p.waitForFunction(() => window.__ek && window.__ek.hashes.size > 30, { timeout: 20000 });
    return p;
  };
  const noTok = await browsers[0].newPage();
  check((await noTok.goto(`http://127.0.0.1:${port}/`))!.status() === 401, 'page without token is refused');

  const a = await open('name=left', 0), b = await open('name=right&view=1', 1);
  await noTok.close();
  const picked = await a.$$eval('#trans, #auto', (es) => es.map((e) => (e as HTMLSelectElement).value).join(' '));
  check(picked === 'random 8', `defaults: random transitions, auto-rotation every 8 bars ("${picked}")`);
  await a.select('#auto', '0'); // the checks below switch scenes themselves
  let da = await dbg(a), db = await dbg(b);
  check(da.view === 0 && db.view === 1, `per-host default views (left ${da.view}, right ${db.view})`);
  let c = compare(da, db);
  check(c.shared > 20 && c.diff === 0, `idle: ${c.shared} shared ticks, ${c.diff} hash mismatches`);

  // switch scene from host A, quantized to the bar; both must land on it
  await a.select('#quant', 'bar');
  await a.select('#scene', 'tunnel');
  await sleep(2200); // a bar is 112 ticks = 1.87 s
  da = await dbg(a); db = await dbg(b);
  check(da.scene === 'tunnel' && db.scene === 'tunnel', `scene switch landed on both (${da.scene}, ${db.scene})`);

  // manual hit from B; tunnel state depends on onsets, so hashes must still agree afterwards
  await b.keyboard.press(' ');
  await sleep(1200);
  da = await dbg(a); db = await dbg(b);
  check(da.events === 1 && db.events === 1, `hit event reached both hosts (${da.events}, ${db.events})`);
  c = compare(da, db);
  check(c.shared > 20 && c.diff === 0, `after hit: ${c.shared} shared ticks, ${c.diff} hash mismatches`);

  // owner votes: `-` on B toasts on both hosts and skips tunnel at the next bar; `+` on A just toasts
  await b.keyboard.press('-');
  const toast = (p: Page) => p.$eval('#toast', (e) => (e.classList.contains('on') ? e.textContent ?? '' : ''));
  await sleep(300);
  const [ta, tb] = [await toast(a), await toast(b)];
  check(ta.includes('👎') && ta.includes('-1') && tb === ta, `vote toast on both hosts ("${ta}")`);
  await sleep(2200);
  da = await dbg(a); db = await dbg(b);
  check(da.scene !== 'tunnel' && da.scene === db.scene, `👎 skipped tunnel on both (${da.scene}, ${db.scene})`);
  await a.keyboard.press('+');
  await sleep(300);
  check((await toast(b)).includes('👍'), `👍 toast reached the other host ("${await toast(b)}")`);
  c = compare(da, db);
  check(c.shared > 20 && c.diff === 0, `after votes: ${c.shared} shared ticks, ${c.diff} hash mismatches`);
  // gallery: 👍 posts to /vote; the live hosts toast it
  const gal = await browsers[0].newPage();
  await gal.goto(`http://127.0.0.1:${port}/gallery.html?scene=radial&trans=off&t=${TOKEN}`);
  await gal.waitForSelector('#vote .srow .up:not([disabled])', { timeout: 20000 });
  await gal.$eval('#vote .srow .up', (e) => (e as HTMLButtonElement).click());
  await gal.waitForFunction(() => document.querySelector('#vote .note')?.textContent?.includes('saved'), { timeout: 5000 }).catch(() => {});
  const note = await gal.$eval('#vote .note', (e) => e.textContent ?? '');
  await sleep(200);
  check(note.includes('saved') && (await toast(a)).includes('gallery'), `gallery vote saved ("${note}") and toasted live ("${await toast(a)}")`);
  await gal.close();

  // controller overrides B's view from A's host list
  await a.click('#hostsBtn');
  const sel = await a.$$('#hosts select');
  await sel[1].select('5');
  await sleep(400);
  check((await dbg(b)).view === 5, 'view override from another host applied');

  // transitions: one of each effect, 1 beat long on the beat, stepped from A; equal hashes throughout
  await a.click('#hostsBtn'); // close the host list again (it covers the panel's second row)
  const next = () => a.$eval('#next', (e) => (e as HTMLButtonElement).click());
  await a.select('#quant', 'beat');
  await a.select('#tlen', '1');
  const effects = (await a.$$eval('#trans option', (os) => os.map((o) => (o as HTMLOptionElement).value))).filter((v) => v !== 'random' && v !== 'core-cut');
  let tShared = 0, tDiff = 0;
  for (const eff of effects) {
    await a.select('#trans', eff);
    await next();
    await sleep(1150); // up to a beat to the boundary, a beat of transition (28 ticks), slack
    c = compare(await dbg(a), await dbg(b));
    tShared += c.shared; tDiff += c.diff;
    if (c.diff) console.log(`     ${eff}: ${c.diff} mismatches`);
  }
  da = await dbg(a); db = await dbg(b);
  const missed = effects.filter((e) => !da.transSeen.includes(e) || !db.transSeen.includes(e));
  check(tDiff === 0 && missed.length === 0, `transitions: ${effects.length} effects drawn on both (missed: ${missed.join(' ') || 'none'}), ${tShared} shared ticks, ${tDiff} mismatches`);
  // transition vote: `.` on A votes the last effect that ran, toasted on both
  await a.keyboard.press('.');
  await sleep(300);
  const tv = await toast(b);
  check(tv.includes('👍 transition ') && (await a.$eval('#tvote .trow', (e) => e.textContent ?? '')).includes('saved'), `transition vote toast on the other host ("${tv}")`);
  if (process.env.SHOT5) {
    await a.select('#trans', 'core-iris'); await a.select('#tlen', '4'); await next();
    await a.waitForFunction(() => window.__ek!.trans === 'core-iris', { timeout: 5000 });
    await sleep(900);
    await a.screenshot({ path: process.env.SHOT5 });
    await sleep(1500);
  }
  await a.select('#trans', 'core-cut');

  // flow sim: switch, let it fast-forward, compare
  await a.select('#quant', 'now');
  await a.select('#scene', 'flow');
  await sleep(2500);
  da = await dbg(a); db = await dbg(b);
  c = compare(da, db);
  check(da.scene === 'flow' && c.diff === 0 && c.shared > 20, `flow: ${c.shared} shared ticks, ${c.diff} mismatches`);
  const hud = await b.$eval('#hud', (e) => e.textContent ?? '');
  check(/gpu≡cpu ✓/.test(hud), `flow gpu≡cpu on host B (${/gpu≡cpu \S+/.exec(hud)?.[0]})`);

  // particle budget: both hosts benchmarked and run the same N; a weak host joining schedules a
  // drop to its capability at the next reseed, on both
  const flowLine = (p: Page) => p.$eval('#debug pre', (e) => /flow N .*/.exec(e.textContent ?? '')?.[0] ?? '');
  const caps = /hosts: (.*)/.exec(await a.$eval('#debug pre', (e) => e.textContent ?? ''))?.[1] ?? '';
  const [fa, fb] = [await flowLine(a), await flowLine(b)];
  const nA = /flow N (\d+)/.exec(fa)?.[1], nB = /flow N (\d+)/.exec(fb)?.[1];
  check(!!nA && nA === nB && /cap \d+.*cap \d+/.test(caps), `flow budget: N ${nA} on both (${caps}); B: ${/N \S+( \+ dust \d+)?/.exec(hud)?.[0]}`);
  // join early in a reseed period: the next boundary is then further off than the wait below, so
  // the drop must still read as scheduled (a join just before a boundary would already be applied)
  await a.waitForFunction((period) => {
    const t = / tick (\d+) /.exec(document.querySelector('#debug pre')?.textContent ?? '')?.[1];
    return t !== undefined && Number(t) % period < period - 180;
  }, { timeout: 10000 }, RESEED_TICKS);
  const before = await flowLine(a);
  const weak = new WebSocket(`ws://127.0.0.1:${port}/ws?t=${TOKEN}`);
  await new Promise((r) => (weak.onopen = r));
  weak.send(JSON.stringify({ t: 'hello', name: 'weak' })); weak.send(JSON.stringify({ t: 'bench', n: 4096 }));
  await sleep(600);
  const [wa, wb] = [await flowLine(a), await flowLine(b)];
  const nBefore = Number(/flow N (\d+)/.exec(before)?.[1]), at = Number(/→ 4096 at reseed (\d+)/.exec(wa)?.[1]);
  check(nBefore > 4096 && at % RESEED_TICKS === 0 && wa.split('this host')[0] === wb.split('this host')[0],
    `weak host: ${wa.split('(weakest')[0].trim()}${at ? '' : ` (before the join: N ${nBefore})`}`);
  weak.close();

  // MIDI: a third (headless) host plays clock, notes and a CC; the server runs in this process,
  // so performance.now() is server time. Both hosts must show the clock and still agree.
  await a.select('#scene', 'radial');
  const m = new WebSocket(`ws://127.0.0.1:${port}/ws?t=${TOKEN}`);
  await new Promise((r) => (m.onopen = r));
  const msend = (x: unknown) => m.send(JSON.stringify(x));
  msend({ t: 'hello', name: 'midi-box' });
  msend({ t: 'ev', type: 'cc', payload: { c: 1, v: 90 } });
  for (let n = 0; n < 6; n++) {
    msend({ t: 'clock', at: performance.now(), bpm: 120, n });
    msend({ t: 'ev', type: 'note', payload: { n: 60 + n * 3, v: 100 } });
    await sleep(500);
  }
  da = await dbg(a); db = await dbg(b);
  c = compare(da, db);
  check(c.shared > 20 && c.diff === 0, `midi: ${c.shared} shared ticks, ${c.diff} mismatches`);
  const hudA = await a.$eval('#hud', (e) => e.textContent ?? '');
  check(/midi 120 bpm/.test(hudA) && /cc 1:90/.test(hudA), `midi clock + cc shown in HUD (${/midi .*/.exec(hudA)?.[0]})`);
  await sleep(600);
  const dtext = await a.$eval('#debug pre', (e) => e.textContent ?? '');
  check(/room clock master: midi-box/.test(dtext) && /fps \d/.test(dtext), 'debug panel shows frames, network and clock master');
  if (process.env.SHOT) await a.screenshot({ path: process.env.SHOT });
  // pads: the same socket plays a gamepad (shockwave + kaleido held, sticks and triggers in),
  // then freezes; hosts must agree on the scene hash throughout
  await a.select('#scene', 'tunnel');
  for (let i = 0; i < 20; i++) {
    msend({ t: 'ev', type: 'pad', payload: { l: 0, b: 0b1001, a: [Math.round(60 * Math.sin(i / 3)), -40, 30, 0], t: [70, 50] } });
    await sleep(80);
  }
  if (process.env.SHOT3) {
    await a.evaluate(() => { for (const id of ['debug', 'panel', 'bar']) document.getElementById(id)!.classList.add('hide'); });
    await a.screenshot({ path: process.env.SHOT3 });
    await a.evaluate(() => { for (const id of ['debug', 'panel', 'bar']) document.getElementById(id)!.classList.remove('hide'); });
  }
  msend({ t: 'ev', type: 'pad', payload: { l: 1, b: 0b10, a: [-80, 60, 0, 0], t: [0, 0] } }); // second pad strobes
  await sleep(300);
  msend({ t: 'ev', type: 'freeze' });
  await sleep(1200);
  da = await dbg(a); db = await dbg(b);
  c = compare(da, db);
  const frozen = new Set(da.hashes.slice(-30).map(([, h]) => h)).size === 1;
  check(c.shared > 20 && c.diff === 0 && frozen, `pads + freeze: ${c.shared} shared ticks, ${c.diff} mismatches, frozen ${frozen}`);
  const ptext = await a.$eval('#debug pre', (e) => e.textContent ?? '');
  check(/slot 0 .*held 1001/.test(ptext) && /slot 1 /.test(ptext), 'debug panel lists both pad slots');
  msend({ t: 'ev', type: 'freeze' });
  msend({ t: 'ev', type: 'pad', payload: { l: 0, b: 0, a: [0, 0, 0, 0], t: [0, 0] } });
  msend({ t: 'ev', type: 'pad', payload: { l: 1, b: 0, a: [0, 0, 0, 0], t: [0, 0] } });
  m.close();

  // playlist: two tracks loaded on A (generated WAVs, or TRACKS=a.mp3,b.flac for real files),
  // paused / sought / resumed from B, then A auto-advances to the second track
  const tracks = process.env.TRACKS?.split(',') ?? [1, 2].map((k) => {
    const sr = 22050, n = sr * 4, buf = Buffer.alloc(44 + n * 2);
    buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVEfmt ', 8); buf.writeUInt32LE(16, 16);
    buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22); buf.writeUInt32LE(sr, 24); buf.writeUInt32LE(sr * 2, 28);
    buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
    for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(Math.sin((i * 2 * Math.PI * 110 * k) / sr) * ((i % (sr / 2)) < 2000 ? 20000 : 3000)), 44 + i * 2);
    const p = join(mkdtempSync(join(tmpdir(), 'ek-')), `${k}-tone.wav`); writeFileSync(p, buf); return p;
  });
  const input = (await a.$('#file'))!;
  await (input as unknown as { uploadFile(...p: string[]): Promise<void> }).uploadFile(...tracks);
  const name0 = basename(tracks[0]).replace(/\.[^.]+$/, '');
  await b.waitForFunction((n) => document.getElementById('tName')!.textContent!.startsWith(n), { timeout: 60000 }, name0);
  check(true, `track 1 "${name0}" playing on B`);
  await b.waitForFunction(() => !/starts in/.test(document.getElementById('tTime')!.textContent!), { timeout: 10000 });
  // the scope draws the track's real waveform (shipped with the features), same on both hosts
  await a.select('#scene', 'scope');
  await sleep(1500);
  da = await dbg(a); db = await dbg(b);
  c = compare(da, db);
  const hasWave = await a.evaluate(() => (window.__ek as unknown as { wave?: boolean }).wave);
  check(c.diff === 0 && c.shared > 20 && hasWave === true, `scope on the track waveform: ${c.shared} shared ticks, ${c.diff} mismatches, wave ${hasWave}`);
  if (process.env.SHOT4) {
    await a.evaluate(() => { for (const id of ['debug', 'panel', 'bar', 'hosts']) document.getElementById(id)!.classList.add('hide'); });
    await a.screenshot({ path: process.env.SHOT4 });
    await a.evaluate(() => { for (const id of ['debug', 'panel', 'bar']) document.getElementById(id)!.classList.remove('hide'); });
  }
  await b.click('#tPlay'); // pause from the other host
  await sleep(400);
  const tA = await a.$eval('#tTime', (e) => e.textContent), tB = await b.$eval('#tTime', (e) => e.textContent);
  check(tA === tB && (await a.$eval('#tPlay', (e) => e.textContent)) === '▶', `paused on both at ${tA} / ${tB}`);
  await b.keyboard.press('ArrowRight'); // seek while paused (clamped to the end on short tracks)
  await sleep(300);
  da = await dbg(a); db = await dbg(b);
  c = compare(da, db);
  check(c.diff === 0, `paused + seek: ${c.diff} mismatches`);
  if (!process.env.TRACKS) {
    await a.click('#tPrev'); // restart track 1
    await sleep(300);
    await b.click('#tPlay');
    const name1 = basename(tracks[1]).replace(/\.[^.]+$/, '');
    await b.waitForFunction((n) => document.getElementById('tName')!.textContent!.startsWith(n), { timeout: 20000 }, name1);
    check(true, `auto-advanced to "${name1}"`);
  }
  if (process.env.SHOT2) await b.screenshot({ path: process.env.SHOT2 });

  // instrument mode: A takes Chrome's fake mic as line-in; every host (A too) renders 2 ticks behind
  await a.$eval('#live', (e) => (e as HTMLButtonElement).click());
  await b.waitForFunction(() => /live features: delay 2t/.test(document.querySelector('#debug pre')?.textContent ?? ''), { timeout: 10000 });
  await sleep(3000);
  da = await dbg(a); db = await dbg(b);
  c = compare(da, db);
  const liveB = /live features: .*/.exec(await b.$eval('#debug pre', (e) => e.textContent ?? ''))?.[0] ?? '';
  check(c.shared > 20 && c.diff === 0, `instrument mode (2-tick delay): ${c.shared} shared ticks, ${c.diff} mismatches; B ${liveB}`);
  await a.$eval('#stop', (e) => (e as HTMLButtonElement).click());
} catch (e) {
  console.log('FAIL', e); failed = true;
} finally {
  await Promise.all(browsers.map((b) => b.close()));
  await srv.close();
}
process.exit(failed ? 1 : 0);
