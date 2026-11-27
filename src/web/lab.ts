// Lab render page (lab.html), driven by `einklang-lab render|gate` through puppeteer: renders a
// scene tick by tick against a fixture, reads frames back for checks, builds a contact sheet and
// a webm. Not a user-facing page.
import { initGpu } from './gpu/gpu.ts';
import { Engine } from './engine.ts';
import { REGISTRY } from './graph/registry.ts';
import { fixtureSource, type FixtureName } from '../core/fixtures.ts';
import { fileSource, type FeatureSource } from '../core/features.ts';
import { STRIDE } from '../core/constants.ts';
import type { SceneGraph } from '../core/graph/types.ts';
import { validateScene } from '../core/graph/validate.ts';
import { Output, WebMOutputFormat, BufferTarget, CanvasSource } from 'mediabunny';
import { NO_FX } from '../core/fx.ts';
import { TICKS_PER_BEAT } from '../core/constants.ts';
import { transEntry } from '../core/transitions.ts';
import type { SceneSched } from '../core/protocol.ts';
import { FrameProfiler } from './gpu/profile.ts';
import { MEDIA, canvasItem } from './media.ts';
import { forceAll, type ForcePlan } from '../core/graph/sections.ts';

export interface RunOpts {
  scene: SceneGraph | string;
  fixture: FixtureName | string;
  /** First tick and number of ticks rendered (every tick is rendered: feedback needs them all). */
  start: number; ticks: number;
  /** Check every `every`-th tick (readback + stats); `sheet` of those go on the contact sheet. */
  every: number; sheet: number;
  /** Video: frames per second (0 = none) and width. */
  fps: number; videoWidth: number;
  /** Time this many extra frames without readback for the cost per frame. */
  perfFrames: number;
  /**
   * Render a transition instead of `scene`: `id` from scene `from` to `to`, starting at tick `at`,
   * `ticks` long (seed fixed). The contact sheet is labelled with the progress.
   */
  transition?: { id: string; from: string; to: string; at: number; ticks: number; seed?: number };
  /**
   * What core-media shows (generated here, no network): `test` = a still image then a moving
   * "video" (a canvas redrawn every tick, so runs stay deterministic), `image`, `video`, or `none`
   * (the fallback). Default `test`.
   */
  media?: 'test' | 'image' | 'video' | 'none';
  /**
   * A scene with sections: `all` (default) forces base and then every variant in turn over the run
   * (equal parts, switching with the scene's transitions), `auto` lets `when` pick, or one section id.
   */
  sections?: 'all' | 'auto' | string;
}

/**
 * Profile one switch: `from` alone for `before` ticks, the transition `trans` for `ticks`, then `to`
 * alone for `after`. Every frame is timed on its own (encode, submit, wait for the GPU), so a
 * hitch lands on the frame that caused it. Keep `start` increasing across runs so sims step on.
 */
export interface ProfileOpts {
  fixture: string; start: number;
  from: string; to: string; trans: string; seed?: number;
  before: number; ticks: number; after: number;
  /** Display sub-tick (0..255) every frame is drawn at, like the app's interpolation. */
  sub?: number;
  /**
   * Profile a section change inside scene `from` instead of a show switch: section `section.from`
   * (an id, `base` for the base graph) alone for `before`, then `section.to` comes in with the
   * scene's transition for it (`ticks` is ignored: the transition's own length), then `after`.
   */
  section?: { from: string; to: string };
}
export interface ProfileFrame {
  /** Ticks from the switch (negative: before it). */
  at: number;
  /** Frame ms: encode + submit + GPU done, serialized. */
  wall: number;
  /** JS ms for engine.frame (state + encode + submit). */
  js: number;
  cpu: Record<string, number>;
  gpu: Record<string, number> | null;
}
export interface ProfileResult { ok: boolean; error?: string; frames: ProfileFrame[]; timestamps: boolean; errors: string[] }

export interface FrameStat { tick: number; luma: number; black: number; white: number; nan: number; thumb: number[]; /** A scene with sections: the one showing. */ section?: string }
export interface RunResult {
  ok: boolean; error?: string; hashes: string[];
  stats: FrameStat[];
  msPerFrame: number;
  sheet?: string; video?: string;
  adapter: string;
  errors: string[];
}

declare global { interface Window { __lab?: { run(o: RunOpts): Promise<RunResult>; profile?(o: ProfileOpts): Promise<ProfileResult>; ready: boolean; adapter: string } } }

const TW = 64, TH = 36;
const errors: string[] = [];
const origError = console.error;
console.error = (...a: unknown[]) => { errors.push(a.map(String).join(' ')); origError(...a); };

async function source(name: string): Promise<FeatureSource> {
  if (['quiet', 'techno', 'dense', 'silence'].includes(name)) return fixtureSource(name as FixtureName);
  const r = await fetch(`/lab/fixtures/${name}.feat`);
  if (!r.ok) throw new Error(`fixture ${name}: not built in and no lab/fixtures/${name}.feat`);
  const bytes = new Uint8Array(await r.arrayBuffer()), hdr = new DataView(bytes.buffer).getUint32(0, true);
  return fileSource(bytes.subarray(4), hdr || Math.floor((bytes.length - 4) / STRIDE));
}

/** Read a texture back (rows padded to 256 bytes). */
async function readTexture(device: GPUDevice, tex: GPUTexture, bpp: number): Promise<{ data: Uint8Array; row: number }> {
  const row = Math.ceil((tex.width * bpp) / 256) * 256;
  const buf = device.createBuffer({ size: row * tex.height, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  const enc = device.createCommandEncoder();
  enc.copyTextureToBuffer({ texture: tex }, { buffer: buf, bytesPerRow: row }, [tex.width, tex.height]);
  device.queue.submit([enc.finish()]);
  await buf.mapAsync(GPUMapMode.READ);
  const data = new Uint8Array(buf.getMappedRange().slice(0));
  buf.unmap(); buf.destroy();
  return { data, row };
}

/** A 3:2 still: sky, sun, mountains, a checker, big letters: shapes a viewer (and luma / edges) can recognise. */
function testImage(): OffscreenCanvas {
  const c = new OffscreenCanvas(1200, 800), g = c.getContext('2d')!;
  const sky = g.createLinearGradient(0, 0, 0, 800);
  sky.addColorStop(0, '#1b2a6b'); sky.addColorStop(0.55, '#e0607e'); sky.addColorStop(1, '#ffc46b');
  g.fillStyle = sky; g.fillRect(0, 0, 1200, 800);
  g.fillStyle = '#fff1b0'; g.beginPath(); g.arc(820, 330, 120, 0, Math.PI * 2); g.fill();
  g.fillStyle = '#2a1840'; g.beginPath(); g.moveTo(0, 800);
  for (let x = 0; x <= 1200; x += 40) g.lineTo(x, 560 - 140 * Math.abs(Math.sin(x * 0.006)) - 60 * Math.abs(Math.sin(x * 0.021)));
  g.lineTo(1200, 800); g.fill();
  for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) { g.fillStyle = (x + y) & 1 ? '#fff' : '#000'; g.fillRect(40 + x * 30, 40 + y * 30, 30, 30); }
  g.fillStyle = '#fff'; g.font = 'bold 220px sans-serif'; g.fillText('EK', 90, 760);
  return c;
}
/** A 16:9 "video": a ball bouncing over turning stripes and a frame counter, drawn for tick `t`. */
function drawTestVideo(g: OffscreenCanvasRenderingContext2D, t: number): void {
  const w = 640, h = 360;
  g.fillStyle = '#0d1424'; g.fillRect(0, 0, w, h);
  g.save(); g.translate(w / 2, h / 2); g.rotate(t * 0.01);
  for (let i = -8; i < 8; i++) { g.fillStyle = i & 1 ? '#1f6f8b' : '#99d5c9'; g.fillRect(i * 50, -400, 25, 800); }
  g.restore();
  const x = 60 + Math.abs(((t * 4) % (2 * (w - 120))) - (w - 120)), y = h - 60 - Math.abs(Math.sin(t * 0.06)) * 220;
  g.fillStyle = '#ff5a36'; g.beginPath(); g.arc(x, y, 46, 0, Math.PI * 2); g.fill();
  g.fillStyle = '#fff'; g.font = 'bold 40px monospace'; g.fillText(String(t).padStart(5, '0'), 20, 50);
}

async function main() {
  const gpu = await initGpu({ timestamps: true });
  const canvas = document.getElementById('c') as HTMLCanvasElement;
  const engine = new Engine(gpu, canvas);
  const d = gpu.device, bgra = gpu.format === 'bgra8unorm';

  async function run(o: RunOpts): Promise<RunResult> {
    errors.length = 0;
    const res: RunResult = { ok: false, hashes: [], stats: [], msPerFrame: 0, adapter: gpu.adapterInfo, errors };
    try {
      let id: string, sched: SceneSched | undefined;
      if (o.transition) {
        const t = o.transition;
        if (!transEntry(t.id)) throw new Error(`unknown transition ${t.id}`);
        for (const s of [t.from, t.to]) if (!engine.scenes.some((x) => x.def.id === s)) throw new Error(`unknown scene ${s}`);
        sched = { id: t.to, prev: t.from, at: t.at, trans: { type: t.id, ticks: t.ticks, seed: t.seed ?? 0x5eed1234, tpb: TICKS_PER_BEAT }, earlier: [] };
        id = t.from;
      } else if (typeof o.scene === 'string') id = o.scene;
      else {
        const errs = validateScene(o.scene, REGISTRY);
        if (errs.length) throw new Error(errs.join('\n'));
        id = engine.addScene(o.scene).def.id;
      }
      if (!engine.scenes.some((s) => s.def.id === id)) throw new Error(`unknown scene ${id}`);
      engine.setScene(id);
      const sc = engine.scene, secMode = o.sections ?? 'all';
      if (sc.sections.length && !sched) {
        if (secMode === 'all') sc.force(forceAll(sc.graph, o.start, o.ticks));
        else if (secMode !== 'auto') {
          const i = sc.sections.indexOf(secMode);
          if (i < 0) throw new Error(`${id} has no section ${secMode} (${sc.sections.join(', ')})`);
          sc.force([{ at: 0, idx: i - 1 }]);
        } else sc.force(null);
      }
      // generated test media for core-media (per host, not hashed)
      const mode = o.media ?? 'test', vc = new OffscreenCanvas(640, 360), vg = vc.getContext('2d')!, video = canvasItem(vc, 'video', 'test video');
      MEDIA.set([...(mode === 'test' || mode === 'image' ? [canvasItem(testImage(), 'image', 'test image')] : []), ...(mode === 'test' || mode === 'video' ? [video] : [])]);
      const drawMedia = (t: number) => { if (mode === 'test' || mode === 'video') { drawTestVideo(vg, t); video.touch(); } };
      const F = await source(o.fixture);
      await engine.bench();

      const W = Math.max(1, Math.round(canvas.clientWidth * (devicePixelRatio || 1))), H = Math.max(1, Math.round(canvas.clientHeight * (devicePixelRatio || 1)));
      const cols = Math.max(1, Math.ceil(Math.sqrt(o.sheet))), tw = 320, th = Math.round((320 * H) / W);
      const rows = Math.max(1, Math.ceil(o.sheet / cols));
      const sheet = new OffscreenCanvas(cols * tw, rows * th), sctx = sheet.getContext('2d')!;
      const frame = new OffscreenCanvas(W, H), fctx = frame.getContext('2d')!;
      const thumb = new OffscreenCanvas(TW, TH), tctx = thumb.getContext('2d', { willReadFrequently: true })!;
      const vw = o.videoWidth, vh = Math.round((vw * H) / W / 2) * 2;
      const vcanvas = new OffscreenCanvas(vw, vh), vctx = vcanvas.getContext('2d')!;
      let output: Output | null = null, vsrc: CanvasSource | null = null;
      if (o.fps > 0) {
        output = new Output({ format: new WebMOutputFormat(), target: new BufferTarget() });
        vsrc = new CanvasSource(vcanvas as unknown as HTMLCanvasElement, { codec: 'vp9', bitrate: 2e6 });
        output.addVideoTrack(vsrc, { frameRate: o.fps });
        await output.start();
      }
      const videoEvery = o.fps > 0 ? Math.max(1, Math.round(60 / o.fps)) : 0;
      const sheetEvery = Math.max(1, Math.floor(o.ticks / o.every / Math.max(1, o.sheet))) * o.every;
      let sheetN = 0;

      const grab = async () => {
        const { data, row } = await readTexture(d, engine.canvasTexture, 4);
        const img = new ImageData(W, H);
        for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
          const s = y * row + x * 4, t = (y * W + x) * 4;
          img.data[t] = data[s + (bgra ? 2 : 0)]; img.data[t + 1] = data[s + 1]; img.data[t + 2] = data[s + (bgra ? 0 : 2)]; img.data[t + 3] = 255;
        }
        fctx.putImageData(img, 0, 0);
        return img;
      };

      for (let i = 0; i < o.ticks; i++) {
        const tick = o.start + i, check = i % o.every === 0, vid = videoEvery && i % videoEvery === 0;
        drawMedia(tick);
        res.hashes.push(engine.frame(tick, F, NO_FX, sched));
        if (!check && !vid) continue;
        // the canvas texture is only valid within this task: read it back before yielding
        const img = await grab();
        if (vid && vsrc) { vctx.drawImage(frame, 0, 0, vw, vh); await vsrc.add(i / 60, videoEvery / 60); }
        if (!check) continue;
        let luma = 0, black = 0, white = 0;
        const px = W * H, step = Math.max(1, Math.floor(px / 20000));
        let n = 0;
        for (let p = 0; p < px; p += step, n++) {
          const r = img.data[p * 4] / 255, g = img.data[p * 4 + 1] / 255, b = img.data[p * 4 + 2] / 255;
          const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
          luma += l; if (l < 0.02) black++; if (r > 0.98 && g > 0.98 && b > 0.98) white++;
        }
        // NaN / Inf in the HDR scene target (half floats with an all-ones exponent)
        let nan = 0;
        const st = engine.sceneTexture;
        if (st && i % (o.every * 4) === 0) {
          const { data, row } = await readTexture(d, st, 8), u16 = new Uint16Array(data.buffer);
          for (let y = 0; y < st.height; y += 4) for (let x = 0; x < st.width * 4; x += 4) if ((u16[(y * row) / 2 + x] & 0x7c00) === 0x7c00) nan++;
        }
        tctx.drawImage(frame, 0, 0, TW, TH);
        const td = tctx.getImageData(0, 0, TW, TH).data, tl: number[] = [];
        for (let p = 0; p < TW * TH; p++) tl.push(Math.round((0.2126 * td[p * 4] + 0.7152 * td[p * 4 + 1] + 0.0722 * td[p * 4 + 2])));
        const sec = engine.scene.section();
        res.stats.push({ tick, luma: luma / n, black: black / n, white: white / n, nan, thumb: tl, ...(sec ? { section: sec.id } : {}) });
        if (i % sheetEvery === 0 && sheetN < o.sheet) {
          sctx.drawImage(frame, (sheetN % cols) * tw, Math.floor(sheetN / cols) * th, tw, th);
          const label = (sched ? `p ${(engine.transition?.p ?? (tick < sched.at ? 0 : 1)).toFixed(2)}` : `${(tick / 60).toFixed(2)}s`)
            + (sec ? ` ${sec.from ? `${sec.from}→` : ''}${sec.id}` : '');
          sctx.font = '11px monospace';
          sctx.fillStyle = '#000a'; sctx.fillRect((sheetN % cols) * tw, Math.floor(sheetN / cols) * th, Math.max(70, sctx.measureText(label).width + 8), 16);
          sctx.fillStyle = '#ddd';
          sctx.fillText(label, (sheetN % cols) * tw + 4, Math.floor(sheetN / cols) * th + 12);
          sheetN++;
        }
      }
      if (output && vsrc) {
        await output.finalize();
        const buf = (output.target as BufferTarget).buffer!;
        res.video = btoa(Array.from(new Uint8Array(buf), (c) => String.fromCharCode(c)).join(''));
      }
      if (o.sheet > 0) {
        const bytes = new Uint8Array(await (await sheet.convertToBlob({ type: 'image/png' })).arrayBuffer());
        res.sheet = btoa(Array.from(bytes, (c) => String.fromCharCode(c)).join(''));
      }

      // cost per frame: keep going from where the run stopped, no readback
      await d.queue.onSubmittedWorkDone();
      const t0 = performance.now(), end = o.start + o.ticks + o.perfFrames;
      for (let t = o.start + o.ticks; t < end; t++) { drawMedia(t); engine.frame(t, F, NO_FX, sched); }
      await d.queue.onSubmittedWorkDone();
      res.msPerFrame = o.perfFrames ? (performance.now() - t0) / o.perfFrames : 0;
      res.ok = true;
    } catch (e) {
      res.error = (e as Error).message;
    }
    return res;
  }
  const prof = new FrameProfiler(d);
  const sources = new Map<string, FeatureSource>();
  async function profile(o: ProfileOpts): Promise<ProfileResult> {
    errors.length = 0;
    const res: ProfileResult = { ok: false, frames: [], timestamps: prof.timestamps, errors };
    try {
      if (!o.section && !transEntry(o.trans)) throw new Error(`unknown transition ${o.trans}`);
      for (const s of [o.from, o.to]) if (!engine.scenes.some((x) => x.def.id === s)) throw new Error(`unknown scene ${s}`);
      if (!sources.has(o.fixture)) sources.set(o.fixture, await source(o.fixture));
      const F = sources.get(o.fixture)!, at = o.start + o.before;
      let sched: SceneSched | undefined = { id: o.to, prev: o.from, at, trans: { type: o.trans, ticks: o.ticks, seed: o.seed ?? 0x5eed1234, tpb: TICKS_PER_BEAT }, earlier: [] };
      engine.setScene(o.from);
      if (o.section) {
        // a section change inside one scene: no show switch, the scene's own blend
        const sc = engine.scene, idx = (id: string) => { const i = sc.sections.indexOf(id); if (i < 0) throw new Error(`${o.from} has no section ${id}`); return i - 1; };
        const plan: ForcePlan = [{ at: o.start, idx: idx(o.section.from) }, { at, idx: idx(o.section.to) }];
        sc.force(plan);
        sched = undefined;
      }
      await d.queue.onSubmittedWorkDone();
      engine.profiler = prof;
      try {
        for (let t = o.start; t < at + o.ticks + o.after; t++) {
          const t0 = performance.now();
          engine.frame(t, F, NO_FX, sched, o.sub ?? 0);
          const t1 = performance.now();
          const p = await prof.read();
          await d.queue.onSubmittedWorkDone();
          res.frames.push({ at: t - at, wall: performance.now() - t0, js: t1 - t0, cpu: p.cpu, gpu: p.gpu });
        }
      } finally { engine.profiler = null; if (o.section) engine.scene.force(null); }
      res.ok = true;
    } catch (e) {
      res.error = (e as Error).message;
    }
    return res;
  }
  window.__lab = { run, profile, ready: true, adapter: gpu.adapterInfo };
}

main().catch((e: Error) => { window.__lab = { ready: true, adapter: '', run: async () => ({ ok: false, error: e.message, hashes: [], stats: [], msPerFrame: 0, adapter: '', errors }) }; });
