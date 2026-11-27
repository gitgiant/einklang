// Room-stream probe: one server, a leader and RECV headless receivers (default 1). The leader leads
// live with a fake tab share (a 1920x1080 30 fps canvas + a tone); the others get its video over
// WebRTC. Prints the debug lines every second, then a summary (latency, hold, encode / decode ms).
// The stream runs before WebGPU, so NO_GPU=1 (no SwiftShader rendering eating the CPU) measures
// the stream alone. NO_SANDBOX=1 for containers. --use-fake-ui-for-media-stream lets headless Chrome
// list its real addresses (without it, and with no media permission, host candidates are mDNS names).
// QUIET=1 prints the summary only.
// Usage: npm run build && node --experimental-strip-types scripts/rtc-probe.ts [seconds] [720p30|1080p30]
import puppeteer, { type Page } from 'puppeteer-core';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { startServer } from '../src/server/main.ts';

const secs = Number(process.argv[2] ?? 12), q = process.argv[3] ?? '720p30', nRecv = Number(process.env.RECV ?? 1);
const chrome = process.env.CHROME ?? ['C:/Program Files/Google/Chrome/Application/chrome.exe', '/usr/bin/google-chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find(existsSync);
if (!chrome) throw new Error('Chrome not found; set CHROME=');
const TOKEN = 'probe';
const srv = await startServer({ port: 0, pub: resolve(import.meta.dirname, '../dist'), token: TOKEN, hosts: ['127.0.0.1'] });
const port = (srv.servers[0].address() as { port: number }).port;
const args = [
  ...(process.env.NO_GPU ? ['--disable-gpu'] : ['--enable-unsafe-webgpu']), '--autoplay-policy=no-user-gesture-required',
  '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', ...(process.env.NO_SANDBOX ? ['--no-sandbox'] : []),
];
// one browser per host: background tabs don't get animation frames
const browsers = await Promise.all(Array.from({ length: nRecv + 1 }, () => puppeteer.launch({ executablePath: chrome, headless: true, args })));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Replace getDisplayMedia with a w x h 30 fps canvas (a moving frame counter) plus a tone. */
async function fakeShare(p: Page, w = 1920, h = 1080): Promise<void> {
  await p.evaluate((w, h) => {
    navigator.mediaDevices.getDisplayMedia = async () => {
      const c = document.createElement('canvas'); c.width = w; c.height = h;
      const g = c.getContext('2d')!;
      let n = 0;
      setInterval(() => { n++; g.fillStyle = `hsl(${(n * 7) % 360} 70% 40%)`; g.fillRect(0, 0, w, h); g.fillStyle = '#fff'; g.font = '200px sans-serif'; g.fillText(String(n), 100 + (n * 13) % (w - 600), h / 2); }, 1000 / 30);
      const ac = new AudioContext(), osc = ac.createOscillator(), dst = ac.createMediaStreamDestination();
      osc.connect(dst); osc.start();
      return new MediaStream([...dst.stream.getAudioTracks(), ...c.captureStream(30).getVideoTracks()]);
    };
  }, w, h);
}

type St = { role: string; state: string; lines: string[]; stats: { latFrame: number | null; latRoom: number | null; hold: number | null; decodeMs: number; fps: number; w: number; h: number; kbps: number } | null; send: { encodeMs: number; fps: number; w: number; h: number; kbps: number }[] };
const st = (p: Page) => p.evaluate(() => (window as unknown as { __ekStream: () => unknown }).__ekStream()) as Promise<St>;
const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);

try {
  const open = async (i: number, name: string) => {
    const p = await browsers[i].newPage();
    p.on('pageerror', (e) => console.log(name, 'pageerror', (e as Error).message));
    await p.goto(`http://127.0.0.1:${port}/?t=${TOKEN}&name=${name}`);
    await p.waitForFunction(() => typeof (window as unknown as { __ekStream?: unknown }).__ekStream === 'function', { timeout: 20000 });
    return p;
  };
  const pages = await Promise.all(browsers.map((_, i) => open(i, i ? `recv${i}` : 'lead')));
  const [a, ...rs] = pages;
  await sleep(1500);
  if (q !== '720p30') await a.select('#streamQ', q);
  await fakeShare(a);
  await a.$eval('#capture', (e) => (e as HTMLButtonElement).click());
  const tail: St[][] = [];
  for (let i = 0; i < secs; i++) {
    await sleep(1000);
    const all = await Promise.all(pages.map(st));
    if (i >= secs / 2) tail.push(all);
    if (process.env.QUIET) continue;
    console.log(`t=${i + 1}s`);
    all.forEach((s, k) => s.lines.forEach((l) => console.log(`  ${k ? `R${k}` : 'A'} ${l}`)));
  }
  // summary over the second half (after the ramp)
  const sends = tail.flatMap((t) => t[0].send);
  console.log(`\nsummary ${q}, ${nRecv} receiver(s), last ${tail.length} s:`);
  console.log(`  leader: encode ${avg(sends.map((s) => s.encodeMs)).toFixed(2)} ms/frame per peer, ${avg(sends.map((s) => s.fps)).toFixed(1)} fps, ${avg(sends.map((s) => s.w)).toFixed(0)}x${avg(sends.map((s) => s.h)).toFixed(0)}, ${(avg(sends.map((s) => s.kbps)) / 1000).toFixed(2)} Mbps per peer; ~${((avg(sends.map((s) => s.encodeMs)) * avg(sends.map((s) => s.fps)) * nRecv) / 10).toFixed(0)}% of a core in total`);
  rs.forEach((_, k) => {
    const ss = tail.map((t) => t[k + 1].stats).filter((x) => x !== null);
    const f = ss.map((s) => s.latFrame).filter((x) => x !== null), r = ss.map((s) => s.latRoom).filter((x) => x !== null);
    console.log(`  R${k + 1}: ${tail.at(-1)![k + 1].state}, latency ${avg(f).toFixed(0)} ms display (min ${Math.min(...f).toFixed(0)} max ${Math.max(...f).toFixed(0)}), ${avg(r).toFixed(0)} ms track (room clock), hold ${avg(ss.map((s) => s.hold ?? NaN)).toFixed(0)} ms, decode ${avg(ss.map((s) => s.decodeMs)).toFixed(2)} ms/frame, ${avg(ss.map((s) => s.fps)).toFixed(1)} fps`);
  });
  console.log('  R1 hosts panel:', await rs[0].$eval('#hosts', (e) => e.textContent));
  await a.$eval('#stop', (e) => (e as HTMLButtonElement).click());
  await sleep(1500);
  console.log('  after stop: R1', (await st(rs[0])).lines.join(' | '));
} finally {
  await Promise.all(browsers.map((x) => x.close()));
  await srv.close();
}
