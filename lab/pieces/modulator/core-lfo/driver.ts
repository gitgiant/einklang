import { definePiece } from '../../../api/index.ts';

export default definePiece({
  cpu: ({ time, audio, params }) => {
    const x = (((time * audio.bpm) / 60 / (params.beats as number) + (params.offset as number)) % 1 + 1) % 1;
    const out = [0.5 - 0.5 * Math.cos(x * 2 * Math.PI), 1 - Math.abs(2 * x - 1), x, x < 0.5 ? 1 : 0][params.shape as number];
    return { out };
  },
});
