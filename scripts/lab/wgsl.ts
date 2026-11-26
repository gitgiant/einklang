// WGSL compile check without the lab page: headless Chrome (SwiftShader; the compiler is the same
// Tint as on a GPU) on a blank localhost page, so `validate` stays quick. Used for the assembled
// transition shader.
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import puppeteer from 'puppeteer-core';
import { findChrome } from './browser.ts';

export interface WgslMessage { type: string; line: number; col: number; message: string }

/** Compile each module; returns its messages, or throws when there is no Chrome / WebGPU. */
export async function compileWgsl(modules: string[]): Promise<WgslMessage[][]> {
  const http = createServer((_, res) => { res.setHeader('content-type', 'text/html'); res.end('<!doctype html><title>wgsl</title>'); });
  await new Promise<void>((r) => http.listen(0, '127.0.0.1', r));
  const browser = await puppeteer.launch({
    executablePath: findChrome(), headless: true,
    args: ['--enable-unsafe-webgpu', '--use-webgpu-adapter=swiftshader', '--enable-unsafe-swiftshader', ...(process.platform === 'linux' ? ['--no-sandbox'] : [])],
  });
  try {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${(http.address() as AddressInfo).port}/`);
    const out = await page.evaluate(async (mods: string[]) => {
      const a = await navigator.gpu?.requestAdapter();
      if (!a) return null;
      const d = await a.requestDevice();
      const res = [];
      for (const code of mods) {
        const ci = await d.createShaderModule({ code }).getCompilationInfo();
        res.push(ci.messages.map((m) => ({ type: m.type, line: m.lineNum, col: m.linePos, message: m.message })));
      }
      return res;
    }, modules);
    if (!out) throw new Error('no WebGPU adapter (not even SwiftShader)');
    return out;
  } finally {
    await browser.close();
    http.close();
  }
}
