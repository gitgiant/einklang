import { definePiece, BAR_TICKS, TICKS_PER_BEAT, gridStart, smooth01 } from '../../../api/index.ts';
import { SONG_SECTIONS, energyAt, sectionAt } from '../../../../src/core/songform.ts';

export default definePiece({
  cpu: ({ tick, sub, raw, params: P }) => {
    const unit = (P.bars as number) * BAR_TICKS, b = gridStart(tick, unit);
    const cur = sectionAt(raw, b), prev = sectionAt(raw, b - unit), fade = (P.fade as number) * TICKS_PER_BEAT;
    const r = prev === cur || fade <= 0 ? 1 : smooth01((tick - b + sub / 256) / fade);
    const level = (k: number) => (k === cur ? r : 0) + (k === prev && prev !== cur ? 1 - r : 0);
    const o: Record<string, number> = { section: (prev * (1 - r) + cur * r) / 3, energy: energyAt(raw, tick), change: tick === b && prev !== cur ? 1 : 0 };
    SONG_SECTIONS.forEach((n, k) => { o[n] = level(k); });
    return o;
  },
});
