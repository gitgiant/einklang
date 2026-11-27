import { definePiece } from '../../../api/index.ts';

const FPS = 60, MAX = 600;

export default definePiece({
  cpu: ({ past, sub, tick, inputAt, wired, params: P }) => {
    const A = (P.attack as number) * FPS, D = (P.decay as number) * FPS, S = P.sustain as number;
    const Hd = (P.hold as number) * FPS, R = (P.release as number) * FPS, c = P.curve as number, src = P.source as number;
    const span = Math.min(MAX, Math.ceil(A + D + Hd + R) + 1);
    // the last firing within the envelope's span
    let ago = -1, amp = 1;
    for (let i = 0; i <= span && ago < 0; i++) {
      if (src === 0 && past(i).onset) ago = i;
      else if (src === 1) { const a = past(i); if (a.note >= 0) { ago = i; amp = P.velocity ? a.vel : 1; } }
      else if (src === 2 && wired.includes('trigger') && Number(inputAt('trigger', tick - i)) > 0) ago = i;
    }
    if (ago < 0) return { out: 0 };
    const t = ago + sub / 256, fall = (x: number) => 1 - (1 - Math.pow(1 - Math.min(1, x), c));
    let v: number;
    if (t < A) v = t / A;
    else if (t < A + D) v = S + (1 - S) * fall((t - A) / D);
    else if (t < A + D + Hd) v = S;
    else v = S * fall((t - A - D - Hd) / R);
    return { out: Math.max(0, Math.min(1, v * amp)) };
  },
});
