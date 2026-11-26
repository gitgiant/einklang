import { definePiece, oklabToLinear, oklch, type Palette } from '../../../api/index.ts';

const MAX_SEGS = 1280;
const MAX_LASERS = 16;
// Uniform layout:
// 4 vec4s header + 4 vec4s bands + 8 vec4s palette + 16 vec4s laser params = 32 vec4s = 512 bytes
const UBYTES = 32 * 16;
// Each segment = 2 vec4fs = 32 bytes: (x0, y0, x1, y1), (widthPx, intensity, palT, coreBoost)
const SEG_BYTES = MAX_SEGS * 32;

const ADD_BLEND: GPUBlendState = {
  color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
  alpha: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
};

function samplePalette8(pal: Palette | undefined, fallbackHue: number, out: Float32Array, offset: number): void {
  const stops = pal?.stops?.length
    ? pal.stops
    : Array.from({ length: 6 }, (_, i) => oklch(0.74, 0.18, fallbackHue + i * 0.14));
  const n = stops.length;
  for (let i = 0; i < 8; i++) {
    const t = (i / 7) * (n - 1);
    const a = Math.min(n - 1, Math.floor(t));
    const b = Math.min(n - 1, a + 1);
    const f = t - a;
    const lab: [number, number, number] = [
      stops[a][0] + (stops[b][0] - stops[a][0]) * f,
      stops[a][1] + (stops[b][1] - stops[a][1]) * f,
      stops[a][2] + (stops[b][2] - stops[a][2]) * f,
    ];
    const rgb = oklabToLinear(lab);
    out[offset + i * 4 + 0] = Math.max(0, rgb[0]);
    out[offset + i * 4 + 1] = Math.max(0, rgb[1]);
    out[offset + i * 4 + 2] = Math.max(0, rgb[2]);
    out[offset + i * 4 + 3] = 1;
  }
}

export default definePiece({
  gpu: ({ device, shader }) => {
    const mod = shader('lightning.wgsl');
    const ubuf = device.createBuffer({ label: 'lightning-u', size: UBYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const segBuf = device.createBuffer({ label: 'lightning-segs', size: SEG_BYTES, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });

    const skyPipe = device.createRenderPipeline({
      label: 'lightning-sky-lasers',
      layout: 'auto',
      vertex: { module: mod, entryPoint: 'vs_full' },
      fragment: { module: mod, entryPoint: 'fs_sky_lasers', targets: [{ format: 'rgba16float' }] },
    });

    const boltPipe = device.createRenderPipeline({
      label: 'lightning-bolts',
      layout: 'auto',
      vertex: { module: mod, entryPoint: 'vs_seg' },
      fragment: {
        module: mod,
        entryPoint: 'fs_seg',
        targets: [{ format: 'rgba16float', blend: ADD_BLEND }],
      },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
    });

    const skyBind = device.createBindGroup({
      layout: skyPipe.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: ubuf } }],
    });

    const boltBind = device.createBindGroup({
      layout: boltPipe.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: ubuf } },
        { binding: 1, resource: { buffer: segBuf } },
      ],
    });

    const udata = new Float32Array(UBYTES / 4);
    const segs = new Float32Array(MAX_SEGS * 8);

    return {
      frame({ enc, out, in: ins, params, audio, tick, sub, time, past, rand, width, height }) {
        const boltsParam = params.bolts as number;
        const branchesParam = params.branches as number;
        const laserCount = Math.max(0, Math.min(MAX_LASERS, Math.round(params.lasers as number)));
        const sweepParam = params.sweep as number;
        const glowParam = params.glow as number;
        const hazeParam = params.haze as number;

        let segCount = 0;
        const pushSeg = (
          x0: number, y0: number, x1: number, y1: number,
          w: number, inten: number, palT: number, coreBoost: number,
        ) => {
          if (segCount >= MAX_SEGS) return;
          const o = segCount * 8;
          segs[o + 0] = x0;
          segs[o + 1] = y0;
          segs[o + 2] = x1;
          segs[o + 3] = y1;
          segs[o + 4] = w;
          segs[o + 5] = inten;
          segs[o + 6] = palT;
          segs[o + 7] = coreBoost;
          segCount++;
        };

        // Recursive midpoint-displaced jagged bolt builder
        const emitBolt = (
          x0: number, y0: number, x1: number, y1: number,
          depth: number, seed: number,
          baseW: number, inten: number, palT: number,
          jitter: number, branchProb: number, forkDepth: number,
        ) => {
          if (segCount >= MAX_SEGS) return;
          if (depth <= 0) {
            pushSeg(x0, y0, x1, y1, baseW, inten, palT, forkDepth === 0 ? 1.0 : 0.65);
            return;
          }
          const mx = (x0 + x1) * 0.5;
          const my = (y0 + y1) * 0.5;
          const dx = x1 - x0;
          const dy = y1 - y0;
          const len = Math.hypot(dx, dy);
          if (len < 1e-4) return;
          const nx = -dy / len;
          const ny = dx / len;
          const off = (rand(seed, depth * 31 + 7) - 0.5) * 2.0 * jitter * len;
          const px = mx + nx * off;
          const py = my + ny * off;

          emitBolt(x0, y0, px, py, depth - 1, seed * 2 + 3, baseW, inten, palT, jitter * 0.92, branchProb, forkDepth);
          emitBolt(px, py, x1, y1, depth - 1, seed * 2 + 11, baseW * 0.94, inten * 0.96, palT, jitter * 0.92, branchProb, forkDepth);

          // Spawn forked branch from midpoint
          if (forkDepth < 2 && depth >= 2 && rand(seed, depth * 73 + 19) < branchProb) {
            const side = rand(seed, depth * 97 + 5) < 0.5 ? -1 : 1;
            const ang = Math.atan2(dy, dx) + side * (0.32 + rand(seed, depth * 113) * 0.55);
            const blen = len * (0.45 + rand(seed, depth * 131) * 0.45);
            const bx = px + Math.cos(ang) * blen;
            const by = py + Math.sin(ang) * blen;
            emitBolt(
              px, py, bx, by,
              Math.max(1, depth - 2),
              seed * 5 + depth * 17,
              baseW * 0.52,
              inten * 0.62,
              Math.min(1, palT + 0.14),
              jitter * 1.08,
              branchProb * 0.55,
              forkDepth + 1,
            );
          }
        };

        // Scan recent ticks for onsets and generate branching bolts scaled by onset strength
        let flashSum = 0;
        let flashX = 0.5;
        let flashY = 0.18;
        let onsetFound = false;

        for (let ago = 0; ago < 26; ago++) {
          const f = past(ago);
          if (!f.onset) continue;
          onsetFound = true;
          const fPrev = past(Math.min(599, ago + 1));
          const bass = (f.bands[0] + f.bands[1] + f.bands[2]) / 3;
          const high = (f.bands[10] + f.bands[11] + f.bands[12] + f.bands[13]) / 4;
          const flux = Math.max(0, f.rms - fPrev.rms) * 2.6 + Math.max(0, bass - fPrev.bands[0]) * 1.1;
          const strength = Math.min(2.0, Math.max(0.35, 0.35 + f.rms * 0.95 + bass * 0.5 + flux));

          const ageSec = (ago + sub / 256) / 60;
          const life = 0.24 + strength * 0.11;
          if (ageSec > life) continue;

          // Realistic lightning envelope with sharp initial strike and brief restrike flicker
          const normAge = ageSec / life;
          const restrike = 1.0 + 0.45 * Math.exp(-Math.pow((normAge - 0.28) * 11.0, 2.0));
          const env = Math.pow(1.0 - normAge, 1.75) * restrike;
          const onsetTick = tick - ago;

          // Bolt count scales directly with onset strength and bolts param
          const count = Math.max(1, Math.min(6, Math.round((0.65 + strength * 1.85) * boltsParam)));
          const brProb = Math.min(0.85, branchesParam * (0.45 + strength * 0.35));

          for (let b = 0; b < count; b++) {
            const seed = ((onsetTick * 37 + b * 1013) & 0x7fffffff) + 17;
            const isCloudArc = b >= 2 && rand(seed, 3) > 0.62;
            let x0: number, y0: number, x1: number, y1: number;
            if (isCloudArc) {
              x0 = 0.08 + rand(seed, 11) * 0.42;
              y0 = 0.04 + rand(seed, 13) * 0.22;
              x1 = x0 + 0.22 + rand(seed, 17) * 0.4;
              y1 = 0.08 + rand(seed, 19) * 0.26;
            } else {
              x0 = 0.10 + rand(seed, 23) * 0.80;
              y0 = -0.02 + rand(seed, 29) * 0.08;
              x1 = Math.max(0.05, Math.min(0.95, x0 + (rand(seed, 31) - 0.5) * 0.42));
              y1 = 0.58 + rand(seed, 37) * 0.46;
            }
            const boltStr = (b === 0 ? 1.0 : 0.72) * strength * env;
            const baseW = (1.5 + strength * 1.45) * (b === 0 ? 1.0 : 0.72);
            const palT = (rand(seed, 41) * 0.45 + high * 0.55) % 1.0;

            emitBolt(x0, y0, x1, y1, 4, seed, baseW, boltStr * 1.35, palT, 0.27, brProb, 0);

            if (boltStr > 0.05) {
              const weight = boltStr;
              flashX = (flashX * flashSum + ((x0 + x1) * 0.5) * weight) / (flashSum + weight);
              flashY = (flashY * flashSum + (y0 * 0.7 + y1 * 0.3) * weight) / (flashSum + weight);
              flashSum += weight;
            }
          }
        }

        // Subtle ambient storm sheet arc when no recent onsets occurred so quiet skies stay electric
        if (!onsetFound || flashSum < 0.08) {
          const slot = Math.floor(time * 0.9);
          const localAge = time * 0.9 - slot;
          if (localAge < 0.34) {
            const env = Math.pow(1.0 - localAge / 0.34, 2.0) * (0.28 + audio.rms * 0.55);
            const seed = (slot * 257 + 911) & 0x7fffffff;
            const x0 = 0.16 + rand(seed, 1) * 0.68;
            const y0 = 0.02 + rand(seed, 2) * 0.12;
            const x1 = Math.max(0.08, Math.min(0.92, x0 + (rand(seed, 3) - 0.5) * 0.35));
            const y1 = 0.32 + rand(seed, 4) * 0.34;
            emitBolt(x0, y0, x1, y1, 4, seed, 1.35, env, 0.55, 0.25, branchesParam * 0.5, 0);
            flashSum += env * 0.4;
          }
        }

        // Build beat-synced laser beams: stored as 16 vec4fs (origX, angleRad, intensity, palT)
        const beatContinuous = audio.bar + audio.phase;
        const barFrac = beatContinuous * 0.25; // 0..1 per 4-beat bar
        const beatPhaseRad = audio.phase * Math.PI * 2.0;
        const barRad = barFrac * Math.PI * 2.0;
        const mode = Math.floor(audio.bar) % 4;

        const bassNow = (audio.bands[0] + audio.bands[1] + audio.bands[2]) / 3;
        const highNow = (audio.bands[10] + audio.bands[11] + audio.bands[12] + audio.bands[13]) / 4;

        udata.set([width, height, time, laserCount], 0);
        udata.set([glowParam, hazeParam, sweepParam, Math.min(2.2, flashSum)], 4);
        udata.set([flashX, flashY, audio.rms, bassNow], 8);
        udata.set([audio.phase, audio.bar, highNow, 0], 12);
        udata.set(audio.bands.subarray(0, 16), 16);
        samplePalette8(ins.palette as Palette | undefined, audio.pal, udata, 32);

        // Laser array starts at float index 64 (vec4 #16 .. #31)
        for (let i = 0; i < MAX_LASERS; i++) {
          const base = 64 + i * 4;
          if (i >= laserCount) {
            udata[base + 0] = 0.5;
            udata[base + 1] = 0;
            udata[base + 2] = 0;
            udata[base + 3] = 0;
            continue;
          }
          const side = (i % 2 === 0) ? -1 : 1;
          const pairIdx = Math.floor(i / 2);
          const pairCount = Math.max(1, Math.ceil(laserCount / 2));
          const spread = pairCount > 1 ? (pairIdx / (pairCount - 1)) - 0.5 : 0;

          // Dual stage-truss emitters at upper-left and upper-right, fanning symmetrically across the arena
          const origX = 0.5 + side * (0.34 - spread * 0.14);

          // Beat-phase choreography: crisp rhythmic sweeps + cross-fan alternation across the 4-beat bar
          const swayA = Math.sin(beatPhaseRad + pairIdx * 0.55) * 0.34 * sweepParam;
          const swayB = Math.cos(barRad + side * 0.8 + pairIdx * 0.4) * 0.28 * sweepParam;
          const beatFan = (mode === 1 || mode === 3) ? -side * 0.24 : side * 0.12;
          const baseAngle = Math.PI * 0.5 + spread * 0.82 + beatFan + side * (swayA + swayB) + Math.sin(time * 0.45 + i) * 0.08;

          const bandIdx = Math.min(15, Math.floor((i / Math.max(1, laserCount)) * 14) + 1);
          const bandLvl = audio.bands[bandIdx];
          const beatPulse = 0.65 + 0.35 * Math.pow(1.0 - audio.phase, 1.5);
          const laserInt = (0.34 + bandLvl * 0.95 + audio.rms * 0.35) * beatPulse;
          const palT = (i / Math.max(1, laserCount) * 0.7 + audio.phase * 0.25) % 1.0;

          udata[base + 0] = origX;
          udata[base + 1] = baseAngle;
          udata[base + 2] = laserInt;
          udata[base + 3] = palT;
        }

        device.queue.writeBuffer(ubuf, 0, udata);
        if (segCount > 0) {
          device.queue.writeBuffer(segBuf, 0, segs, 0, segCount * 8);
        }

        const rp = enc.beginRenderPass({
          colorAttachments: [{
            view: out.out.createView(),
            loadOp: 'clear',
            storeOp: 'store',
            clearValue: [0, 0, 0, 1],
          }],
        });
        rp.setPipeline(skyPipe);
        rp.setBindGroup(0, skyBind);
        rp.draw(3);

        if (segCount > 0) {
          rp.setPipeline(boltPipe);
          rp.setBindGroup(0, boltBind);
          rp.draw(6, segCount);
        }
        rp.end();
      },
      dispose() {
        ubuf.destroy();
        segBuf.destroy();
      },
    };
  },
});
