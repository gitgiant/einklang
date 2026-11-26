// End-to-end sync check with real WebGPU: one server, two browser hosts. Verifies token auth,
// a bar-quantized scene switch landing on both, per-host views, and equal scene-state hashes
// at equal ticks (including after a manual hit event). Usage: npm run build && npm run e2e
import puppeteer, { type Page } from 'puppeteer-core';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { startServer } from '../src/server/main.ts';

const chrome = process.env.CHROME ?? ['C:/Program Files/Google/Chrome/Application/chrome.exe', '/usr/bin/google-chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find(existsSync);
if (!chrome) throw new Error('Chrome not found; set CHROME=');
const TOKEN = 'e2e';
const srv = await startServer({ port: 0, pub: resolve(import.meta.dirname, '../dist'), token: TOKEN, hosts: ['127.0.0.1'] });
const port = (srv.servers[0].address() as { port: number }).port;
// one browser per host: background tabs don't get animation frames
const launch = () => puppeteer.launch({ executablePath: chrome, headless: true, args: ['--enable-unsafe-webgpu'] });
const browsers = await Promise.all([launch(), launch()]);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let failed = false;
const check = (ok: boolean, what: string) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failed = true; };

type Dbg = { hashes: [number, string][]; scene: string; view: number; events: number };
const dbg = (p: Page) => p.evaluate(() => { const d = window.__ek!; return { hashes: [...d.hashes], scene: d.scene, view: d.view, events: d.events }; }) as Promise<Dbg>;
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
    await p.goto(`http://127.0.0.1:${port}/?t=${TOKEN}&${q}`);
    await p.waitForFunction(() => window.__ek && window.__ek.hashes.size > 30, { timeout: 20000 });
    return p;
  };
  const noTok = await browsers[0].newPage();
  check((await noTok.goto(`http://127.0.0.1:${port}/`))!.status() === 401, 'page without token is refused');

  const a = await open('name=left', 0), b = await open('name=right&view=1', 1);
  await noTok.close();
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

  // controller overrides B's view from A's host list
  await a.click('#hostsBtn');
  const sel = await a.$$('#hosts select');
  await sel[1].select('5');
  await sleep(400);
  check((await dbg(b)).view === 5, 'view override from another host applied');

  // flow sim: switch, let it fast-forward, compare
  await a.select('#quant', 'now');
  await a.select('#scene', 'flow');
  await sleep(2500);
  da = await dbg(a); db = await dbg(b);
  c = compare(da, db);
  check(da.scene === 'flow' && c.diff === 0 && c.shared > 20, `flow: ${c.shared} shared ticks, ${c.diff} mismatches`);
  const hud = await b.$eval('#hud', (e) => e.textContent ?? '');
  check(/gpu≡cpu ✓/.test(hud), `flow gpu≡cpu on host B (${/gpu≡cpu \S+/.exec(hud)?.[0]})`);

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
  await a.keyboard.press('d');
  await sleep(600);
  const dtext = await a.$eval('#debug pre', (e) => e.textContent ?? '');
  check(/room clock master: midi-box/.test(dtext) && /fps \d/.test(dtext), 'debug panel shows frames, network and clock master');
  if (process.env.SHOT) await a.screenshot({ path: process.env.SHOT });
  m.close();
} catch (e) {
  console.log('FAIL', e); failed = true;
} finally {
  await Promise.all(browsers.map((b) => b.close()));
  await srv.close();
}
process.exit(failed ? 1 : 0);
