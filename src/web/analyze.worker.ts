// Whole-track feature analysis off the main thread, so preparing the next track doesn't hitch
// the render loop. In: decoded channels + sample rate. Out: the [2][u32 frames][...] message.
import { Analyzer, N } from '../core/analysis.ts';
import { FPS, STRIDE } from '../core/constants.ts';

export interface AnalyzeIn { id: number; rate: number; channels: Float32Array[] }
export type AnalyzeOut = { id: number; progress: number } | { id: number; out: Uint8Array<ArrayBuffer> };

self.onmessage = (e: MessageEvent<AnalyzeIn>) => {
  const { id, rate, channels } = e.data, n = channels[0].length;
  const mono = new Float32Array(n);
  for (const d of channels) for (let i = 0; i < n; i++) mono[i] += d[i] / channels.length;
  const an = new Analyzer(rate), nf = Math.ceil((n / rate) * FPS);
  const out = new Uint8Array(5 + nf * STRIDE), td = new Float32Array(N);
  out[0] = 2; new DataView(out.buffer).setUint32(1, nf, true);
  for (let fr = 0; fr < nf; fr++) {
    const c = Math.round((fr * rate) / FPS) - N / 2;
    for (let i = 0; i < N; i++) { const s = c + i; td[i] = s >= 0 && s < n ? mono[s] : 0; }
    out.set(an.frame(td), 5 + fr * STRIDE);
    if (fr % 1200 === 0) postMessage({ id, progress: fr / nf } satisfies AnalyzeOut);
  }
  postMessage({ id, out } satisfies AnalyzeOut, { transfer: [out.buffer] });
};
