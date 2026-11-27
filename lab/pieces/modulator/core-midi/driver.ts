import { definePiece } from '../../../api/index.ts';

export default definePiece({
  cpu: ({ audio, past, params: P }) => {
    const lo = P.lo as number, hi = Math.max(lo, P.hi as number), span = Math.min(600, Math.round((P.hold as number) * 60));
    let pitch = 0, vel = 0;
    for (let i = 0; i <= span; i++) {
      const a = i ? past(i) : audio;
      if (a.note >= lo && a.note <= hi) { pitch = hi > lo ? (a.note - lo) / (hi - lo) : 1; vel = a.vel; break; }
    }
    return {
      cc0: audio.cc[0], cc1: audio.cc[1], cc2: audio.cc[2], cc3: audio.cc[3],
      note: audio.note >= lo && audio.note <= hi ? 1 : 0, pitch, vel, cue: audio.cue / 9,
    };
  },
});
