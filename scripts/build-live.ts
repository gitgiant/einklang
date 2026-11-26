// Builds the scene gallery as ONE self-contained HTML file (inline CSS + JS, no server needed),
// for hosting a live preview anywhere static. Usage: npm run build:live [-- <out.html>]
import { build } from 'vite';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join, dirname } from 'node:path';
import { labAssets } from './lab/vite-assets.ts';

const root = resolve(import.meta.dirname, '..');
const out = resolve(process.argv[2] ?? join(root, 'dist-live/einklang-gallery.html'));
const tmp = mkdtempSync(join(tmpdir(), 'einklang-live-'));

await build({
  root, logLevel: 'warn', configFile: false, plugins: [labAssets()],
  build: {
    outDir: tmp, emptyOutDir: true, target: 'es2022',
    lib: { entry: join(root, 'src/web/gallery.ts'), formats: ['iife'], name: 'einklang', fileName: () => 'gallery.js' },
  },
});

const js = readFileSync(join(tmp, 'gallery.js'), 'utf8').replace(/<\/script/gi, '<\\/script');
const src = readFileSync(join(root, 'gallery.html'), 'utf8');
const grab = (re: RegExp) => { const m = re.exec(src); if (!m) throw new Error(`gallery.html: ${re} not found`); return m[1]; };
// Fragment form (title + style + body content): static hosts that wrap pages in their own
// skeleton accept it, and browsers parse it fine standalone too.
const html = [
  `<title>${grab(/<title>([\s\S]*?)<\/title>/)}</title>`,
  `<style>${grab(/<style>([\s\S]*?)<\/style>/)}</style>`,
  grab(/<body>([\s\S]*?)<script/).trim(),
  `<script>document.body.dataset.grid = '1';</script>`,
  `<script>\n${js}\n</script>`,
].join('\n');
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, html);
console.log(`${out} (${(html.length / 1024).toFixed(0)} KB)`);
