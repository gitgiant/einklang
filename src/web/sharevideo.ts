// The lifetime of a captured stream (tab / system audio, maybe with its video): the video shows as
// this host's media for exactly as long as the audio is analyzed. Per host, never sent anywhere.
import { MEDIA, shareItem, type MediaItem } from './media.ts';

/**
 * Take over `stream`: show its video track (if kept) in place of the picked media. The returned
 * close() stops every track and brings the picked media back. When any track ends by itself ("Stop
 * sharing", the shared tab closed), the whole share closes and `ended` is called once.
 */
export function bindStream(stream: MediaStream, ended: () => void, host = MEDIA, open: (t: MediaStreamTrack) => MediaItem = shareItem): () => void {
  const video = stream.getVideoTracks()[0];
  const release = video ? host.share(open(video)) : () => {};
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    release();
    for (const t of stream.getTracks()) { t.onended = null; t.stop(); }
  };
  for (const t of stream.getTracks()) t.onended = () => { if (!closed) { close(); ended(); } };
  return close;
}
