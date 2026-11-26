// Radial spectrum: port of the prototype scene. Stateless, 600 ticks of lookback. Motion (rotation,
// ring/burst ages, the scrolling strip) is closed-form in f + sub/256; at sub = 0 it's the integer state.
import { W, H, K_RMS, K_ONSET, K_NOTE, K_BPM, K_PHASE } from '../constants.ts';
import { derive } from '../features.ts';
import { icos, isin, h32, hsv, clamp } from '../math.ts';
import { PrimList, OP_CLEAR, OP_CIRCLE, OP_RING, OP_LINE } from '../prims.ts';
import type { SceneDef } from '../scene.ts';

export const radial: SceneDef = {
  id: 'radial',
  name: 'Radial spectrum',
  state(f, F, sub = 0) {
    const L = new PrimList(1024);
    const cx = W >> 1, cy = H >> 1;
    const { S, E, bass, onsets, hueOff } = derive(F, f);
    const ff = f + sub / 256; // display time; == f for the hashed state
    const hue = Math.floor(ff * 2) + onsets * 96 + hueOff;

    L.push(OP_CLEAR, 0, 0, 0, 0, hsv(hue + 768, 200, 10 + (E >> 4)), 255, 0);

    // 64 spokes, mirrored band map, constant rotation
    const rot = Math.floor(ff * 3) & 4095, r0 = 90 + (bass >> 2);
    for (let i = 0; i < 64; i++) {
      const b = (i < 32 ? i : 63 - i) >> 1, a = (rot + i * 64) & 4095, s = S[b];
      const r1 = r0 + 20 + (((s * 220) / 255) | 0);
      L.push(OP_LINE,
        cx + ((icos(a) * r0) >> 15), cy + ((isin(a) * r0) >> 15),
        cx + ((icos(a) * r1) >> 15), cy + ((isin(a) * r1) >> 15),
        hsv(hue + b * 48, 220, 255), clamp(110 + (s >> 1), 0, 255), 3 + (s >> 5));
    }

    // onset pulse rings + particle bursts (closed-form in age, no sim state)
    for (let g = f - 90; g <= f; g++) {
      if (!F.get(g, K_ONSET)) continue;
      const age = f - g, ageF = age + sub / 256;
      if (age < 40) L.push(OP_RING, cx, cy, r0 + Math.floor(ageF * 12), 0, hsv(hue + 256, 120, 255), 255 - Math.floor(ageF * 6), 4);
      const gb = (F.get(g, 0) + F.get(g, 1)) >> 1;
      const n = 8 + (F.get(g, K_RMS) >> 4);
      // a MIDI note aims its burst: pitch class -> direction and color, octave -> speed
      const note = F.get(g, K_NOTE) - 1, pc = note % 12, oct = (note / 12) | 0;
      for (let j = 0; j < n; j++) {
        const hh = h32(g, j), a = note < 0 ? hh & 4095 : (((pc * 4096) / 12) | 0) + ((hh & 511) - 256);
        const dist = 100 + Math.floor((2 + ((hh >>> 12) & 7) + (note < 0 ? gb >> 6 : oct >> 1)) * ageF);
        L.push(OP_CIRCLE, cx + ((icos(a) * dist) >> 15), cy + ((isin(a) * dist) >> 15), 2 + ((hh >>> 20) & 3), 0,
          hsv(note < 0 ? hue + ((hh >>> 24) & 255) : pc * 128 + ((hh >>> 24) & 63), 160, 255), Math.max(0, 255 - Math.floor((ageF * 255) / 90)), 0);
      }
    }

    // MIDI clock: the core thumps on every beat
    const thump = F.get(f, K_BPM) ? (255 - F.get(f, K_PHASE)) >> 3 : 0;
    L.push(OP_CIRCLE, cx, cy, 40 + ((E / 3) | 0) + thump, 0, hsv(hue, 180, 60 + (E >> 1)), 255, 0);

    // rms history strip, scrolling 10 px per tick
    const shift = Math.floor((sub * 10) / 256);
    let px = -shift, py = H - 20 - (((F.get(f - 127, K_RMS) * 80) / 255) | 0);
    for (let i = 1; i < 128; i++) {
      const x = i * 10 - shift, y = H - 20 - (((F.get(f - 127 + i, K_RMS) * 80) / 255) | 0);
      L.push(OP_LINE, px, py, x, y, hsv(hue + 512, 140, 220), 180, 2);
      px = x; py = y;
    }
    return { u: Int32Array.of(f, hue), prims: L.done() };
  },
};
