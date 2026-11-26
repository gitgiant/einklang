// Renders gallery screenshots with real WebGPU in headless Chrome -> docs/mockups/*.png
// Usage: npm run mockups   (CHROME=<path to chrome> to override the browser)
import { createServer } from 'vite';
import puppeteer from 'puppeteer-core';
import { mkdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const out = resolve(root, 'docs/mockups');
mkdirSync(out, { recursive: true });

const chrome = process.env.CHROME ?? [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
].find(existsSync);
if (!chrome) throw new Error('Chrome not found; set CHROME=');

// [file, query, demo-time to stop at]. Times land on interesting moments of the demo track.
const shots: [string, string, number][] = [
  ['radial', 'scene=radial', 37.93],
  ['tunnel', 'scene=tunnel', 38.43],
  ['scope', 'scene=scope', 38.2],
  ['scope-build', 'scene=scope', 24.1],
  ['flow', 'scene=flow', 38.87],
  ['grid', 'grid=1', 38.43],
  ['hud-flow', 'scene=flow&hud=1', 39.5],
];

const server = await createServer({ root, logLevel: 'error', server: { port: 5199, strictPort: true } });
await server.listen();
const browser = await puppeteer.launch({
  executablePath: chrome,
  headless: true,
  args: ['--enable-unsafe-webgpu', '--enable-features=Vulkan', '--ignore-gpu-blocklist', '--hide-scrollbars'],
});
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 900, deviceScaleFactor: 1 });
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warn') console.log(`  [${m.type()}] ${m.text()}`); });
  page.on('pageerror', (e) => console.log(`  [pageerror] ${e}`));
  const only = process.env.ONLY?.split(',');
  for (const [name, q, stop] of shots.filter(([n]) => !only || only.includes(n))) {
    const hud = q.includes('hud=1') ? '' : '&hud=0';
    const url = `http://localhost:5199/gallery.html?${q}${hud}&start=${(stop - 3).toFixed(2)}&stop=${stop}`;
    await page.goto(url);
    await page.waitForFunction('window.__done || window.__error', { timeout: 30000 });
    const err = await page.evaluate('window.__error');
    if (err) throw new Error(`${name}: ${err}`);
    if (name === 'hud-flow') await new Promise((r) => setTimeout(r, 300));
    await page.screenshot({ path: resolve(out, `${name}.png`) as `${string}.png` });
    console.log(`${name}.png`);
  }
} finally {
  await browser.close();
  await server.close();
}
