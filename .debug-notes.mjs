// Throwaway (reverted): run the gate, then report its notes and ASCII thumbnails of the contact sheets as junit failures.
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
spawnSync('npm', ['run', 'lab', '--', 'gate', '--junit', process.argv[2]], { stdio: 'inherit', shell: true });
const f = process.argv[2];
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const cases = [];
const add = (name, msg, body) => cases.push(`<testcase name="${esc(name)}" classname="debug"><failure message="${esc(msg)}">${esc(body)}</failure></testcase>`);

function png(path) {
  const b = readFileSync(path);
  let o = 8, w = 0, h = 0, ct = 0; const idat = [];
  while (o < b.length) {
    const len = b.readUInt32BE(o), type = b.toString('ascii', o + 4, o + 8), d = b.subarray(o + 8, o + 8 + len);
    if (type === 'IHDR') { w = d.readUInt32BE(0); h = d.readUInt32BE(4); ct = d[9]; }
    if (type === 'IDAT') idat.push(d);
    o += 12 + len;
  }
  const bpp = ct === 6 ? 4 : 3, raw = inflateSync(Buffer.concat(idat)), stride = w * bpp, px = Buffer.alloc(h * stride);
  for (let y = 0; y < h; y++) {
    const ft = raw[y * (stride + 1)], row = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? px[y * stride + x - bpp] : 0, up = y ? px[(y - 1) * stride + x] : 0, c = y && x >= bpp ? px[(y - 1) * stride + x - bpp] : 0;
      let v = row[x];
      if (ft === 1) v += a; else if (ft === 2) v += up; else if (ft === 3) v += (a + up) >> 1;
      else if (ft === 4) { const p = a + up - c, pa = Math.abs(p - a), pb = Math.abs(p - up), pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? up : c; }
      px[y * stride + x] = v & 255;
    }
  }
  return { w, h, bpp, px };
}
const RAMP = ' .:-=+*#%@';
function tile(img, ti, cols = 4, tw = 320, th = 180, W = 56, H = 14) {
  const x0 = (ti % cols) * tw, y0 = Math.floor(ti / cols) * th;
  let s = '', R = 0, G = 0, B = 0, n = 0;
  for (let j = 0; j < H; j++) {
    for (let i = 0; i < W; i++) {
      let l = 0, k = 0;
      for (let y = Math.floor(j * th / H); y < Math.floor((j + 1) * th / H); y += 2) for (let x = Math.floor(i * tw / W); x < Math.floor((i + 1) * tw / W); x += 2) {
        const p = ((y0 + y) * img.w + x0 + x) * img.bpp, r = img.px[p], g = img.px[p + 1], bl = img.px[p + 2];
        l += 0.2126 * r + 0.7152 * g + 0.0722 * bl; k++; R += r; G += g; B += bl; n++;
      }
      s += RAMP[Math.min(9, Math.floor((l / k / 256) * 10))];
    }
    s += '\n';
  }
  return { s, rgb: [R / n, G / n, B / n].map((v) => v.toFixed(0)).join(',') };
}

if (existsSync('lab/out/gate.md')) {
  const md = readFileSync('lab/out/gate.md', 'utf8');
  for (const sec of md.split(/\n(?=## )/)) {
    const id = /^## \S+ (\S+)/.exec(sec)?.[1];
    if (!id) continue;
    const body = sec.replace(/\n\s*\n/g, '\n');
    add(`notes ${id}`, body.replace(/\s+/g, ' ').slice(0, 900), body.slice(0, 1400));
    for (const fx of ['dense', 'quiet']) {
      const p = `lab/out/${id}/${fx}/sheet.png`;
      if (!existsSync(p)) continue;
      try {
        const img = png(p);
        const tiles = id.includes('media-') ? (fx === 'dense' ? [1, 4, 7, 10] : [5]) : (fx === 'dense' ? [2, 9] : [6]);
        for (const t of tiles) { const r = tile(img, t); add(`sheet ${id} ${fx} #${t}`, `mean rgb ${r.rgb}`, r.s); }
      } catch (e) { add(`sheet ${id} ${fx}`, String(e), String(e)); }
    }
  }
}
let x = readFileSync(f, 'utf8');
x = x.replace(/<testsuite ([^>]*)>/, '<testsuite $1>\n' + cases.join('\n'));
writeFileSync(f, x);
process.exit(1);
