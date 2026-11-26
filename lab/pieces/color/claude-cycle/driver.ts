import { definePiece, oklch, type Palette } from '../../../api/index.ts';

type Stop = Palette['stops'][number];
/** Used when no palette is connected. */
const WHEEL: Stop[] = Array.from({ length: 6 }, (_, i) => oklch(0.7, 0.16, i / 6));

export default definePiece({
  cpu: ({ params, in: ins, audio, time }) => {
    const src = (ins.palette as Palette | undefined)?.stops ?? WHEEL, n = src.length;
    // beats since the start, locked to the clock's own beat phase and (per bar) its downbeat
    const beat = Math.round((time * audio.bpm) / 60 - audio.phase);
    const perBar = params.every === 1;
    const count = perBar ? Math.round((beat - audio.bar) / 4) : beat;
    const into = perBar ? (audio.bar + audio.phase) / 4 : audio.phase;
    const stride = params.stride as number;
    // smooth: eased glide that arrives exactly on the next change
    const f = params.mode === 1 ? into * into * (3 - 2 * into) : 0;
    const lift = (params.flash as number) * Math.max(0, 1 - into * (perBar ? 12 : 3));
    const at = (i: number) => src[((i % n) + n) % n];
    const stops: Stop[] = src.map((_, i) => {
      const a = at(i + count * stride), b = at(i + (count + 1) * stride);
      return [Math.min(1, a[0] + (b[0] - a[0]) * f + lift), a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
    });
    if (params.loop && n < 8) stops.push(stops[0]);
    return { palette: { stops } satisfies Palette };
  },
});
