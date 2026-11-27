import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Playlist, hashBytes, imageSeconds, quickHash, sameFile, slotKey, videoSync, type ItemKind } from '../src/web/playlist.ts';

const f = (path: string, kind: ItemKind, size = 100) => ({ name: path.split('/').pop()!, path, kind, size, file: path });
const names = (p: Playlist<string>, ids: (number | null)[]) => ids.map((id) => (id === null ? null : p.get(id)!.name));
/** The play order as "track+pics" strings. */
const show = (p: Playlist<string>) => p.playOrder().map((s) => [s.track === null ? '-' : p.get(s.track)!.name, ...names(p, s.pics)].join('+'));
/** A seeded rand for repeatable shuffles. */
const seeded = (seed: number) => () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);

test('playlist: images go with the next track; trailing images are slots of their own', () => {
  const p = new Playlist<string>();
  p.add([f('a.jpg', 'image'), f('b.mp3', 'audio'), f('c.png', 'image'), f('d.png', 'image'), f('e.mp4', 'video'), f('f.mp3', 'audio'), f('g.jpg', 'image'), f('h.jpg', 'image')]);
  assert.deepEqual(show(p), ['b.mp3+a.jpg', 'e.mp4+c.png+d.png', 'f.mp3', '-+g.jpg', '-+h.jpg']);
  assert.equal(p.hasTracks, true); assert.equal(p.picturesOnly, false);
});

test('playlist: added files come in natural path order, after what is there', () => {
  const p = new Playlist<string>();
  p.add([f('x/10 ten.mp3', 'audio'), f('x/2 two.mp3', 'audio'), f('x/1 one.mp3', 'audio')]);
  p.add([f('a.mp3', 'audio')]);
  assert.deepEqual(show(p), ['1 one.mp3', '2 two.mp3', '10 ten.mp3', 'a.mp3']);
});

test('playlist: next / prev walk the order; manual steps wrap, auto-advance follows repeat', () => {
  const p = new Playlist<string>();
  p.add([f('1.mp3', 'audio'), f('2.mp3', 'audio'), f('3.mp3', 'audio')]);
  const at = () => p.get(p.current()!.track!)!.name;
  p.start(); assert.equal(at(), '1.mp3');
  p.next(true); assert.equal(at(), '2.mp3');
  p.prev(); p.prev(); assert.equal(at(), '3.mp3', 'prev wraps');
  p.next(); assert.equal(at(), '1.mp3', 'manual next wraps');
  p.setRepeat('one'); p.next(true); assert.equal(at(), '1.mp3', 'repeat one stays on auto');
  p.next(); assert.equal(at(), '2.mp3', 'but a manual next moves on');
  p.setRepeat('off'); p.next(true); assert.equal(at(), '3.mp3');
  assert.equal(p.next(true), null, 'repeat off stops at the end'); assert.equal(at(), '3.mp3');
  p.setRepeat('all'); p.next(true); assert.equal(at(), '1.mp3', 'repeat all wraps');
});

test('playlist: shuffle plays every slot once per round, the current first, never the same twice in a row', () => {
  const p = new Playlist<string>(); p.rand = seeded(7);
  p.add(['1', '2', '3', '4', '5', '6'].map((n) => f(`${n}.mp3`, 'audio')));
  p.start(); p.next(); // on 2
  p.setShuffle(true);
  const first = p.playOrder().map(slotKey);
  assert.equal(first[0], p.cur, 'the current slot leads the shuffled order');
  assert.deepEqual([...first].sort(), p.slots().map(slotKey).sort());
  assert.notDeepEqual(first, p.slots().map(slotKey), 'actually shuffled (with this seed)');
  const seen = [p.cur!];
  for (let i = 0; i < 5; i++) seen.push(slotKey(p.next(true)!));
  assert.equal(new Set(seen).size, 6, 'a round plays each once');
  const last = p.cur;
  p.next(true);
  assert.notEqual(p.cur, last, 'a reshuffled round does not start with the slot that just ended');
  p.setShuffle(false);
  assert.deepEqual(p.playOrder().map(slotKey), p.slots().map(slotKey));
});

test('playlist: files added while shuffled land after the current slot', () => {
  const p = new Playlist<string>(); p.rand = seeded(3);
  p.add(['1', '2', '3'].map((n) => f(`${n}.mp3`, 'audio')));
  p.setShuffle(true); p.start();
  const cur = p.cur!;
  p.add([f('4.mp3', 'audio'), f('5.mp3', 'audio')]);
  const order = p.playOrder().map(slotKey);
  assert.equal(order.length, 5);
  assert.ok(order.indexOf(p.items[3].id) > order.indexOf(cur) && order.indexOf(p.items[4].id) > order.indexOf(cur));
});

test('playlist: reorder and remove keep the current slot; removing it reports so', () => {
  const p = new Playlist<string>();
  const [a, b, c] = p.add([f('a.mp3', 'audio'), f('b.mp3', 'audio'), f('c.mp3', 'audio')]);
  p.jump(b);
  p.move(c, 0);
  assert.deepEqual(show(p), ['c.mp3', 'a.mp3', 'b.mp3']);
  assert.equal(p.current()!.track, b);
  assert.equal(p.remove(a), false);
  assert.equal(p.remove(b), true);
  assert.equal(p.current(), null);
  assert.equal(p.next()!.track, c);
  p.clear();
  assert.equal(p.items.length, 0); assert.equal(p.current(), null);
});

test('playlist: moving an image before a track joins it to that track; the current image follows', () => {
  const p = new Playlist<string>();
  const [t, i] = p.add([f('1.mp3', 'audio'), f('2.jpg', 'image')]);
  p.jump(i);
  assert.equal(p.current()!.track, null);
  p.move(i, 0);
  assert.deepEqual(show(p), ['1.mp3+2.jpg']);
  assert.equal(p.current()!.track, t, 'the image now belongs to the track: that slot is current');
});

test('playlist: pictures are the slot images (a video first), else the nearest earlier ones', () => {
  const p = new Playlist<string>();
  const [img, a1, a2, v, img2, a3] = p.add([f('1.jpg', 'image'), f('2.mp3', 'audio'), f('3.mp3', 'audio'), f('4.mp4', 'video'), f('5.jpg', 'image'), f('6.mp3', 'audio')]);
  const pics = (track: number) => p.pictures(p.slots().find((s) => s.track === track)!);
  assert.deepEqual(pics(a1), [img]);
  assert.deepEqual(pics(a2), [img], 'a track without images keeps the ones before');
  assert.deepEqual(pics(v), [v], 'a video shows itself');
  assert.deepEqual(pics(a3), [img2]);
  void a3;
});

test('playlist: images only step alone; a silent video counts as an image', () => {
  const p = new Playlist<string>();
  const [, , v] = p.add([f('1.jpg', 'image'), f('2.jpg', 'image'), f('3.mp4', 'video')]);
  assert.deepEqual(show(p), ['3.mp4+1.jpg+2.jpg']);
  p.markSilent(v);
  assert.equal(p.picturesOnly, true);
  assert.deepEqual(show(p), ['-+1.jpg', '-+2.jpg', '-+3.mp4']);
  p.setImageBars(4);
  assert.equal(imageSeconds(p.imageBars, 28), (4 * 4 * 28) / 60);
  assert.equal(imageSeconds(8, 28), 14.933333333333334, '8 bars at the default 128.6 bpm grid');
});

test('playlist: save / restore keeps order and settings; re-added files fill the gaps by path + size', () => {
  const p = new Playlist<string>(); p.rand = seeded(1);
  p.add([f('a/1.mp3', 'audio', 10), f('a/2.jpg', 'image', 20), f('a/3.mp4', 'video', 30), f('a/4.mp3', 'audio', 40)]);
  p.setRepeat('one'); p.setImageBars(2); p.jump(p.items[2].id);
  const saved = JSON.parse(JSON.stringify(p.save()));
  const q = Playlist.restore<string>(saved);
  assert.deepEqual(q.items.map((e) => [e.path, e.file]), [['a/1.mp3', null], ['a/2.jpg', null], ['a/3.mp4', null], ['a/4.mp3', null]]);
  assert.equal(q.repeat, 'one'); assert.equal(q.imageBars, 2);
  assert.equal(q.get(q.current()!.track!)!.path, 'a/3.mp4', 'the current slot comes back');
  assert.equal(q.missing, 4);
  assert.equal(q.start()?.track, undefined, 'nothing is playable without files');
  q.add([f('a/3.mp4', 'video', 30), f('a/4.mp3', 'audio', 999), f('a/1.mp3', 'audio', 10)]);
  assert.deepEqual(q.items.map((e) => [e.path, e.file !== null]), [['a/1.mp3', true], ['a/2.jpg', false], ['a/3.mp4', true], ['a/4.mp3', false], ['a/4.mp3', true]], 'a size mismatch is a new file');
  assert.equal(q.playable(q.current()!), true, 'a slot plays once its track is back (its images may still be missing)');
  q.next();
  assert.equal(q.get(q.current()!.track!)!.size, 999, 'the entry without a file is skipped');
  assert.equal(Playlist.restore(null).items.length, 0);
  assert.equal(Playlist.restore({ v: 1, items: [{ name: 1 }, { name: 'x', path: 'x', kind: 'audio', size: 1 }] }).items.length, 1);
});

test('playlist: quick hash of a file\'s ends; same file means same name, size and hash', async () => {
  const big = new Uint8Array(300_000).map((_, i) => (i * 7) & 255), other = big.slice(); other[150_000] ^= 1; const tail = big.slice(); tail[299_999] ^= 1;
  const file = (b: Uint8Array) => ({ size: b.length, slice: (s: number, e?: number) => ({ arrayBuffer: async () => b.slice(s, e).buffer }) });
  const h = await quickHash(file(big));
  assert.equal(h, await quickHash(file(other)), 'the middle is not read');
  assert.notEqual(h, await quickHash(file(tail)));
  assert.notEqual(h, await quickHash(file(big.slice(0, 1000))));
  assert.equal(hashBytes(new Uint8Array([1, 2, 3])), hashBytes(new Uint8Array([1, 2, 3])));
  assert.equal(sameFile({ name: 'a', size: 1, hash: h }, { name: 'a', size: 1, hash: h }), true);
  assert.equal(sameFile({ name: 'a', size: 1, hash: h }, { name: 'b', size: 1, hash: h }), false);
});

test('playlist: video sync seeks past 0.5 s, nudges the rate below', () => {
  assert.deepEqual(videoSync(10, 10.6), { seek: 10, rate: 1 });
  assert.deepEqual(videoSync(10, 10.01), { seek: null, rate: 1 });
  const behind = videoSync(10, 9.8), ahead = videoSync(10, 10.2);
  assert.equal(behind.seek, null); assert.ok(behind.rate > 1 && behind.rate <= 1.05);
  assert.ok(ahead.rate < 1 && ahead.rate >= 0.95);
});
