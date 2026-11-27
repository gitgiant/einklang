// Headless Chrome + a Vite dev server for the lab page. Uses the real GPU when Chrome finds one,
// else SwiftShader (CPU WebGPU), which is what Hauptling worker containers have.
import { createServer, type ViteDevServer } from 'vite';
import puppeteer, { type Browser, type Page } from 'puppeteer-core';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ProfileOpts, ProfileResult, RunOpts, RunResult } from '../../src/web/lab.ts';

const root = resolve(import.meta.dirname, '../..');

export function findChrome(): string {
  const c = process.env.CHROME ?? [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/opt/google/chrome/chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
  ].find(existsSync);
  if (!c) throw new Error('Chrome not found; install it or set CHROME=<path>');
  return c;
}

export interface Lab {
  run(o: RunOpts): Promise<RunResult>;
  profile(o: ProfileOpts): Promise<ProfileResult>;
  bench(): Promise<string[]>;
  /** Load the page again: a new device, so pipelines and targets start cold. */
  reload(): Promise<void>;
  /** The WebGPU adapter in use, and whether it is SwiftShader. */
  adapter: string; cpu: boolean;
  close(): Promise<void>;
}

const GPU_ARGS = ['--enable-unsafe-webgpu', '--enable-features=Vulkan', '--ignore-gpu-blocklist'];
// full-precision timestamp queries (Chrome rounds them to 100 µs otherwise), no shader disk cache
const COLD_ARGS = ['--enable-webgpu-developer-features', '--disable-gpu-shader-disk-cache'];
const CPU_ARGS = ['--enable-unsafe-webgpu', '--use-webgpu-adapter=swiftshader', '--enable-unsafe-swiftshader'];

/** `cold`: no GPU shader disk cache, so a reload compiles every pipeline again (profile mode). */
export async function openLab(opts: { width: number; height: number; cpu?: boolean; cold?: boolean; log?: (s: string) => void }): Promise<Lab> {
  const log = opts.log ?? (() => {});
  const server: ViteDevServer = await createServer({ root, logLevel: 'error', server: { port: 5300 + Math.floor(Math.random() * 500), strictPort: false, forwardConsole: false } });
  await server.listen();
  const url = server.resolvedUrls!.local[0];
  const launch = async (cpu: boolean): Promise<{ browser: Browser; page: Page; adapter: string }> => {
    const browser = await puppeteer.launch({
      executablePath: findChrome(), headless: true,
      args: [...(cpu ? CPU_ARGS : GPU_ARGS), ...(opts.cold ? COLD_ARGS : []), '--hide-scrollbars', ...(process.platform === 'linux' ? ['--no-sandbox'] : [])],
    });
    const page = await browser.newPage();
    await page.setViewport({ width: opts.width, height: opts.height, deviceScaleFactor: 1 });
    page.on('pageerror', (e) => log(`[pageerror] ${e}`));
    await page.goto(`${url}lab.html`);
    await page.waitForFunction('window.__lab && window.__lab.ready', { timeout: 120000 });
    const adapter = (await page.evaluate('window.__lab.adapter')) as string;
    return { browser, page, adapter };
  };
  let cpu = !!opts.cpu, s = await launch(cpu);
  if (!s.adapter && !cpu) { log('no GPU adapter: falling back to SwiftShader (CPU)'); await s.browser.close(); cpu = true; s = await launch(true); }
  if (!s.adapter) { await s.browser.close(); await server.close(); throw new Error('WebGPU is not available, not even on SwiftShader'); }
  const { browser, page } = s;
  return {
    adapter: s.adapter, cpu: cpu || /swiftshader/i.test(s.adapter),
    bench: () => page.evaluate('window.__shareBench()') as Promise<string[]>,
    run: (o) => page.evaluate((x) => window.__lab!.run(x), o as never) as Promise<RunResult>,
    profile: (o) => page.evaluate((x) => window.__lab!.profile!(x), o as never) as Promise<ProfileResult>,
    reload: async () => { await page.reload(); await page.waitForFunction('window.__lab && window.__lab.ready', { timeout: 120000 }); },
    close: async () => { await browser.close(); await server.close(); },
  };
}
