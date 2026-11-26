import { definePiece, linearToOklab, type Palette } from '../../../api/index.ts';

/** Convert blackbody temperature in Kelvin (600..30000K) to linear sRGB. */
function kelvinToLinear(kelvin: number): [number, number, number] {
  const k = Math.max(600, Math.min(30000, kelvin));
  const t = k / 100;

  let r: number;
  let g: number;
  let b: number;

  if (t <= 66) {
    r = 1;
    g = t <= 1 ? 0 : (99.4708025861 * Math.log(t) - 161.1195681661) / 255;
    b = t <= 19 ? 0 : (138.5177312231 * Math.log(t - 10) - 305.0447927307) / 255;
  } else {
    r = (329.698727446 * Math.pow(t - 60, -0.1332047592)) / 255;
    g = (288.1221695283 * Math.pow(t - 60, -0.0755148492)) / 255;
    b = 1;
  }

  const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
  const srgbToLin = (c: number) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));

  // Physical ember rolloff below 2200K so low stops are deep smoldering red rather than flat bright red
  const ember = Math.max(0.06, Math.min(1, Math.pow((k - 500) / 2100, 1.45)));
  return [
    srgbToLin(clamp01(r)) * ember,
    srgbToLin(clamp01(g)) * ember,
    srgbToLin(clamp01(b)) * ember,
  ];
}

export default definePiece({
  cpu: ({ params, in: ins, audio }) => {
    const bass = (audio.bands[0] + audio.bands[1] + audio.bands[2]) / 3;
    const autoEnergy = Math.min(1, audio.rms * 0.75 + bass * 0.55);
    const sig = typeof ins.energy === 'number' ? ins.energy : autoEnergy;
    const drive = Math.max(0, Math.min(1.5, sig + (params.offset as number)));

    const minK = params.min_k as number;
    const maxK = Math.max(minK + 300, params.max_k as number);
    const heat = params.heat as number;
    const gamma = params.gamma as number;
    const bright = params.bright as number;

    // Hotter with energy: raises the top of the range strongly and lifts the ember floor slightly
    const loK = minK + heat * drive * 0.14;
    const hiK = maxK + heat * drive;

    const n = 8;
    const stops: Palette['stops'] = [];
    for (let i = 0; i < n; i++) {
      const u = Math.pow(i / (n - 1), gamma);
      const k = loK + (hiK - loK) * u;
      const [lr, lg, lb] = kelvinToLinear(k);
      // Scale luminance gently toward the hot end
      const lum = bright * (0.28 + 0.72 * Math.pow(i / (n - 1), 0.7));
      stops.push(linearToOklab([
        Math.min(1.2, lr * lum),
        Math.min(1.2, lg * lum),
        Math.min(1.2, lb * lum),
      ]));
    }

    return { palette: { stops } satisfies Palette };
  },
});
