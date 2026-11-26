import { definePiece, oklabToLinear, oklch, type Palette } from '../../../api/index.ts';

const MAX_STRINGS = 16;
const NODES = 48;
const SEGS_PER_STR = NODES - 1;
const MAX_SEGS = MAX_STRINGS * SEGS_PER_STR;
const SEG_FLOATS = 8; // p0.xy, p1.xy, col.rgb, inten

function samplePal(stops: [number, number, number][], x: number): [number, number, number] {
  const n = stops.length;
  if (n <= 1) return oklabToLinear(stops[0] ?? [0.75, -0.08, 0.12]).map((c) => Math.max(0, c)) as [number, number, number];
  const f = Math.min(1, Math.max(0, x)) * (n - 1);
  const i = Math.min(Math.floor(f), n - 1);
  const j = Math.min(i + 1, n - 1);
  const t = f - i;
  const a = stops[i], b = stops[j];
  const rgb = oklabToLinear([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]);
  return [Math.max(0, rgb[0]), Math.max(0, rgb[1]), Math.max(0, rgb[2])];
}

export default definePiece({
  gpu: ({ device, shader }) => {
    const mod = shader('strings.wgsl');
    // Uniforms: 4 vec4f + 8 vec4f palette = 12 vec4f = 192 bytes
    const ubuf = device.createBuffer({ label: 'agy-strings u', size: 192, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const dbuf = device.createBuffer({ label: 'agy-strings disp', size: MAX_STRINGS * NODES * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    const sbuf = device.createBuffer({ label: 'agy-strings segs', size: MAX_SEGS * SEG_FLOATS * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });

    const bgPipe = device.createRenderPipeline({
      label: 'agy-strings bg', layout: 'auto',
      vertex: { module: mod, entryPoint: 'vs_full' },
      fragment: { module: mod, entryPoint: 'fs_bg', targets: [{ format: 'rgba16float' }] },
    });
    const segPipe = device.createRenderPipeline({
      label: 'agy-strings seg', layout: 'auto',
      vertex: { module: mod, entryPoint: 'vs_seg' },
      fragment: {
        module: mod, entryPoint: 'fs_seg',
        targets: [{
          format: 'rgba16float',
          blend: {
            color: { srcFactor: 'one', dstFactor: 'one' },
            alpha: { srcFactor: 'one', dstFactor: 'one' },
          },
        }],
      },
    });

    const bgGroup = device.createBindGroup({
      layout: bgPipe.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: ubuf } },
        { binding: 1, resource: { buffer: dbuf } },
      ],
    });
    const segGroup = device.createBindGroup({
      layout: segPipe.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: ubuf } },
        { binding: 2, resource: { buffer: sbuf } },
      ],
    });

    const udata = new Float32Array(48);
    const sdata = new Float32Array(MAX_SEGS * SEG_FLOATS);
    // Wave equation state: current, previous, next displacement buffers
    const uCur = new Float32Array(MAX_STRINGS * NODES);
    const uPrv = new Float32Array(MAX_STRINGS * NODES);
    const uNxt = new Float32Array(MAX_STRINGS * NODES);
    const prevBand = new Float32Array(16);
    let lastTick = -1;

    const reset = () => {
      uCur.fill(0); uPrv.fill(0); uNxt.fill(0); prevBand.fill(0);
    };

    return {
      frame({ enc, out, in: ins, params, audio, tick, time, past, wave, width, height }) {
        const aspect = width / height;
        const numStr = Math.min(MAX_STRINGS, Math.max(4, Math.round(params.strings as number)));
        const tension = params.tension as number;
        const damping = params.damping as number;
        const pluck = params.pluck as number;
        const glow = params.glow as number;
        const harmonics = params.harmonics as number;

        if (lastTick < 0 || tick < lastTick || tick - lastTick > 12) reset();
        const steps = tick > lastTick ? Math.min(4, tick - lastTick) : (lastTick === tick ? 0 : 1);
        lastTick = tick;

        const w = (ins.wave as Float32Array | null | undefined) ?? wave();
        const stops = (ins.palette as Palette | undefined)?.stops
          ?? Array.from({ length: 6 }, (_, i) => oklch(0.74, 0.19, 0.25 + audio.pal + i * 0.1));

        // Step the coupled 1D damped wave equation (2 substeps per tick for crisp overtones & CFL stability)
        for (let st = 0; st < Math.max(steps, 0); st++) {
          const damp = Math.pow(damping, 0.5);
          for (let subStep = 0; subStep < 2; subStep++) {
            for (let s = 0; s < numStr; s++) {
              const row = s * NODES;
              const strFrac = numStr > 1 ? s / (numStr - 1) : 0.5;
              const bIdx = Math.min(15, Math.floor(strFrac * 15.99));
              const bVal = audio.bands[bIdx];
              const bRise = Math.max(0, bVal - prevBand[bIdx]);
              // CFL-safe wave speed squared (strictly <= 0.42)
              const c2 = 0.08 + 0.30 * tension * (0.35 + 0.65 * strFrac);
              const mode = 1 + (s % 4); // harmonic overtone mode per string
              const driveFreq = 5.5 + s * 1.9;
              const driveSign = Math.sin(time * driveFreq + s * 1.7 + subStep * 0.3);

              // Localized onset / transient pluck point shifts along the string with beat
              const pluckPos = 0.18 + 0.64 * (((s * 0.37 + audio.bar * 0.23 + audio.phase * 0.15) % 1 + 1) % 1);
              const pluckImpulse = (audio.onset ? 0.24 : 0) + bRise * 0.55;

              uNxt[row] = 0;
              uNxt[row + NODES - 1] = 0;
              for (let i = 1; i < NODES - 1; i++) {
                const idx = row + i;
                const x = i / (NODES - 1);
                const lap = uCur[idx - 1] - 2 * uCur[idx] + uCur[idx + 1];
                // Sympathetic acoustic coupling with adjacent strings
                let coup = 0;
                if (s > 0) coup += uCur[idx - NODES] - uCur[idx];
                if (s < numStr - 1) coup += uCur[idx + NODES] - uCur[idx];

                let force = 0;
                if (audio.rms > 0.004) {
                  // Continuous resonant standing-wave bowing from this string's frequency band
                  const env = Math.sin(x * Math.PI);
                  force += Math.sin(x * Math.PI * mode) * env * bVal * driveSign * 0.022 * pluck;
                  // Sharp localized pluck on onsets / band transients
                  if (pluckImpulse > 0.04) {
                    const dx = (x - pluckPos) * 14.0;
                    force += Math.exp(-dx * dx) * pluckImpulse * (s & 1 ? 1 : -1) * 0.085 * pluck;
                  }
                  // Subtle stereo waveform bowing along central strings
                  if (w && w.length >= 1024 && subStep === 0) {
                    const wi = Math.min(511, Math.floor(x * 511)) * 2;
                    const ws = (s & 1) ? w[wi + 1] : w[wi];
                    force += ws * env * 0.008 * pluck;
                  }
                }

                const v = (2 * uCur[idx] - uPrv[idx]) * damp + c2 * lap + 0.012 * coup + force;
                // Soft saturation keeps wave amplitude bounded and NaN-free
                uNxt[idx] = Math.tanh(v * 0.92) * 1.08;
              }
            }
            uPrv.set(uCur);
            uCur.set(uNxt);
          }
          for (let b = 0; b < 16; b++) prevBand[b] = prevBand[b] * 0.72 + audio.bands[b] * 0.28;
        }

        let kick = 0;
        for (let ago = 0; ago < 20; ago++) if (past(ago).onset) kick = Math.max(kick, Math.exp(-ago / 6));

        // Build instanced glowing string segments
        const halfX = aspect * 0.88;
        const ySpan = 1.54;
        const ampScale = (ySpan / numStr) * 0.78;
        let segCount = 0;

        for (let s = 0; s < numStr; s++) {
          const strFrac = numStr > 1 ? s / (numStr - 1) : 0.5;
          const baseY = (strFrac * 2 - 1) * (ySpan * 0.5);
          const bIdx = Math.min(15, Math.floor(strFrac * 15.99));
          const bVal = audio.bands[bIdx];
          const [r, g, b] = samplePal(stops, (strFrac * 0.85 + time * 0.03) % 1);
          const row = s * NODES;

          for (let i = 0; i < SEGS_PER_STR; i++) {
            const u0 = i / SEGS_PER_STR, u1 = (i + 1) / SEGS_PER_STR;
            const d0 = uCur[row + i], d1 = uCur[row + i + 1];
            const x0 = (u0 * 2 - 1) * halfX, x1 = (u1 * 2 - 1) * halfX;
            const y0 = baseY + d0 * ampScale, y1 = baseY + d1 * ampScale;
            const energy = Math.abs(d0) + Math.abs(d1) + Math.abs(d1 - d0) * 4.0;
            const inten = (0.18 + energy * 1.65 + bVal * 0.75 + kick * 0.25) * glow;
            const o = segCount * SEG_FLOATS;
            sdata[o] = x0; sdata[o + 1] = y0; sdata[o + 2] = x1; sdata[o + 3] = y1;
            sdata[o + 4] = r; sdata[o + 5] = g; sdata[o + 6] = b; sdata[o + 7] = inten;
            segCount++;
          }
        }

        udata.set([
          width, height, aspect, time,
          audio.rms, kick, numStr, NODES,
          glow, harmonics, halfX, ySpan,
          audio.phase, 0, 0, 0,
        ], 0);
        for (let i = 0; i < 8; i++) {
          const rgb = samplePal(stops, i / 7);
          udata.set([rgb[0], rgb[1], rgb[2], 1], 16 + i * 4);
        }

        device.queue.writeBuffer(ubuf, 0, udata);
        device.queue.writeBuffer(dbuf, 0, uCur.subarray(0, numStr * NODES));
        if (segCount > 0) device.queue.writeBuffer(sbuf, 0, sdata.subarray(0, segCount * SEG_FLOATS));

        const rp = enc.beginRenderPass({
          colorAttachments: [{ view: out.out.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }],
        });
        rp.setPipeline(bgPipe);
        rp.setBindGroup(0, bgGroup);
        rp.draw(3);
        if (segCount > 0) {
          rp.setPipeline(segPipe);
          rp.setBindGroup(0, segGroup);
          rp.draw(6, segCount);
        }
        rp.end();
      },
      dispose: () => { ubuf.destroy(); dbuf.destroy(); sbuf.destroy(); },
    };
  },
});
