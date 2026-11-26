import { definePiece, oklabToLinear, oklch, type Palette } from '../../../api/index.ts';

const MAX_SEGS = 512;
const SEG_FLOATS = 12; // p0.xy, p1.xy, col.rgb, inten, width, kind (0=bolt,1=laser), pad, pad

function samplePal(stops: [number, number, number][], x: number): [number, number, number] {
  const n = stops.length;
  if (n <= 1) return oklabToLinear(stops[0] ?? [0.75, 0.05, -0.18]).map((c) => Math.max(0, c)) as [number, number, number];
  const f = Math.min(1, Math.max(0, x)) * (n - 1);
  const i = Math.min(Math.floor(f), n - 1);
  const j = Math.min(i + 1, n - 1);
  const t = f - i;
  const a = stops[i], b = stops[j];
  const rgb = oklabToLinear([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]);
  return [Math.max(0, rgb[0]), Math.max(0, rgb[1]), Math.max(0, rgb[2])];
}

function hash01(a: number, b: number): number {
  let x = Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(b + 0x632be5ab, 0xc2b2ae35);
  x = Math.imul(x ^ (x >>> 16), 0x7feb352d);
  x = Math.imul(x ^ (x >>> 15), 0x846ca68b);
  return ((x ^ (x >>> 16)) >>> 0) / 4294967296;
}

export default definePiece({
  gpu: ({ device, shader }) => {
    const mod = shader('lightning.wgsl');
    const ubuf = device.createBuffer({ label: 'agy-lightning u', size: 64, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const sbuf = device.createBuffer({ label: 'agy-lightning segs', size: MAX_SEGS * SEG_FLOATS * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });

    const bgPipe = device.createRenderPipeline({
      label: 'agy-lightning bg', layout: 'auto',
      vertex: { module: mod, entryPoint: 'vs_full' },
      fragment: { module: mod, entryPoint: 'fs_bg', targets: [{ format: 'rgba16float' }] },
    });
    const segPipe = device.createRenderPipeline({
      label: 'agy-lightning seg', layout: 'auto',
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

    const bgGroup = device.createBindGroup({ layout: bgPipe.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: ubuf } }] });
    const segGroup = device.createBindGroup({
      layout: segPipe.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: ubuf } },
        { binding: 1, resource: { buffer: sbuf } },
      ],
    });

    const udata = new Float32Array(16);
    const sdata = new Float32Array(MAX_SEGS * SEG_FLOATS);
    const ptsX = new Float32Array(33);
    const ptsY = new Float32Array(33);

    return {
      frame({ enc, out, in: ins, params, audio, tick, time, past, width, height }) {
        const aspect = width / height;
        const numLasers = Math.min(20, Math.max(2, Math.round(params.lasers as number)));
        const maxBolts = Math.min(8, Math.max(1, Math.round(params.bolts as number)));
        const jagged = params.jagged as number;
        const sweep = params.sweep as number;
        const intensity = params.intensity as number;
        const haze = params.haze as number;

        const stops = (ins.palette as Palette | undefined)?.stops
          ?? Array.from({ length: 6 }, (_, i) => oklch(0.74, 0.2, 0.65 + audio.pal + i * 0.08));

        const bass = (audio.bands[0] + audio.bands[1] + audio.bands[2]) / 3;
        const hi = (audio.bands[11] + audio.bands[12] + audio.bands[13] + audio.bands[14]) * 0.25;

        let segCount = 0;
        const pushSeg = (
          x0: number, y0: number, x1: number, y1: number,
          r: number, g: number, b: number, inten: number, w: number, kind: number,
        ) => {
          if (segCount >= MAX_SEGS || inten <= 0.002) return;
          const o = segCount * SEG_FLOATS;
          sdata[o] = x0; sdata[o + 1] = y0; sdata[o + 2] = x1; sdata[o + 3] = y1;
          sdata[o + 4] = r; sdata[o + 5] = g; sdata[o + 6] = b; sdata[o + 7] = inten;
          sdata[o + 8] = w; sdata[o + 9] = kind; sdata[o + 10] = 0; sdata[o + 11] = 0;
          segCount++;
        };

        // Recursive midpoint-displaced fractal bolt builder (16 segments + forked branches)
        const emitBolt = (
          ax: number, ay: number, bx: number, by: number,
          seed: number, env: number, wBase: number, col: [number, number, number],
          subSteps: number, withForks: boolean,
        ) => {
          const n = 1 << subSteps; // 16 or 8
          ptsX[0] = ax; ptsY[0] = ay;
          ptsX[n] = bx; ptsY[n] = by;
          let stride = n;
          let disp = jagged * Math.hypot(bx - ax, by - ay) * 0.42;
          let lvl = 0;
          while (stride > 1) {
            const half = stride >> 1;
            for (let i = 0; i < n; i += stride) {
              const mx = (ptsX[i] + ptsX[i + stride]) * 0.5;
              const my = (ptsY[i] + ptsY[i + stride]) * 0.5;
              const dx = ptsX[i + stride] - ptsX[i];
              const dy = ptsY[i + stride] - ptsY[i];
              const len = Math.hypot(dx, dy) || 1;
              const nx = -dy / len, ny = dx / len;
              const rnd = hash01(seed + lvl * 97, i * 13 + 7) * 2 - 1;
              // Sizzling high-frequency micro-jitter
              const jitter = Math.sin(time * 52 + i * 3.1 + seed) * 0.012;
              ptsX[i + half] = mx + nx * (rnd * disp + jitter);
              ptsY[i + half] = my + ny * (rnd * disp + jitter);
            }
            stride = half;
            disp *= 0.54;
            lvl++;
          }
          for (let i = 0; i < n; i++) {
            const taper = 1.0 - (i / n) * 0.35;
            pushSeg(ptsX[i], ptsY[i], ptsX[i + 1], ptsY[i + 1], col[0], col[1], col[2], env, wBase * taper, 0);
          }
          if (withForks && n >= 8) {
            for (let f = 0; f < 2; f++) {
              const idx = Math.floor((0.25 + f * 0.32 + hash01(seed, f + 99) * 0.16) * n);
              const fx0 = ptsX[idx], fy0 = ptsY[idx];
              const ang = Math.atan2(by - ay, bx - ax) + (hash01(seed + 31, f) > 0.5 ? 1 : -1) * (0.45 + hash01(seed + 53, f) * 0.45);
              const flen = Math.hypot(bx - ax, by - ay) * (0.28 + 0.18 * hash01(seed + 71, f));
              const fx1 = fx0 + Math.cos(ang) * flen;
              const fy1 = fy0 + Math.sin(ang) * flen;
              emitBolt(fx0, fy0, fx1, fy1, seed + 401 * (f + 1), env * 0.62, wBase * 0.58, col, 2, false);
            }
          }
        };

        // 1. Scan recent onset strikes (closed-form over past 36 ticks)
        let flash = 0;
        let boltCount = 0;
        const trigNow = ((ins.onset as number | undefined) ?? 0) > 0;
        for (let ago = 0; ago < 36 && boltCount < maxBolts; ago++) {
          const isOn = ago === 0 ? (trigNow || past(0).onset) : past(ago).onset;
          if (!isOn) continue;
          const strikeTick = tick - ago;
          const env = Math.exp(-ago / 7.5);
          flash = Math.max(flash, env);
          const s = strikeTick * 37 + boltCount * 17;
          // Strike from top-rig Tesla electrodes or side arcs across the stage
          const sideMode = hash01(s, 1);
          let ax: number, ay: number, bx: number, by: number;
          if (sideMode < 0.65) {
            ax = (hash01(s, 2) * 2 - 1) * aspect * 0.78;
            ay = 0.98;
            bx = ax * 0.4 + (hash01(s, 3) * 2 - 1) * aspect * 0.58;
            by = -0.92 + hash01(s, 4) * 0.45;
          } else {
            const left = hash01(s, 5) > 0.5 ? -1 : 1;
            ax = left * aspect * 0.95;
            ay = (hash01(s, 6) * 1.3 - 0.5);
            bx = -left * aspect * (0.2 + hash01(s, 7) * 0.7);
            by = (hash01(s, 8) * 1.4 - 0.7);
          }
          const col = samplePal(stops, hash01(s, 9));
          emitBolt(ax, ay, bx, by, s, env * intensity * 1.35, 0.013, col, 4, true);
          boltCount++;
        }

        // 2. Ambient high-voltage Tesla filaments driven by rms/high (keeps quiet scenes alive, stays dark on silence)
        if (audio.rms > 0.01) {
          const arcEpoch = Math.floor(tick / 10);
          const arcEnergy = Math.min(1.4, (audio.rms * 1.4 + hi * 1.1) * intensity);
          for (let a = 0; a < 2; a++) {
            const s = arcEpoch * 19 + a * 113;
            const yL = 0.35 * Math.sin(time * 0.8 + a * 2.4);
            const yR = 0.35 * Math.cos(time * 0.65 - a * 1.9);
            const col = samplePal(stops, (0.25 + a * 0.45 + time * 0.04) % 1);
            emitBolt(-aspect * 0.78, yL, aspect * 0.78, yR, s, arcEnergy * 0.42, 0.0085, col, 3, false);
          }
        }

        // 3. Beat-locked sweeping volumetric concert laser fans from two stage banks
        const half = Math.ceil(numLasers / 2);
        const beatRad = (audio.bar + audio.phase) * Math.PI * 0.5;
        const spreadAngle = 0.48 + 0.32 * bass + 0.14 * Math.sin(beatRad * 2);
        const baseAim = Math.sin(time * 0.65 * sweep + Math.sin(beatRad) * 0.35) * 0.42;

        for (let bank = 0; bank < 2; bank++) {
          const dirSign = bank === 0 ? 1 : -1;
          const ex = -dirSign * aspect * 0.62;
          const ey = 0.96;
          for (let i = 0; i < half && bank * half + i < numLasers; i++) {
            const t = half > 1 ? (i / (half - 1)) * 2 - 1 : 0;
            const bandIdx = Math.min(15, Math.floor(((bank * half + i) / numLasers) * 16));
            const bVal = audio.bands[bandIdx];
            // Fan angle sweeps in opposition between left & right banks for classic concert scissor beams
            const ang = -Math.PI * 0.5 + dirSign * (0.24 + baseAim) + t * spreadAngle;
            const reach = 2.65;
            const tx = ex + Math.cos(ang) * reach;
            const ty = ey + Math.sin(ang) * reach;
            const col = samplePal(stops, (i / Math.max(1, half - 1) * 0.65 + bank * 0.35 + time * 0.03) % 1);
            // Quiet/silence safety: scales cleanly with audio bands + rms (nearly off on silence!)
            const beamI = (bVal * 0.85 + audio.rms * 0.35 + flash * 0.45) * intensity * 0.65;
            pushSeg(ex, ey, tx, ty, col[0], col[1], col[2], beamI, 0.012 + 0.008 * bass, 1);
          }
        }

        const p0 = samplePal(stops, 0.2);
        const p1 = samplePal(stops, 0.78);
        udata.set([
          width, height, aspect, time,
          audio.rms, flash, haze, bass,
          p0[0], p0[1], p0[2], 1,
          p1[0], p1[1], p1[2], 1,
        ], 0);
        device.queue.writeBuffer(ubuf, 0, udata);
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
      dispose: () => { ubuf.destroy(); sbuf.destroy(); },
    };
  },
});
