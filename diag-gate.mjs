// TEMP diag (to be reverted): run the gate, then return gate.md's numbers through the junit file.
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
const junit = process.argv[2];
const r = spawnSync('npm run lab -- gate --no-profile --junit diag-junit.xml', { shell: true, stdio: 'inherit' });
const md = existsSync('lab/out/gate.md') ? readFileSync('lab/out/gate.md', 'utf8') : 'no gate.md';
const keep = md.split('\n').filter((l) => /^## |audio reaction|cost |\*\*|motion|frozen|black/.test(l)).join('\n');
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const orig = existsSync('diag-junit.xml') ? readFileSync('diag-junit.xml', 'utf8') : '';
writeFileSync(junit, `<?xml version="1.0"?><testsuites><testsuite name="diag" tests="1" failures="1"><testcase classname="diag" name="gate-notes"><failure message="notes">${esc(`exit ${r.status}\n` + keep)}</failure></testcase></testsuite></testsuites>`);
console.log(orig.length);
