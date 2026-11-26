import { definePiece } from '../../../api/index.ts';

const avg = (b: Float32Array, lo: number, hi: number) => { let s = 0; for (let i = lo; i < hi; i++) s += b[i]; return s / (hi - lo); };

export default definePiece({
  cpu: ({ audio, wave }) => ({
    bass: avg(audio.bands, 0, 3), mid: avg(audio.bands, 3, 9), high: avg(audio.bands, 9, 16), rms: audio.rms,
    phase: audio.phase, onset: audio.onset ? 1 : 0, spectrum: audio.bands, wave: wave(),
  }),
});
