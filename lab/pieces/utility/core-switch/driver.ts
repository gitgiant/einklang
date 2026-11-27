// Switch: one input of several. cpu() samples `select` on the grid boundary (and the one before, for
// the fade), so the pick is a pure function of the tick and every host shows the same one; it returns
// `use` so the runtime renders only the inputs shown (unselected branches are skipped).
import { definePiece, mixPass, smooth01, gridStart, GRID_UNITS, TICKS_PER_BEAT } from '../../../api/index.ts';

const PORTS = ['in0', 'in1', 'in2', 'in3', 'in4', 'in5'];
const UNITS = Object.values(GRID_UNITS);

export default definePiece({
  cpu: ({ tick, sub, params: P, paramAt, wired }) => {
    const ins = PORTS.filter((p) => wired.includes(p)), n = ins.length;
    if (!n) return { use: [] };
    const pick = (v: unknown) => ins[((Math.round(Number(v)) % n) + n) % n];
    const unit = UNITS[P.quant as number] ?? 0;
    if (!unit) { const a = pick(P.select); return { use: [a], a, b: a, w: 0 }; }
    const b0 = gridStart(tick, unit), cur = pick(paramAt('select', b0)), prev = pick(paramAt('select', b0 - unit));
    const fade = Math.min(unit, (P.fade as number) * TICKS_PER_BEAT), dt = tick - b0 + sub / 256;
    if (prev !== cur && dt < fade) return { use: [prev, cur], a: prev, b: cur, w: smooth01(dt / fade) };
    return { use: [cur], a: cur, b: cur, w: 0 };
  },
  gpu: (init) => {
    const mp = mixPass(init);
    return {
      frame({ enc, in: ins, out, cpu, params }) {
        const a = ins[cpu.a as string] as GPUTexture | undefined, b = ins[cpu.b as string] as GPUTexture | undefined;
        mp.draw(enc, out.out, a, b, (cpu.w as number) ?? 0, params.mode as number);
      },
      dispose: () => mp.dispose(),
    };
  },
});
