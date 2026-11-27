import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BarCounter, CYCLE_BARS, CYCLE_OPTIONS, FIT_MODES, NO_MEDIA, fitScale, fitUv, pickItem } from '../lab/api/media.ts';
import { MediaHost, isImage, isVideo, type MediaItem } from '../src/web/media.ts';
import { cameraError } from '../src/web/capture.ts';
import { harness } from '../src/core/graph/harness.ts';
import { validateScene } from '../src/core/graph/validate.ts';
import { loadPieces } from '../scripts/lab/load.ts';

const close = (a: number[], b: number[]) => a.every((x, i) => Math.abs(x - b[i]) < 1e-9);

test('fit: cover fills and crops, contain shows everything, stretch ignores aspect', () => {
  // 2:1 source on a 16:9 screen: wider than the screen
  const r = 2 / (16 / 9);
  assert.ok(close(fitScale(2, 16 / 9, 'cover'), [1 / r, 1]));
  assert.ok(close(fitScale(2, 16 / 9, 'contain'), [1, r]));
  // a portrait 9:16 source on 16:9
  const p = (9 / 16) / (16 / 9);
  assert.ok(close(fitScale(9 / 16, 16 / 9, 'cover'), [1, p]));
  assert.ok(close(fitScale(9 / 16, 16 / 9, 'contain'), [1 / p, 1]));
  assert.deepEqual(fitScale(2, 1, 'stretch'), [1, 1]);
  assert.deepEqual(fitScale(1.5, 1.5, 'cover'), [1, 1]);
  // the enum index works too, out-of-range clamps, a broken aspect falls back to stretch
  assert.deepEqual(fitScale(2, 16 / 9, 1), fitScale(2, 16 / 9, 'contain'));
  assert.deepEqual(fitScale(2, 16 / 9, 9), fitScale(2, 16 / 9, 'stretch'));
  assert.deepEqual(fitScale(0, 16 / 9, 'cover'), [1, 1]);
  assert.equal(FIT_MODES.length, 3);

  // cover: the screen corners land inside the source; contain: the source corners land on screen
  for (const [sa, da] of [[2, 16 / 9], [9 / 16, 16 / 9], [1, 1], [4 / 3, 21 / 9]]) {
    const cov = fitScale(sa, da, 'cover'), con = fitScale(sa, da, 'contain');
    for (const c of [[0, 0], [1, 1], [0, 1]] as [number, number][]) {
      const u = fitUv(c, cov);
      assert.ok(u.every((x) => x >= -1e-9 && x <= 1 + 1e-9), `cover ${sa}/${da} corner ${c} -> ${u}`);
      const v = fitUv(c, con);
      assert.ok(v.some((x) => x <= 1e-9 || x >= 1 - 1e-9), `contain ${sa}/${da}: a screen corner is on or past the source edge`);
      // one axis exactly spans the screen in both modes
      assert.ok(cov.includes(1) && con.includes(1));
    }
    // contain keeps the whole source: scale >= 1 on both axes; cover crops: <= 1
    assert.ok(con.every((x) => x >= 1 - 1e-9) && cov.every((x) => x <= 1 + 1e-9));
  }
  // zoom narrows the view around the centre, mirror flips x
  assert.ok(close(fitUv([0, 0], [1, 1], 2), [0.25, 0.25]));
  assert.ok(close(fitUv([0.5, 0.5], [0.5, 1], 3), [0.5, 0.5]));
  assert.ok(close(fitUv([0, 0.5], [1, 1], 1, true), [1, 0.5]));
});

test('cycling: bars counted from the beat-in-bar wraps, items step every `per` bars', () => {
  const c = new BarCounter();
  const seq = [0, 0, 1, 2, 3, 0, 1, 2, 3, 3, 0, 2, 0];
  const out = seq.map((b) => c.step(b));
  assert.deepEqual(out, [0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 2, 2, 3]);
  // a beat grid (the fixed 28-tick one): 8 bars over 8 * 4 * 28 ticks
  const g = new BarCounter();
  let bars = 0;
  for (let t = 0; t < 8 * 4 * 28; t++) bars = g.step(Math.floor(t / 28) & 3);
  assert.equal(bars, 7);

  assert.equal(pickItem(0, 5, 1), -1, 'nothing picked: the fallback');
  assert.equal(pickItem(1, 99, 1), 0);
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 7, 8].map((b) => pickItem(3, b, 2)), [0, 0, 1, 1, 2, 2, 0, 0, 1]);
  assert.deepEqual([0, 4, 8].map((b) => pickItem(3, b, 0, 1)), [1, 1, 1], 'off: stays on `item`');
  assert.equal(pickItem(3, 0, 1, 7), 1, 'offset wraps');
  assert.equal(pickItem(3, 0, 1, -1), 2);
  assert.equal(CYCLE_OPTIONS.length, CYCLE_BARS.length);
});

/** A fake GPU device recording textures and uploads. */
function fakeDevice() {
  const log = { created: 0, destroyed: 0, uploads: 0 };
  const device = {
    createTexture: (d: { size: number[] }) => { log.created++; return { size: d.size, destroy: () => { log.destroyed++; } }; },
    queue: { copyExternalImageToTexture: () => { log.uploads++; } },
  } as unknown as GPUDevice;
  return { device, log };
}
function item(kind: MediaItem['kind'], w = 64, h = 32, ready = true): MediaItem & { stopped: number; w: number; h: number; isReady: boolean } {
  const it = {
    kind, name: kind, source: {} as ImageBitmap, mirror: kind === 'camera', gen: 0, stopped: 0, w, h, isReady: ready,
    size: (): [number, number] => [it.w, it.h], ready: () => it.isReady, stop: () => { it.stopped++; },
  };
  return it;
}

test('media host: fallback when empty, images upload once, video only on new frames', () => {
  const host = new MediaHost(), { device, log } = fakeDevice(), inp = host.input(device);
  assert.equal(inp.count(), 0);
  assert.equal(inp.frame(0), null, 'nothing picked: null (core-media draws its fallback)');
  assert.equal(NO_MEDIA.frame(0), null);

  const img = item('image', 300, 200), vid = item('video', 640, 360);
  let changed = 0;
  host.listeners.add(() => changed++);
  host.set([img, vid]);
  assert.equal(changed, 1);
  assert.equal(inp.count(), 2);
  for (let i = 0; i < 5; i++) inp.frame(0);
  assert.equal(log.uploads, 1, 'an image uploads once');
  const f = inp.frame(2)!; // wraps to item 0
  assert.deepEqual([f.width, f.height, f.kind, f.mirror], [300, 200, 'image', false]);

  inp.frame(1); inp.frame(1);
  assert.equal(log.uploads, 2, 'a video uploads its first frame once');
  vid.gen++; inp.frame(1); inp.frame(1);
  assert.equal(log.uploads, 3, 'and again only when a new frame exists');
  // the video changed size (camera rotated): a new texture
  vid.w = 360; vid.h = 640; vid.gen++;
  assert.equal(inp.frame(1)!.height, 640);
  assert.equal(log.destroyed, 1);

  // not ready yet: the last frame it had, or null
  const late = item('video', 10, 10, false);
  host.set([late]);
  assert.equal(img.stopped + vid.stopped, 2, 'replaced items stop');
  assert.equal(log.destroyed, 3, 'and their textures go');
  assert.equal(inp.frame(0), null);
  late.isReady = true;
  assert.ok(inp.frame(0));
  late.isReady = false;
  assert.ok(inp.frame(0), 'keeps showing its last frame');

  // textures are per device
  const b = fakeDevice();
  host.input(b.device).frame(0);
  assert.equal(b.log.created, 0, 'not ready on the new device: nothing to show yet');
  host.clear();
  assert.equal(host.input(device).count(), 0);
});

test('media host: a video pauses when not shown, unless its sound drives the music', () => {
  const host = new MediaHost(), { device } = fakeDevice();
  let now = 0;
  host.now = () => now;
  const fakeVideo = () => { const v = { paused: false, play: () => { v.paused = false; return Promise.resolve(); }, pause: () => { v.paused = true; } }; return v; };
  const a = item('video'), b = item('video'), s = item('video');
  a.video = fakeVideo() as unknown as HTMLVideoElement; b.video = fakeVideo() as unknown as HTMLVideoElement; s.video = fakeVideo() as unknown as HTMLVideoElement; s.audio = true;
  host.set([a, b, s]);
  host.frame(device, 0); now = 5000; host.frame(device, 0);
  assert.equal(a.video.paused, false);
  assert.equal(b.video.paused, true, 'not shown for a while: paused');
  assert.equal(s.video.paused, false, 'its sound drives the music: plays on');
  host.frame(device, 1);
  assert.equal(b.video.paused, false, 'shown again: plays');
  host.clear(); // stops the idle timer
});

test('media files and camera errors', () => {
  assert.ok(isImage({ name: 'a.PNG', type: '' }) && isImage({ name: 'x', type: 'image/webp' }) && isImage({ name: 'b.gif', type: '' }));
  assert.ok(isVideo({ name: 'clip.mov', type: '' }) && isVideo({ name: 'c.webm', type: '' }) && isVideo({ name: 'x', type: 'video/mp4' }));
  assert.ok(!isImage({ name: 'song.mp3', type: 'audio/mpeg' }) && !isVideo({ name: 'song.mp3', type: 'audio/mpeg' }));
  const nav = (ua: string, touch = 0) => ({ userAgent: ua, maxTouchPoints: touch });
  const blocked = { name: 'NotAllowedError', message: 'denied' };
  assert.equal(cameraError(blocked, '', nav('Mozilla/5.0 (Windows NT 10.0) Chrome/130')), 'camera blocked: allow the camera for this site in the browser\'s site settings');
  assert.equal(cameraError(blocked, '', nav('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Version/18.0 Mobile/15E148 Safari/604.1', 5)),
    'camera blocked: allow Camera for this browser in iOS Settings → Apps → Safari, and for this site in the browser\'s site settings, then tap camera again');
  assert.equal(cameraError({ name: 'NotFoundError', message: 'no camera' }, '', nav('x')), 'camera failed: no camera');
});

test('harness: mask and field inputs come from core-media; the media scenes validate', async () => {
  const { reg } = await loadPieces();
  for (const id of ['core-media', 'claude-displace', 'claude-lumakey', 'claude-ridges', 'claude-slices', 'claude-dots']) {
    const h = harness(id, reg);
    assert.equal(typeof h, 'object', `${id}: ${String(h)}`);
    if (typeof h === 'string') continue;
    assert.deepEqual(validateScene(h, reg), [], id);
    const b = harness(id, reg, true);
    if (typeof b !== 'string') assert.deepEqual(validateScene(b, reg), [], `${id} base`);
  }
  const h = harness('claude-lumakey', reg);
  if (typeof h !== 'string') {
    assert.ok(h.edges.some((e) => e.from === 'media.luma' && e.to === 'p.key'));
    assert.ok(h.nodes.some((n) => n.piece === 'core-media'));
  }
  const d = harness('claude-displace', reg);
  if (typeof d !== 'string') assert.ok(d.edges.some((e) => e.from === 'media.edges' && e.to === 'p.by'));
});
