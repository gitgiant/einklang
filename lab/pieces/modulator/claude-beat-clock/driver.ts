import { definePiece } from '../../../api/index.ts';

// Pure function of the tick: the integer beat count is estimated from time x bpm and snapped so its
// fraction is exactly the room's beat phase (seamless with the fixed grid and with a MIDI clock).
export default definePiece({
  cpu: ({ time, sub, audio, params }) => {
    const est = (time * audio.bpm) / 60;
    const n = Math.round(est - audio.phase);
    const beats = n + audio.phase + ((sub / 256) * audio.bpm) / 3600;
    const x = (beats * (params.rate as number)) % 1024;
    const f = beats - Math.floor(beats);
    return { out: Math.max(0, x) / 1024, kick: Math.exp(-f * (params.sharp as number)) };
  },
});
