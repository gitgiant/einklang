import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LAST_KEY, noAudioText, pickOf, readLast, restorePlan, resumeText, saveLast, shareOptions } from '../src/web/lastshare.ts';
import { openShare } from '../src/web/capture.ts';

const store = () => {
  const m = new Map<string, string>();
  return { m, get: (k: string) => m.get(k) ?? null, set: (k: string, v: string) => { m.set(k, v); } };
};
const vt = (label: string, displaySurface?: string) => ({ label, getSettings: () => ({ displaySurface }) });

test('the last pick: Chrome\'s id labels dropped, titles kept, round trip, junk ignored', () => {
  assert.deepEqual(pickOf(vt('window:1234:0', 'window')), { surface: 'window' });
  assert.deepEqual(pickOf(vt('screen:0:0', 'monitor')), { surface: 'monitor' });
  assert.deepEqual(pickOf(vt('web-contents-media-stream://12:3', 'browser')), { surface: 'browser' });
  assert.deepEqual(pickOf(vt('YouTube — Mozilla Firefox', 'window')), { surface: 'window', label: 'YouTube — Mozilla Firefox' });
  assert.deepEqual(pickOf(vt('x', 'application')), { label: 'x' }, 'unknown surface kinds are not hinted');
  assert.deepEqual(pickOf(undefined), {});
  const s = store();
  assert.equal(readLast(s.get), null);
  saveLast(s.set, { surface: 'window', label: 'Firefox' });
  assert.deepEqual(readLast(s.get), { surface: 'window', label: 'Firefox' });
  for (const junk of ['{', '42', '"window"', '{"surface":"desk"}', '{}']) { s.m.set(LAST_KEY, junk); assert.equal(readLast(s.get), null, junk); }
  s.m.set(LAST_KEY, '{"surface":"desk","label":"a"}');
  assert.deepEqual(readLast(s.get), { label: 'a' });
});

test('the resume button names the last pick and says the picker opens again', () => {
  const w = resumeText({ surface: 'window' }, true);
  assert.equal(w.text, 'resume external (sound + picture): pick the window again');
  assert.match(w.sub, /always asks.*opens on windows/);
  assert.equal(resumeText({ surface: 'browser', label: 'a'.repeat(60) }, false).text, `resume external sound: pick the tab "${'a'.repeat(39)}…" again`);
  assert.equal(resumeText(null, true).text, 'resume external (sound + picture): pick the tab / window / screen again');
  assert.doesNotMatch(resumeText(null, true).sub, / on /);
});

test('picker options: audio asked for everywhere, window audio, the last surface hinted', () => {
  const o = shareOptions({ surface: 'window' }) as Record<string, unknown>;
  assert.deepEqual(o.video, { displaySurface: 'window' });
  assert.equal((o.audio as Record<string, unknown>).suppressLocalAudioPlayback, false);
  assert.equal((o.audio as Record<string, unknown>).echoCancellation, false);
  assert.deepEqual([o.systemAudio, o.windowAudio, o.monitorTypeSurfaces, o.selfBrowserSurface], ['include', 'system', 'include', 'exclude']);
  assert.equal((shareOptions(null) as Record<string, unknown>).video, true);
  assert.match(noAudioText('window'), /Chrome 141.*Entire screen.*Share system audio.*tab/);
  assert.match(noAudioText(undefined), /no audio was shared/);
});

test('restore plan after a reload: external and a mic not yet allowed wait for one tap', () => {
  const s = { micGranted: false, filesOn: false, missing: 0, items: 0 };
  assert.deepEqual(restorePlan('external', 'demo', s), { do: 'offer', kind: 'external' });
  assert.deepEqual(restorePlan('external', 'off', { ...s, filesOn: true, missing: 2, items: 2 }), { do: 'offer', kind: 'external' }, 'the audio input wins over pictures');
  assert.deepEqual(restorePlan('mic', 'demo', s), { do: 'offer', kind: 'mic' });
  assert.deepEqual(restorePlan('mic', 'demo', { ...s, micGranted: true }), { do: 'open', kind: 'mic' });
  assert.deepEqual(restorePlan('file', 'off', { ...s, missing: 1, items: 3 }), { do: 'offer', kind: 'files' });
  assert.deepEqual(restorePlan('file', 'off', s), { do: 'none' });
  assert.deepEqual(restorePlan('off', 'off', s), { do: 'none' });
  assert.deepEqual(restorePlan('demo', 'demo', s), { do: 'none' });
});

test('openShare asks with the remembered surface and remembers a pick with sound only', async () => {
  const t = (kind: string, label = kind, displaySurface?: string) => ({ kind, label, stopped: 0, stop() { this.stopped++; }, getSettings: () => ({ displaySurface }) });
  type T = ReturnType<typeof t>;
  let next: T[] = [], asked: Record<string, unknown> | null = null;
  const fake = (tr: T[]) => ({ getTracks: () => tr, getAudioTracks: () => tr.filter((x) => x.kind === 'audio'), getVideoTracks: () => tr.filter((x) => x.kind === 'video') });
  const g = globalThis as unknown as Record<string, unknown>, had = Object.getOwnPropertyDescriptor(globalThis, 'navigator')!, s = store();
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { mediaDevices: { getDisplayMedia: async (o: Record<string, unknown>) => { asked = o; return fake(next); } } } });
  g.MediaStream = class { constructor(tr: T[]) { return fake(tr); } };
  g.localStorage = { getItem: s.get, setItem: s.set };
  try {
    next = [t('audio', 'System audio'), t('video', 'window:1:0', 'window')];
    assert.equal((await openShare(true)).getTracks().length, 2);
    assert.equal(asked!.video, true);
    assert.deepEqual(readLast(s.get), { surface: 'window' });
    next = [t('audio'), t('video', 'Firefox', 'window')];
    assert.equal((await openShare(false)).getTracks().length, 1);
    assert.deepEqual(asked!.video, { displaySurface: 'window' }, 'the picker opens on the last surface');
    assert.equal(next[1].stopped, 1);
    next = [t('video', 'screen:0:0', 'monitor')];
    await assert.rejects(openShare(true), /Entire screen again/);
    assert.deepEqual(readLast(s.get), { surface: 'window', label: 'Firefox' }, 'a pick without sound is not remembered');
  } finally { Object.defineProperty(globalThis, 'navigator', had); delete g.MediaStream; delete g.localStorage; }
});
