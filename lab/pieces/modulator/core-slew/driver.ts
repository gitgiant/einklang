import { definePiece } from '../../../api/index.ts';

const FPS = 60, SAMPLES = 32;
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

export default definePiece({
  cpu: ({ tick, in: ins, inputAt, params: P }) => {
    const T = (P.time as number) * FPS, release = P.mode === 1;
    const span = Math.min(600, Math.ceil(release ? T : 3 * T)), stride = Math.max(1, Math.ceil(span / SAMPLES));
    const now = num(ins.in);
    if (release) {
      let y = now;
      for (let i = stride; i <= span; i += stride) y = Math.max(y, num(inputAt('in', tick - i)) - i / T);
      return { out: y };
    }
    let s = now, w = 1;
    for (let i = stride; i <= span; i += stride) { const k = Math.exp(-i / T); s += num(inputAt('in', tick - i)) * k; w += k; }
    return { out: s / w };
  },
});
