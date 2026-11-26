import { definePiece, hexToOklab, type Palette } from '../../../api/index.ts';

/** '#a #b, #c' -> OKLab stops (bad entries skipped; grey if none). */
export function swatch(text: string): [number, number, number][] {
  const stops = text.split(/[\s,]+/).map(hexToOklab).filter((x): x is [number, number, number] => x !== null).slice(0, 8);
  return stops.length ? stops : [[0.6, 0, 0], [0.85, 0, 0]];
}

export default definePiece({
  cpu: ({ params, audio, time }) => {
    const stops = swatch(String(params.colors)), n = stops.length;
    // rotate by a whole number of stops (cycle per bar, pads' palette step), so the colours stay the swatch's own
    const bars = (time * audio.bpm) / 60 / 4;
    const k = Math.floor(bars * (params.cycle as number)) + (params.pads ? Math.floor(audio.pal * n) : 0);
    const out: Palette = { stops: stops.map((_, i) => stops[(((i + k) % n) + n) % n]) };
    return { palette: out };
  },
});
