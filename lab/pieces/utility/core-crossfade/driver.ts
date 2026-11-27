// Crossfade: `amount` walks across the connected inputs; between two of them they blend with `mode`.
// cpu() returns `use`, so only the one or two inputs in play render.
import { definePiece, mixPass } from '../../../api/index.ts';

const PORTS = ['in0', 'in1', 'in2', 'in3'];

export default definePiece({
  cpu: ({ params: P, wired }) => {
    const ins = PORTS.filter((p) => wired.includes(p)), n = ins.length;
    if (n < 2) return { use: ins, a: ins[0], b: ins[0], w: 0 };
    const x = Math.max(0, Math.min(1, P.amount as number)) * (n - 1), i = Math.min(n - 2, Math.floor(x)), f = x - i, snap = (P.snap as number) * (n - 1);
    if (f <= snap) return { use: [ins[i]], a: ins[i], b: ins[i], w: 0 };
    if (f >= 1 - snap) return { use: [ins[i + 1]], a: ins[i + 1], b: ins[i + 1], w: 0 };
    return { use: [ins[i], ins[i + 1]], a: ins[i], b: ins[i + 1], w: f };
  },
  gpu: (init) => {
    const mp = mixPass(init);
    return {
      frame({ enc, in: ins, out, cpu, params }) {
        mp.draw(enc, out.out, ins[cpu.a as string] as GPUTexture | undefined, ins[cpu.b as string] as GPUTexture | undefined, (cpu.w as number) ?? 0, params.mode as number);
      },
      dispose: () => mp.dispose(),
    };
  },
});
