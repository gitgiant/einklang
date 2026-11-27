// TEMPORARY diagnostic (reverted): ship gate.md and downscaled sheets back through JUnit failure text.
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { decodePng, encodePng } from './scripts/lab/png.ts';
const junit = process.argv[2];
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const cases: string[] = [];
const add = (name: string, body: string) => {
  const b64 = Buffer.from(body).toString('base64');
  const per = Math.ceil(b64.length / 19);
  const lines = ['x'];
  for (let i = 0; i < b64.length; i += per) lines.push(b64.slice(i, i + per));
  cases.push(`<testcase name="${name}" classname="diag"><failure message="diag">${esc(lines.join('\n'))}</failure></testcase>`);
};
const out = 'lab/out';
if (existsSync(join(out, 'gate.md'))) add('gate.md', readFileSync(join(out, 'gate.md'), 'utf8'));
for (const id of ['claude-media-flyover', 'claude-media-tube', 'claude-media-voxels']) {
  for (const fx of ['dense', 'quiet']) {
    const f = join(out, id, fx, 'sheet.png');
    if (!existsSync(f)) continue;
    const img = decodePng(readFileSync(f));
    const k = Math.max(1, Math.ceil(img.w / 1280));
    const w = Math.floor(img.w / k), h = Math.floor(img.h / k);
    const d = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) for (let c = 0; c < 4; c++) {
      let s = 0; for (let j = 0; j < k; j++) for (let i = 0; i < k; i++) s += img.data[((y * k + j) * img.w + x * k + i) * 4 + c];
      d[(y * w + x) * 4 + c] = Math.round(s / (k * k));
    }
    add(`${id}-${fx}.png`, Buffer.from(encodePng({ w, h, data: d })).toString('latin1'));
  }
}
add('ls', readdirSync(out).join(' '));
writeFileSync(junit, `<?xml version="1.0"?><testsuites><testsuite name="diag" tests="${cases.length}" failures="${cases.length}">${cases.join('')}</testsuite></testsuites>`);
