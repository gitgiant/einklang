import { definePiece } from '../../../api/index.ts';

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const c01 = (x: number) => Math.max(0, Math.min(1, x));

export default definePiece({
  cpu: ({ in: ins, params: P }) => {
    const a = num(ins.a), b = num(ins.b), k = P.amount as number, n = P.steps as number;
    const span = (P.in_hi as number) - (P.in_lo as number);
    let x: number;
    switch (P.op as number) {
      case 1: x = a * (1 - k) + b * k; break;
      case 2: x = a + b; break;
      case 3: x = a * b; break;
      case 4: x = Math.min(a, b); break;
      case 5: x = Math.max(a, b); break;
      case 6: x = 1 - a; break;
      case 7: x = a > k ? 1 : 0; break;
      case 8: x = Math.min(n - 1, Math.floor(c01(a) * n)) / (n - 1); break;
      default: x = span ? (a - (P.in_lo as number)) / span : 0;
    }
    const lo = P.lo as number, hi = P.hi as number;
    return { out: lo + c01(x) * (hi - lo) };
  },
});
