import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const junit = process.argv[2];
const run = spawnSync('npm', ['run', 'lab', '--', 'gate', '--no-profile', '--no-video', '--junit', junit], {
  stdio: 'inherit',
  shell: process.platform === 'win32',
});

if (!existsSync(junit) || !existsSync('lab/out/gate.md')) process.exit(run.status ?? 1);
const report = readFileSync('lab/out/gate.md', 'utf8');
const metrics = report.split('\n').filter((line) =>
  /^(WebGPU:|## |\s*- (audio reaction|cost))/.test(line));
const escaped = metrics.join('\n').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const xml = readFileSync(junit, 'utf8');
const diagnostic = '<testsuite name="gpu-metrics" tests="1" failures="1">' +
  '<testcase name="pass-through-metrics"><failure message="Diagnostic only. Gate exit ' +
  run.status + '">' + escaped + '</failure></testcase></testsuite>';
writeFileSync(junit, xml.replace('</testsuites>', diagnostic + '</testsuites>'));
process.exit(run.status ?? 1);
