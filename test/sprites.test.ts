import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { encodeSheet, frameAt, layoutText, parseFont, parseSheet, sheetRgba, type Font } from '../lab/api/index.ts';
import { decodeGif, decodePng, encodePng, type Rgba } from '../scripts/lab/png.ts';
import { fromAseprite, fromRecipe, fromVox, importSprite, toSheet } from '../scripts/lab/sprites.ts';
import { bakePixelFont } from '../scripts/lab/fonts.ts';
import { capCheck, hostConfig, postProcess, readLedger, sheetPrompt, spriteGen, type GenDeps } from '../scripts/lab/imagegen.ts';
import { cleanLyrics, lyricAt, parseLrc } from '../src/core/lrc.ts';
import { applyStyle, validateStyle, type StylePack } from '../src/core/graph/style.ts';
import { compile, evalCpu } from '../src/core/graph/eval.ts';
import { validateScene } from '../src/core/graph/validate.ts';
import { silence } from '../src/core/features.ts';
import { loadPieces, loadScenes, loadStyles, LAB } from '../scripts/lab/load.ts';
import { swatch } from '../lab/pieces/color/core-swatch/driver.ts';
import { Room } from '../src/server/room.ts';
import type { WsConn } from '../src/server/ws.ts';
import type { RoomState, ServerMsg } from '../src/core/protocol.ts';
import { STRIDE } from '../src/core/constants.ts';

const { reg } = await loadPieces();

/** w x h RGBA filled by f(x, y). */
const img = (w: number, h: number, f: (x: number, y: number) => [number, number, number, number]): Rgba => {
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data.set(f(x, y), (y * w + x) * 4);
  return { w, h, data };
};

test('png: round trip, and filtered / palette / grey images decode', () => {
  const a = img(7, 5, (x, y) => [x * 30, y * 50, (x + y) * 10, x === y ? 0 : 255]);
  assert.deepEqual(decodePng(encodePng(a)), a);
  // hand-built: 3x2 RGB with Sub and Up filters
  const chunk = (id: string, body: Uint8Array) => { const b = Buffer.alloc(12 + body.length); b.writeUInt32BE(body.length); b.write(id, 4, 'latin1'); Buffer.from(body).copy(b, 8); return b; }; // CRC not checked by the decoder
  const ihdr = (w: number, h: number, depth: number, type: number) => { const b = Buffer.alloc(13); b.writeUInt32BE(w); b.writeUInt32BE(h, 4); b[8] = depth; b[9] = type; return b; };
  const png = (h: Buffer, raw: number[], extra: Buffer[] = []) => Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', h), ...extra, chunk('IDAT', deflateSync(Buffer.from(raw))), chunk('IEND', new Uint8Array())]);
  const rgb = decodePng(png(ihdr(3, 2, 8, 2), [1, 10, 20, 30, 5, 5, 5, 5, 5, 5, /* row 2, Up */ 2, 1, 1, 1, 0, 0, 0, 0, 0, 0]));
  assert.deepEqual([...rgb.data.subarray(0, 12)], [10, 20, 30, 255, 15, 25, 35, 255, 20, 30, 40, 255]);
  assert.deepEqual([...rgb.data.subarray(12, 16)], [11, 21, 31, 255]);
  const pal = decodePng(png(ihdr(2, 1, 8, 3), [0, 1, 0], [chunk('PLTE', new Uint8Array([0, 0, 0, 255, 0, 0])), chunk('tRNS', new Uint8Array([0]))]));
  assert.deepEqual([...pal.data], [255, 0, 0, 255, 0, 0, 0, 0]);
  const grey = decodePng(png(ihdr(4, 1, 2, 0), [0, 0b00011011]));
  assert.deepEqual([...grey.data].filter((_, i) => i % 4 === 0), [0, 85, 170, 255]);
});

/** A minimal GIF encoder (LZW with a clear code before every pixel: valid, if not small). */
function gif(w: number, h: number, frames: number[][], colours: [number, number, number][], delay = 10): Uint8Array {
  const out: number[] = [...Buffer.from('GIF89a'), w & 255, w >> 8, h & 255, h >> 8, 0xf1, 0, 0];
  for (let i = 0; i < 4; i++) out.push(...(colours[i] ?? [0, 0, 0]));
  for (const f of frames) {
    out.push(0x21, 0xf9, 4, 0, delay & 255, delay >> 8, 0, 0);
    out.push(0x2c, 0, 0, 0, 0, w & 255, w >> 8, h & 255, h >> 8, 0, 2);
    // codes are 3 bits (min code 2): clear(4), pixel, clear, pixel... eoi(5)
    const codes = f.flatMap((p) => [4, p]).concat(5), bytes: number[] = [];
    let acc = 0, n = 0;
    for (const c of codes) { acc |= c << n; n += 3; while (n >= 8) { bytes.push(acc & 255); acc >>= 8; n -= 8; } }
    if (n) bytes.push(acc & 255);
    for (let i = 0; i < bytes.length; i += 255) { const part = bytes.slice(i, i + 255); out.push(part.length, ...part); }
    out.push(0);
  }
  out.push(0x3b);
  return Uint8Array.from(out);
}

test('gif: frames composite and keep their delays', () => {
  const g = decodeGif(gif(2, 2, [[0, 1, 1, 0], [2, 2, 3, 3]], [[0, 0, 0], [255, 0, 0], [0, 255, 0], [0, 0, 255]], 7));
  assert.equal(g.frames.length, 2);
  assert.deepEqual(g.delays, [70, 70]);
  assert.deepEqual([...g.frames[0].subarray(4, 8)], [255, 0, 0, 255]);
  assert.deepEqual([...g.frames[1].subarray(12, 16)], [0, 0, 255, 255]);
  const s = toSheet(g.frames, g.w, g.h, { durations: g.delays });
  assert.equal(s.frames, 2); assert.equal(s.durations[1], 70);
});

test('sheets: encode/parse round trip, rgba, frame timing, tags', () => {
  const s = fromRecipe({ w: 3, h: 2, palette: { a: '#ff0000', b: '#00ff00' }, frames: [['a.b', 'bb'], ['...', '.a.']], tags: [{ name: 'idle', from: 1, to: 1 }] });
  const back = parseSheet(encodeSheet(s));
  assert.deepEqual(back, s);
  assert.equal(s.palette.length / 4, 3, 'index 0 transparent + 2 colours');
  assert.deepEqual([...sheetRgba(s, 0).subarray(0, 12)], [255, 0, 0, 255, 0, 0, 0, 0, 0, 255, 0, 255]);
  assert.deepEqual([...sheetRgba(s, 0).subarray(20, 24)], [0, 0, 0, 0], 'short rows are padded transparent');
  assert.equal(frameAt(s, 0, 2), 0); assert.equal(frameAt(s, 0.5, 2), 1); assert.equal(frameAt(s, 1, 2), 0);
  assert.equal(frameAt(s, 3.7, 2, 'idle'), 1);
  assert.throws(() => fromRecipe({ w: 2, h: 1, palette: { a: '#ff0000' }, frames: [['ax']] }), /'x' is not in the palette/);
  assert.throws(() => fromRecipe({ w: 2, h: 1, palette: { '.': '#ff0000' }, frames: [['..']] }), /palette key/);
  assert.throws(() => parseSheet(new Uint8Array(20)), /not a .spr/);
});

test('sprites: aseprite (trimmed, tags), png grids, vox slices; >255 colours are median-cut', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ek-spr-'));
  const sheetImg = img(8, 4, (x) => (x < 4 ? [255, 0, 0, 255] : [0, 0, 255, 255]));
  writeFileSync(join(dir, 'a.png'), encodePng(sheetImg));
  const json = {
    frames: { 'a 0': { frame: { x: 0, y: 0, w: 2, h: 2 }, spriteSourceSize: { x: 1, y: 1 }, sourceSize: { w: 4, h: 4 }, duration: 100 }, 'a 1': { frame: { x: 4, y: 0, w: 4, h: 4 }, sourceSize: { w: 4, h: 4 }, duration: 50 } },
    meta: { image: 'a.png', frameTags: [{ name: 'run', from: 0, to: 1 }] },
  };
  writeFileSync(join(dir, 'a.json'), JSON.stringify(json));
  const s = importSprite(join(dir, 'a.json'));
  assert.equal(s.frames, 2); assert.equal(s.w, 4); assert.deepEqual([...s.durations], [100, 50]); assert.deepEqual(s.tags, [{ name: 'run', from: 0, to: 1 }]);
  assert.deepEqual([...sheetRgba(s, 0).subarray(0, 4)], [0, 0, 0, 0], 'trimmed frame placed at its offset');
  assert.deepEqual([...sheetRgba(s, 0).subarray((1 * 4 + 1) * 4, (1 * 4 + 1) * 4 + 4)], [255, 0, 0, 255]);
  assert.equal(fromAseprite(json, sheetImg).frames, 2);
  const grid = importSprite(join(dir, 'a.png'), { frame: [4, 4] });
  assert.equal(grid.frames, 2);
  const many = toSheet([img(32, 32, (x, y) => [x * 8, y * 8, (x * y) & 255, 255]).data], 32, 32);
  assert.equal(many.palette.length / 4, 256);
  const few = toSheet([img(32, 32, (x, y) => [x * 8, y * 8, 0, 255]).data], 32, 32, { maxColors: 8 });
  assert.ok(few.palette.length / 4 <= 9);
  const vox = fromVox(readFileSync(join(LAB, 'assets/vox/furniture/chair.vox')));
  assert.ok(vox.frames > 3 && vox.w > 3, `chair: ${vox.frames} slices ${vox.w}x${vox.h}`);
});

test('fonts: pixel font bake, layout, wrap; the shipped MSDF font has crisp insides', () => {
  const pf = bakePixelFont();
  assert.equal(Object.keys(pf.glyphs).length, 95);
  const L = layoutText(pf, 'AB C\nDE', { align: 'center' });
  assert.equal(L.quads.length, 5, 'spaces and line breaks draw nothing');
  assert.deepEqual(L.lines, [6 * 4 - 0, 12]);
  assert.equal(L.quads[3].y, pf.lineHeight + pf.ascent - 7, 'second line');
  const W = layoutText(pf, 'one two three', { wrap: 6 * 8 });
  assert.equal(W.lines.length, 2);
  assert.equal(layoutText(pf, '€').quads[0].u0, layoutText(pf, '?').quads[0].u0, 'unknown -> ?');
  const f: Font = parseFont(readFileSync(join(LAB, 'assets/fonts/display-msdf.efont')));
  assert.equal(f.mode, 'msdf');
  const med = (x: number, y: number) => { const o = (y * f.atlasW + x) * 4, [r, g, b] = [f.pixels[o], f.pixels[o + 1], f.pixels[o + 2]]; return Math.max(Math.min(r, g), Math.min(Math.max(r, g), b)); };
  // 'I': its middle column is ink, its corners are not
  const I = f.glyphs['73'];
  assert.ok(med(I.x + Math.floor(I.w / 2), I.y + Math.floor(I.h / 2)) > 140);
  assert.ok(med(I.x, I.y) < 100);
  // 'O': the centre is the hole
  const O = f.glyphs['79'];
  assert.ok(med(O.x + Math.floor(O.w / 2), O.y + Math.floor(O.h / 2)) < 110);
});

test('lyrics: parse .lrc, look up the line at a time, clean untrusted lines', () => {
  const l = parseLrc('﻿[ti:Song]\n[offset:+500]\n[00:01.50]first\n[00:04.00][00:10.00]twice <00:04.50>word\n[01:00]last\nnot a line');
  assert.deepEqual(l.map((x) => [x.t, x.text]), [[1, 'first'], [3.5, 'twice word'], [9.5, 'twice word'], [59.5, 'last']]);
  assert.equal(lyricAt(l, 0.5), null);
  assert.deepEqual(lyricAt(l, 2.25), { text: 'first', index: 0, start: 1, end: 3.5, progress: 0.5 });
  assert.equal(lyricAt(l, 70)!.end, null);
  assert.deepEqual(cleanLyrics([{ t: 2, text: 'b' }, { t: -1, text: 'x' }, { t: 1, text: 'a'.repeat(500) }, 'junk']), [{ t: 1, text: 'a'.repeat(200) }, { t: 2, text: 'b' }]);
  assert.equal(cleanLyrics('nope'), null);
});

test('lyrics reach pieces as ctx.lyric(), and ride with the track in the room state', () => {
  // a graph whose cpu() reads the lyric (the text param is hashed; the lyric is not)
  const scene = loadScenes(undefined, reg).find((s) => s.id === 'claude-sprite-party')!;
  const plan = compile(scene, reg);
  const F = { ...silence, lyrics: parseLrc('[00:01.00]hello') };
  assert.equal(evalCpu(plan, 30, F).base.lyric(), null);
  assert.equal(evalCpu(plan, 90, F).base.lyric()?.text, 'hello');
  assert.deepEqual(evalCpu(plan, 90, F).hash, evalCpu(plan, 90, silence).hash, 'lyrics stay out of the hash');

  const room = new Room(() => 50_000, () => 0.5), got: ServerMsg[] = [];
  const ws = { onmessage: (_: Buffer | string) => {}, onclose: () => {}, json: (m: unknown) => got.push(m as ServerMsg), send: (s: string | Buffer) => { if (typeof s === 'string') got.push(JSON.parse(s)); } };
  room.join(ws as unknown as WsConn);
  const feat = new Uint8Array(5 + 10 * STRIDE); feat[0] = 2; new DataView(feat.buffer).setUint32(1, 10, true);
  ws.onmessage(Buffer.from(feat));
  ws.onmessage(JSON.stringify({ t: 'play', name: 'x', lyrics: [{ t: 1, text: 'hi' }, { t: 'bad' }] }));
  const st = [...got].reverse().find((m) => m.t === 'state') as RoomState;
  assert.equal(st.mode, 'file');
  assert.deepEqual(st.mode === 'file' && st.lyrics, [{ t: 1, text: 'hi' }]);
});

test('style packs: validate, expand (palette, FX chain, post, font), and the shipped ones are valid', () => {
  for (const s of loadStyles()) assert.deepEqual(validateStyle(s, reg), [], s.id);
  const vw = loadStyles().find((s) => s.id === 'core-vaporwave')!;
  const raw = loadScenes().find((s) => s.id === 'claude-sprite-party')!;
  const g = applyStyle(raw, new Map([[vw.id, vw]]), reg);
  assert.deepEqual(validateScene(g, reg), []);
  assert.equal(g.nodes.find((n) => n.id === 'style_palette')?.params?.colors, vw.palette.join(' '));
  for (const id of ['bg', 'crowd', 'hearts', 'words']) assert.ok(g.edges.some((e) => e.from === 'style_palette.palette' && e.to === `${id}.palette`), id);
  assert.equal(g.out, 'style_fx0.out');
  assert.ok(g.edges.some((e) => e.from === 'm3.out' && e.to === 'style_fx0.in'));
  assert.equal(g.post?.bloom, 0.55);
  assert.equal(g.nodes.find((n) => n.id === 'words')?.params?.font, 1, 'style font picked where the node did not set one');
  // the scene's own palette edges are replaced and its post wins
  const demo = loadScenes().find((s) => s.id === 'core-demo')!;
  const d2 = applyStyle({ ...demo, style: 'core-vaporwave', post: { bloom: 0.1 } }, new Map([[vw.id, vw]]), reg);
  assert.ok(!d2.edges.some((e) => e.from === 'pal.palette'));
  assert.equal(d2.post?.bloom, 0.1);
  compile(d2, reg);
  assert.throws(() => applyStyle({ ...demo, style: 'nope' }, new Map(), reg), /unknown style nope/);
  assert.equal(applyStyle(demo, new Map(), reg), demo, 'no style: unchanged');
  const bad: StylePack = { format: 1, id: 'x', name: '', author: { vendor: '' }, palette: ['#zzz'], fx: [{ piece: 'core-harmony' }, { piece: 'core-trails', params: { nope: 1 } }], post: { wat: 1 } as never };
  const errs = validateStyle(bad, reg).join('\n');
  for (const want of ['id must be', 'name required', 'vendor required', 'palette: 2 to 8', 'core-harmony needs exactly one tex input', 'has no param nope', 'post.wat']) assert.ok(errs.includes(want), want);
  assert.deepEqual(swatch('#ff0000, #00ff00 nope').length, 2);
  assert.equal(swatch('').length, 2, 'grey fallback');
});

// ------------------------------------------------------------------ sprite gen

/** A model's answer: `frames` red blobs on a flat blue background. */
const fakeSheet = (frames: number) => encodePng(img(128 * frames, 128, (x, y) => {
  const cx = (x % 128) - 64, cy = y - 64 - (Math.floor(x / 128) * 4);
  return cx * cx + cy * cy < 30 * 30 ? [220, 30, 40, 255] : cx * cx + cy * cy < 34 * 34 ? [20, 20, 20, 255] : [40, 90, 200, 255];
}));

function deps(env: Record<string, string>, reply: (url: string, body: unknown) => unknown): GenDeps & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls, env, now: () => new Date('2026-11-26T12:00:00Z'), task: 'task-1',
    fetch: (async (url: string, init?: RequestInit) => { calls.push(url); const j = reply(url, JSON.parse(String(init?.body))); return { ok: true, status: 200, json: async () => j } as Response; }) as typeof fetch,
  };
}

test('sprite gen: off unless the brief and the host both allow it; caps count the ledger', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ek-gen-')), cfgFile = join(dir, 'imagegen.json'), ledger = join(dir, 'ledger.jsonl');
  writeFileSync(cfgFile, JSON.stringify({ provider: 'openai', monthly: 2, ledger }));
  const base = { EINKLANG_IMAGEGEN_CONFIG: cfgFile, OPENAI_API_KEY: 'k' };
  const d = (env: Record<string, string>) => deps(env, () => ({}));
  assert.match(capCheck(hostConfig(base), d(base))!, /brief has no `imagegen: N`/);
  assert.match(capCheck(hostConfig({ ...base, EINKLANG_IMAGEGEN_MONTHLY: '0' }), d({ ...base, EINKLANG_IMAGEGEN: '1' }))!, /off on this host/);
  assert.match(capCheck(hostConfig(base), d({ EINKLANG_IMAGEGEN_CONFIG: cfgFile, EINKLANG_IMAGEGEN: '1' }))!, /OPENAI_API_KEY is not set/);
  assert.equal(capCheck(hostConfig(base), d({ ...base, EINKLANG_IMAGEGEN: '1' })), null);
  writeFileSync(ledger, [{ month: '2026-11', task: 'task-1' }, { month: '2026-10', task: 'other' }].map((l) => JSON.stringify(l)).join('\n') + '\n');
  assert.match(capCheck(hostConfig(base), d({ ...base, EINKLANG_IMAGEGEN: '1' }))!, /this task's cap reached \(1\/1/);
  writeFileSync(ledger, [{ month: '2026-11', task: 'a' }, { month: '2026-11', task: 'b' }].map((l) => JSON.stringify(l)).join('\n') + '\n');
  assert.match(capCheck(hostConfig(base), d({ ...base, EINKLANG_IMAGEGEN: '5' }))!, /monthly cap reached \(2\/2/);
  assert.match(sheetPrompt('a cat', 4), /4 animation frames .* ONE horizontal row/);
});

test('sprite gen: openai and gemini requests, ledger line, post-processing to a clean sheet', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ek-gen-')), ledger = join(dir, 'l.jsonl');
  for (const provider of ['openai', 'gemini'] as const) {
    const cfgFile = join(dir, `${provider}.json`);
    writeFileSync(cfgFile, JSON.stringify({ provider, monthly: 10, ledger }));
    const png = Buffer.from(fakeSheet(4)).toString('base64');
    const dd = deps({ EINKLANG_IMAGEGEN_CONFIG: cfgFile, EINKLANG_IMAGEGEN: '3', OPENAI_API_KEY: 'o', GEMINI_API_KEY: 'g' }, (url, body) => {
      const b = body as { prompt?: string; contents?: { parts: { text: string }[] }[] };
      assert.match(b.prompt ?? b.contents![0].parts[0].text, /^a red blob\. Pixel art, a sprite sheet of 4/);
      return provider === 'openai' ? { data: [{ b64_json: png }] } : { candidates: [{ content: { parts: [{ text: 'here' }, { inlineData: { data: png } }] } }] };
    });
    const r = await spriteGen({ prompt: 'a red blob', frames: 4, size: 16, colors: 4 }, dd);
    assert.match(dd.calls[0], provider === 'openai' ? /api\.openai\.com\/v1\/images\/generations/ : /generativelanguage.*gemini-2\.5-flash-image:generateContent/);
    assert.equal(r.provider, provider);
    assert.equal(r.sheet.frames, 4); assert.equal(r.sheet.w, 16);
    assert.ok(r.sheet.palette.length / 4 - 1 <= 4);
    const f0 = sheetRgba(r.sheet, 0);
    assert.equal(f0[3], 0, 'background removed (corner transparent)');
    assert.equal(f0[(8 * 16 + 8) * 4 + 3], 255, 'the blob is opaque');
    assert.ok(f0[(8 * 16 + 8) * 4] > 150, 'and red');
  }
  const lines = readLedger(ledger);
  assert.deepEqual(lines.map((l) => [l.provider, l.task, l.month, l.prompt]), [['openai', 'task-1', '2026-11', 'a red blob'], ['gemini', 'task-1', '2026-11', 'a red blob']]);
  // --from-png: no API, no ledger, same pipeline
  const before = readLedger(ledger).length;
  const r = await spriteGen({ prompt: 'local', frames: 2, size: 8, fromPng: fakeSheet(2) }, deps({}, () => { throw new Error('no network'); }));
  assert.equal(r.provider, 'file'); assert.equal(r.sheet.frames, 2);
  assert.equal(readLedger(ledger).length, before);
  assert.throws(() => postProcess(img(64, 64, () => [9, 9, 9, 255]), { frames: 1, size: 8 }), /empty after background removal/);
});
