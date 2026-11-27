import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MediaHost, capSize, shareItem, type MediaItem } from '../src/web/media.ts';
import { bindStream } from '../src/web/sharevideo.ts';
import { openShare } from '../src/web/capture.ts';

function track(kind: 'audio' | 'video') {
  const t = { kind, label: kind, stopped: 0, onended: null as (() => void) | null, stop: () => { t.stopped++; }, end: () => t.onended?.() };
  return t;
}
type Track = ReturnType<typeof track>;
const stream = (...tracks: Track[]) => ({
  getTracks: () => tracks, getAudioTracks: () => tracks.filter((t) => t.kind === 'audio'), getVideoTracks: () => tracks.filter((t) => t.kind === 'video'),
}) as unknown as MediaStream;

function fakeDevice() {
  const log = { destroyed: 0, sources: [] as unknown[], scaled: 0, pipelines: 0 };
  const pass = { setPipeline: () => {}, setBindGroup: () => {}, draw: () => {}, end: () => {} };
  const device = {
    createTexture: () => ({ destroy: () => { log.destroyed++; }, createView: () => ({}) }),
    createShaderModule: () => ({}), createSampler: () => ({}), createBindGroup: () => ({}),
    createRenderPipeline: () => { log.pipelines++; return { getBindGroupLayout: () => ({}) }; },
    importExternalTexture: () => ({}),
    createCommandEncoder: () => ({ beginRenderPass: () => pass, finish: () => ({}) }),
    queue: { copyExternalImageToTexture: (s: { source: unknown }) => { log.sources.push(s.source); }, submit: () => { log.scaled++; } },
  } as unknown as GPUDevice;
  return { device, log };
}
function item(name: string, w = 64): MediaItem & { stopped: number } {
  const it = { kind: 'video' as const, name, source: {} as ImageBitmap, mirror: false, gen: 0, stopped: 0, size: (): [number, number] => [w, 32], ready: () => true, stop: () => { it.stopped++; } };
  return it;
}
/** A host with one picked picture, and the share items bindStream opens on it. */
function setup() {
  const host = new MediaHost(), { device, log } = fakeDevice(), picked = item('picked', 10), opened: (MediaItem & { stopped: number })[] = [];
  host.set([picked]);
  const open = (t: MediaStreamTrack) => { const it = item('share', 20), stop = it.stop; it.stop = () => { stop(); t.stop(); }; opened.push(it); return it; };
  const input = host.input(device), width = () => input.frame(0)?.width;
  return { host, log, picked, opened, open, input, width };
}

test('a shared video replaces the picked media, which comes back on close', () => {
  const { host, log, picked, opened, open, input, width } = setup(), a = track('audio'), v = track('video');
  assert.equal(width(), 10);
  const close = bindStream(stream(a, v), () => assert.fail('closing is not ending'), host, open);
  assert.deepEqual([input.count(), width()], [1, 20]);
  close(); close();
  assert.deepEqual([a.stopped >= 1, v.stopped >= 1, opened[0].stopped, picked.stopped, log.destroyed], [true, true, 1, 0, 1]);
  assert.equal(width(), 10);
});

test('either track ending closes the whole share and reports it once', () => {
  for (const first of [0, 1]) {
    const { host, open, width } = setup(), tracks = [track('audio'), track('video')];
    let ended = 0;
    const close = bindStream(stream(...tracks), () => ended++, host, open);
    const handlers = tracks.map((t) => t.onended!);
    handlers[first](); handlers[1 - first](); // "Stop sharing" ends both
    assert.equal(ended, 1);
    assert.ok(tracks.every((t) => t.stopped >= 1 && t.onended === null), 'no leaked tracks');
    assert.equal(width(), 10);
    close();
  }
});

test('audio only: the picked media stays; media picked during a share shows after it', () => {
  const { host, open, input, width, opened } = setup();
  bindStream(stream(track('audio')), () => {}, host, open)();
  assert.deepEqual([opened.length, width()], [0, 10]);
  const close = bindStream(stream(track('audio'), track('video')), () => {}, host, open);
  const later = item('later', 30);
  host.set([later, item('other')]);
  assert.deepEqual([input.count(), width(), opened[0].stopped], [1, 20, 0]);
  host.clear();
  assert.equal(width(), 20, '"no media" leaves the share');
  host.set([later]);
  close();
  assert.equal(width(), 30);
  host.clear();
  assert.equal(input.frame(0), null, 'nothing picked: the fallback');
});

test('overlapping shares: the newest shows, closing an older one leaves it', () => {
  const { host, open, width, opened } = setup();
  const first = bindStream(stream(track('audio'), track('video')), () => {}, host, open);
  const second = bindStream(stream(track('audio'), track('video')), () => {}, host, open);
  first();
  assert.deepEqual([opened[0].stopped, opened[1].stopped, width()], [1, 0, 20]);
  second();
  assert.equal(width(), 10);
});

test('openShare keeps the video track only when asked, and stops everything without audio', async () => {
  let next: Track[] = [];
  const had = Object.getOwnPropertyDescriptor(globalThis, 'navigator')!, g = globalThis as unknown as { MediaStream?: unknown };
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { mediaDevices: { getDisplayMedia: async () => stream(...next) } } });
  g.MediaStream = class { constructor(t: Track[]) { return stream(...t); } };
  try {
    next = [track('audio'), track('video')];
    assert.equal((await openShare(false)).getTracks().length, 1);
    assert.equal(next[1].stopped, 1);
    next = [track('audio'), track('video')];
    assert.equal((await openShare(true)).getTracks().length, 2);
    assert.equal(next[1].stopped, 0);
    next = [track('video')];
    await assert.rejects(openShare(true), /no audio was shared/);
    assert.equal(next[0].stopped, 1);
  } finally { Object.defineProperty(globalThis, 'navigator', had); delete g.MediaStream; }
});

test('share frames larger than the render target are scaled down before the upload, once per new frame', () => {
  assert.deepEqual(capSize(3840, 2160, 1920, 1080), [1920, 1080]);
  assert.deepEqual(capSize(3440, 1440, 1920, 1080), [2580, 1080], 'still covers the target');
  assert.deepEqual(capSize(1280, 720, 1920, 1080), [1280, 720], 'never up');
  assert.deepEqual(capSize(0, 0, 1920, 1080), [0, 0]);

  let frameCb: (() => void) | null = null, removed = 0;
  const video = { style: {}, videoWidth: 3840, videoHeight: 2160, readyState: 4, paused: false, srcObject: null as unknown, setAttribute: () => {}, play: () => Promise.resolve(), pause: () => {}, remove: () => { removed++; }, requestVideoFrameCallback: (f: () => void) => { frameCb = f; } };
  const g = globalThis as unknown as Record<string, unknown>;
  g.document = { createElement: () => video, body: { append: () => {} } };
  g.MediaStream = class {};
  try {
    const t = track('video'), host = new MediaHost(), { device, log } = fakeDevice();
    const release = host.share(shareItem(t as unknown as MediaStreamTrack, () => [1920, 1080]));
    const f = host.frame(device, 0)!;
    host.frame(device, 0);
    assert.deepEqual([f.width, f.height, f.mirror, log.scaled, log.sources.length], [1920, 1080, false, 1, 0]);
    assert.match(host.shareLine()!, /^shared video 3840x2160 → 1920x1080, upload \d+\.\d\d ms/);
    frameCb!(); host.frame(device, 0);
    assert.deepEqual([log.scaled, log.pipelines], [2, 1]);
    // a small share is copied straight from the video
    video.videoWidth = 1280; video.videoHeight = 720; frameCb!(); host.frame(device, 0);
    assert.deepEqual([log.scaled, log.sources], [2, [video]]);
    release();
    assert.deepEqual([t.stopped, removed, video.srcObject, host.shareLine()], [1, 1, null, null]);
  } finally { delete g.document; delete g.MediaStream; }
});
