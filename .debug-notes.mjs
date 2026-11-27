// Throwaway (reverted): turn the gate's junit notes into failures so the worker sees the numbers.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
const f = process.argv[2];
let x = readFileSync(f, 'utf8');
const unesc = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
x = x.replace(/<testcase ([^>]*)>([\s\S]*?)<\/testcase>/g, (m, attrs, body) => {
  const out = /<system-out>([\s\S]*?)<\/system-out>/.exec(body);
  const msg = out ? unesc(out[1]) : 'no notes';
  return `<testcase ${attrs}><failure message="${esc(msg.replace(/\s+/g, ' ').slice(0, 2500))}">${esc(msg)}</failure></testcase>`;
});
if (existsSync('lab/out/gate.md')) {
  const md = readFileSync('lab/out/gate.md', 'utf8');
  x = x.replace('</testsuite>', `<testcase name="gate.md" classname="debug"><failure message="${esc(md.replace(/\s+/g, ' ').slice(0, 4000))}">${esc(md)}</failure></testcase></testsuite>`);
}
writeFileSync(f, x);
