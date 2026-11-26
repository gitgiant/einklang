import { definePiece } from '../../../api/index.ts';

export default definePiece({
  cpu: ({ past, params }) => {
    const lo = params.lo as number, hi = Math.max(lo, params.hi as number), n = params.window as number;
    let s = 0, w = 0;
    for (let i = 0; i < n; i++) {
      const b = past(i).bands;
      let v = 0;
      for (let k = lo; k <= hi; k++) v += b[k];
      s += (v / (hi - lo + 1)) * (n - i); w += n - i;
    }
    return { out: Math.min(1, (s / w) * (params.gain as number)) };
  },
});
