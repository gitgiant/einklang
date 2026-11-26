import { definePiece, oklch, type Palette } from '../../../api/index.ts';

/** Hue offsets (turns) per scheme. */
const SCHEMES = [[0, 0, 0], [-1 / 12, 0, 1 / 12], [0, 0.5, 0], [0, 5 / 12, 7 / 12], [0, 1 / 3, 2 / 3], [0, 0.25, 0.5, 0.75]];

export default definePiece({
  cpu: ({ params, audio }) => {
    const base = (params.hue as number) + (params.pads ? audio.pal : 0), off = SCHEMES[params.scheme as number];
    const L = params.light as number, C = params.chroma as number, k = params.contrast as number, n = 5;
    const stops: Palette['stops'] = [];
    for (let i = 0; i < n; i++) {
      const t = i / (n - 1), h = base + off[Math.min(off.length - 1, Math.floor(t * off.length))];
      stops.push(oklch(Math.max(0.05, Math.min(1, L - k / 2 + k * t)), C, h));
    }
    return { palette: { stops } satisfies Palette };
  },
});
