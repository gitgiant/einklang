// Scene gallery: every v1 scene driven by the synthetic demo track, no server needed.
// URL params:
//   scene=radial|tunnel|scope|flow   which scene (default radial)
//   grid=1                           all four at once
//   start=<s>                        demo-track time to start at (default 0)
//   stop=<s>                         stop rendering at this demo time (for screenshots); sets window.__done
//   hud=0                            hide HUD and tab bar
import { initGpu } from './gpu/gpu.ts';
import { Engine } from './engine.ts';
import { demoSource, sectionAt } from '../core/demo.ts';
import { FPS } from '../core/constants.ts';

declare global { interface Window { __done?: boolean; __error?: string } }

const qs = new URLSearchParams(location.search);
const $ = (id: string) => document.getElementById(id)!;
const F = demoSource();
const startTick = Math.round(+(qs.get('start') ?? 0) * FPS);
const stopTick = qs.has('stop') ? Math.round(+qs.get('stop')! * FPS) : Infinity;
let hud = qs.get('hud') !== '0';
let grid = (qs.get('grid') ?? document.body.dataset.grid) === '1'; // data-grid: default for hosted builds
let current = qs.get('scene') ?? 'radial';

async function main() {
  const gpu = await initGpu();
  const stage = $('stage'), bar = $('bar');
  const cells = Array.from({ length: 4 }, () => {
    const cell = document.createElement('div'); cell.className = 'cell';
    const cv = document.createElement('canvas'), tag = document.createElement('div'); tag.className = 'tag';
    cell.append(cv, tag); stage.append(cell);
    return { cell, tag, engine: new Engine(gpu, cv) };
  });
  const ids = cells[0].engine.scenes.map((s) => s.def.id);

  const layout = () => {
    stage.classList.toggle('grid', grid);
    cells.forEach((c, i) => {
      c.cell.classList.toggle('hide', !grid && i > 0);
      c.engine.setScene(grid ? i : current);
      c.tag.textContent = grid ? c.engine.scene.def.name : '';
    });
    for (const b of bar.querySelectorAll('button')) b.setAttribute('aria-pressed', String(b.dataset.id === (grid ? 'grid' : current)));
    $('hud').classList.toggle('hide', !hud); bar.classList.toggle('hide', !hud);
  };
  const go = (id: string) => {
    if (id === 'grid') grid = !grid; else { grid = false; current = id; }
    try {
      const u = new URL(location.href); u.searchParams.set('scene', current); grid ? u.searchParams.set('grid', '1') : u.searchParams.delete('grid');
      history.replaceState(null, '', u);
    } catch { /* sandboxed frames may refuse URL updates; the view still switches */ }
    layout();
  };
  for (const [i, id] of [...ids, 'grid'].entries()) {
    const b = document.createElement('button');
    b.dataset.id = id;
    b.textContent = id === 'grid' ? 'grid' : `${i + 1} ${cells[0].engine.scenes[i].def.name}`;
    b.onclick = () => go(id);
    bar.append(b);
  }
  addEventListener('keydown', (e) => {
    if (e.key === 'h') { hud = !hud; layout(); }
    else if (e.key === 'g') go('grid');
    else if (+e.key >= 1 && +e.key <= ids.length) go(ids[+e.key - 1]);
  });
  layout();

  const t0 = performance.now();
  let frames = 0, fps = 0, lastFps = t0;
  const loop = () => {
    const now = performance.now();
    const tick = Math.min(startTick + Math.floor(((now - t0) * FPS) / 1000), stopTick);
    const active = grid ? cells : cells.slice(0, 1);
    const hashes = active.map((c) => c.engine.frame(tick, F));
    frames++;
    if (now - lastFps > 500) { fps = (frames * 1000) / (now - lastFps); frames = 0; lastFps = now; }
    if (hud) {
      const sc = cells[0].engine.scene;
      $('hud').textContent = [
        `${grid ? 'grid' : sc.def.name}  ·  demo ${(tick / FPS).toFixed(2)}s  ${sectionAt(tick)}`,
        `tick ${tick}  hash ${hashes.join(' ')}`,
        !grid && sc.status ? sc.status() : null,
        `${fps.toFixed(0)} fps  ·  WebGPU ${gpu.adapterInfo}`,
      ].filter(Boolean).join('\n');
    }
    if (tick >= stopTick) { gpu.device.queue.onSubmittedWorkDone().then(() => { window.__done = true; }); return; }
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}

main().catch((e: Error) => {
  window.__error = e.message;
  const el = $('err'); el.style.display = 'grid'; el.textContent = e.message;
});
