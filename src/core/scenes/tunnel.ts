// Tunnel/warp: closed-form depth rush. The shader draws a ring every RING units of depth and
// each onset adds a smooth lurch of exactly 2 rings. Because the lurch is a whole number of
// rings, an onset falling out of the lookback window leaves `z mod RING` unchanged: no jump.
import { NB, K_ONSET, LOOKBACK } from '../constants.ts';
import { derive } from '../features.ts';
import { isin } from '../math.ts';
import type { SceneDef } from '../scene.ts';

export const RING = 4096;
const RUSH_T = 45, RUSH = 2 * RING;

/** u layout: [z, twist, hue, E, bass, lastOnsetAge, rush 0..255, 0, S[0..15]] */
export const TUNNEL_U = 8 + NB;

export const tunnel: SceneDef = {
  id: 'tunnel',
  name: 'Tunnel / warp',
  state(f, F) {
    const { S, E, bass, onsets, lastOnsetAge } = derive(F, f);
    let z = (((f % 16384) + 16384) % 16384) * 64; // period 16384 * 64 = 256 rings
    let rush = 0;
    for (let i = 0; i < LOOKBACK; i++) {
      if (!F.get(f - i, K_ONSET)) continue;
      const t = Math.min(i, RUSH_T); // smoothstep 0..RUSH over RUSH_T ticks
      z += ((RUSH * t * t * (3 * RUSH_T - 2 * t)) / (RUSH_T * RUSH_T * RUSH_T)) | 0;
      if (i < RUSH_T) rush = Math.max(rush, 255 - (((i * 255) / RUSH_T) | 0));
    }
    z &= 0x3fffffff;
    const twist = (f * 5 + (isin(f * 7) >> 6)) & 4095;
    const hue = f * 2 + onsets * 96;
    const u = new Int32Array(TUNNEL_U);
    u.set([z, twist, hue, E, bass, lastOnsetAge, rush, 0]);
    u.set(S, 8);
    return { u, prims: null };
  },
};
