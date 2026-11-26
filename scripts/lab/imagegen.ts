// `einklang-lab sprite gen`: AI sprites through an image API. Opt-in twice over:
//   - the task's brief sets `imagegen: N`, which the delegator passes as EINKLANG_IMAGEGEN=N (images this task may make)
//   - the host config sets a monthly cap (0 or missing = off)
// Code-drawn sprites (*.sprite.json + `sprite import`) are the default; this is for what code can't draw well.
//
// Host config (never in the repo): $EINKLANG_IMAGEGEN_CONFIG, else ~/.einklang/imagegen.json:
//   { "provider": "openai" | "gemini", "model": "...", "monthly": 40, "ledger": "~/.einklang/imagegen.jsonl" }
// Keys come from the environment: OPENAI_API_KEY or GEMINI_API_KEY. Every image made is a line in the ledger
// (month, task, provider, model, prompt), which is what the caps count.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Sheet } from '../../lab/api/index.ts';
import { decodePng, type Rgba } from './png.ts';
import { crop, downscale, removeBackground, toSheet, type Rgb } from './sprites.ts';

export type Provider = 'openai' | 'gemini';
export const DEFAULT_MODEL: Record<Provider, string> = { openai: 'gpt-image-1', gemini: 'gemini-2.5-flash-image' };

export interface HostConfig { provider: Provider; model: string; monthly: number; ledger: string }
export interface GenDeps {
  env: Record<string, string | undefined>;
  fetch: typeof fetch;
  now: () => Date;
  /** The task id the per-task cap counts against (default: env EINKLANG_TASK). */
  task?: string;
}
export interface LedgerLine { at: string; month: string; task: string; provider: Provider; model: string; prompt: string }

const expand = (p: string, env: GenDeps['env']) => p.replace(/^~(?=$|[/\\])/, env.HOME ?? env.USERPROFILE ?? homedir());

export function hostConfig(env: GenDeps['env']): HostConfig {
  const file = expand(env.EINKLANG_IMAGEGEN_CONFIG ?? '~/.einklang/imagegen.json', env);
  const raw = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) as Partial<HostConfig> : {};
  const provider: Provider = raw.provider === 'gemini' ? 'gemini' : 'openai';
  return {
    provider, model: raw.model ?? DEFAULT_MODEL[provider],
    monthly: Number(env.EINKLANG_IMAGEGEN_MONTHLY ?? raw.monthly ?? 0) || 0,
    ledger: expand(raw.ledger ?? '~/.einklang/imagegen.jsonl', env),
  };
}

export function readLedger(file: string): LedgerLine[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).flatMap((l) => { try { return [JSON.parse(l) as LedgerLine]; } catch { return []; } });
}

/** Why this call may not make an image (null = it may). */
export function capCheck(cfg: HostConfig, deps: GenDeps): string | null {
  const brief = Number(deps.env.EINKLANG_IMAGEGEN ?? 0) || 0, task = deps.task ?? deps.env.EINKLANG_TASK ?? 'local';
  if (brief <= 0) return 'image generation is off for this task (the brief has no `imagegen: N`): draw it as code instead (*.sprite.json + `sprite import`)';
  if (cfg.monthly <= 0) return 'image generation is off on this host (no monthly cap in the host config)';
  const key = cfg.provider === 'openai' ? 'OPENAI_API_KEY' : 'GEMINI_API_KEY';
  if (!deps.env[key]) return `${key} is not set on this host`;
  const month = deps.now().toISOString().slice(0, 7), lines = readLedger(cfg.ledger);
  const used = lines.filter((l) => l.month === month).length, mine = lines.filter((l) => l.task === task).length;
  if (used >= cfg.monthly) return `monthly cap reached (${used}/${cfg.monthly} images in ${month})`;
  if (mine >= brief) return `this task's cap reached (${mine}/${brief} images)`;
  return null;
}

/** The prompt sent to the model: the brief's description plus the sheet layout we can slice. */
export function sheetPrompt(prompt: string, frames: number): string {
  const layout = frames > 1
    ? `a sprite sheet of ${frames} animation frames of the same subject in ONE horizontal row, evenly spaced, same size and baseline in every frame`
    : 'a single sprite, centred';
  return `${prompt}. Pixel art, ${layout}, bold readable silhouette, limited palette, flat solid plain background in a single colour that is not used in the sprite, no text, no labels, no grid lines, no shadows on the background.`;
}

/** Call the provider; returns PNG bytes. */
export async function requestImage(cfg: HostConfig, prompt: string, deps: GenDeps): Promise<Uint8Array> {
  if (cfg.provider === 'openai') {
    const r = await deps.fetch('https://api.openai.com/v1/images/generations', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${deps.env.OPENAI_API_KEY}` },
      body: JSON.stringify({ model: cfg.model, prompt, n: 1, size: '1024x1024', background: 'transparent', output_format: 'png' }),
    });
    const j = await r.json() as { data?: { b64_json?: string }[]; error?: { message?: string } };
    const b64 = j.data?.[0]?.b64_json;
    if (!r.ok || !b64) throw new Error(`openai: ${j.error?.message ?? r.status}`);
    return Buffer.from(b64, 'base64');
  }
  const r = await deps.fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(cfg.model)}:generateContent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': deps.env.GEMINI_API_KEY ?? '' },
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { responseModalities: ['IMAGE'] } }),
  });
  const j = await r.json() as { candidates?: { content?: { parts?: { inlineData?: { data?: string } }[] } }[]; error?: { message?: string } };
  const b64 = j.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data)?.inlineData?.data;
  if (!r.ok || !b64) throw new Error(`gemini: ${j.error?.message ?? r.status}`);
  return Buffer.from(b64, 'base64');
}

/**
 * Model image -> sheet: slice `frames` equal columns, remove the background, crop every frame to the
 * union of their opaque boxes (so they stay aligned), fit into size x size, quantize (palette, or
 * median cut to `colors`).
 */
export function postProcess(img: Rgba, opts: { frames: number; size: number; palette?: Rgb[]; colors?: number }): Sheet {
  const fw = Math.floor(img.w / opts.frames);
  const cells = Array.from({ length: opts.frames }, (_, i) => removeBackground({ w: fw, h: img.h, data: crop(img, i * fw, 0, fw, img.h) }));
  let x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1;
  for (const c of cells) for (let y = 0; y < c.h; y++) for (let x = 0; x < c.w; x++) if (c.data[(y * c.w + x) * 4 + 3] >= 128) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  if (x1 < 0) throw new Error('the image came back empty after background removal');
  // square box around the union, so the sprite keeps its proportions
  const side = Math.max(x1 - x0 + 1, y1 - y0 + 1), cx = (x0 + x1 + 1) / 2, cy = (y0 + y1 + 1) / 2;
  const bx = Math.round(cx - side / 2), by = Math.round(cy - side / 2);
  const frames = cells.map((c) => downscale({ w: side, h: side, data: crop(c, bx, by, side, side) }, opts.size, opts.size).data);
  const sheet = toSheet(frames, opts.size, opts.size, { palette: opts.palette, maxColors: opts.colors ?? 16 });
  return sheet;
}

export interface GenResult { sheet: Sheet; model: string; provider: Provider | 'file'; prompt: string; png: Uint8Array }

/** The whole `sprite gen` step short of vendoring. `fromPng` skips the API (and the caps). */
export async function spriteGen(o: { prompt: string; frames: number; size: number; palette?: Rgb[]; colors?: number; fromPng?: Uint8Array }, deps: GenDeps): Promise<GenResult> {
  if (!(o.frames >= 1 && o.frames <= 32)) throw new Error('--frames 1..32');
  if (!(o.size >= 8 && o.size <= 256)) throw new Error('--size 8..256');
  if (o.fromPng) return { sheet: postProcess(decodePng(o.fromPng), o), model: 'none', provider: 'file', prompt: o.prompt, png: o.fromPng };
  const cfg = hostConfig(deps.env), why = capCheck(cfg, deps);
  if (why) throw new Error(why);
  const full = sheetPrompt(o.prompt, o.frames), png = await requestImage(cfg, full, deps);
  const line: LedgerLine = { at: deps.now().toISOString(), month: deps.now().toISOString().slice(0, 7), task: deps.task ?? deps.env.EINKLANG_TASK ?? 'local', provider: cfg.provider, model: cfg.model, prompt: o.prompt };
  mkdirSync(dirname(cfg.ledger), { recursive: true });
  appendFileSync(cfg.ledger, JSON.stringify(line) + '\n');
  return { sheet: postProcess(decodePng(png), o), model: cfg.model, provider: cfg.provider, prompt: o.prompt, png };
}

export const previewDir = (lab: string) => join(lab, 'out', 'sprites');
