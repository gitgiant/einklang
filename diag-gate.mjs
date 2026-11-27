// TEMP diag (to be reverted): run the gate, then return gate.md's numbers through the junit file.
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
const junit = process.argv[2];
const r = spawnSync('npm run lab -- gate --no-profile --junit diag-junit.xml', { shell: true, stdio: 'inherit' });
const md = existsSync('lab/out/gate.md') ? readFileSync('lab/out/gate.md', 'utf8') : 'no gate.md';
const keep = md.split('## ').slice(1).map((b) => {
  const L = b.split('\n'), id = L[0];
  const react = (b.match(/audio reaction ([^\n]*)/) || [])[1] || '';
  const cost = (b.match(/cost ([0-9.]+)/) || [])[1] || '';
  const lum = [...b.matchAll(/\[(\w+)\] (section (\S+): )?luma ([0-9.]+), motion ([0-9.]+)/g)].map((m) => `${m[1][0]}${m[3] ? '/' + m[3] : ''}:${(+m[4]).toFixed(2)}/${(+m[5]).toFixed(3)}`).join(' ');
  const fails = L.filter((l) => l.startsWith('- **')).join(' ');
  return `${id} | ${cost}ms | ${react.replace(/quiet |techno |dense /g, '')} | ${lum} ${fails}`;
}).join('\n');
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const orig = existsSync('diag-junit.xml') ? readFileSync('diag-junit.xml', 'utf8') : '';
writeFileSync(junit, `<?xml version="1.0"?><testsuites><testsuite name="diag" tests="1" failures="1"><testcase classname="diag" name="gate-notes"><failure message="notes">${esc(`exit ${r.status}\n` + keep)}</failure></testcase></testsuite></testsuites>`);
console.log(orig.length);
