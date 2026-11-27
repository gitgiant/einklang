import { definePiece, oklabToLinear, oklch, parseSheet, sheetTexture, type Palette } from '../../../api/index.ts';

const DOLPHIN_SHEET = 'assets/sprites/agy-dolphin.spr';

export default definePiece({
  gpu: ({ device, shader, asset }) => {
    const s = parseSheet(asset(DOLPHIN_SHEET));
    const tex = sheetTexture(device, s, DOLPHIN_SHEET);
    const mod = shader('beach.wgsl');
    const pipe = device.createRenderPipeline({
      label: 'agy-dolphin-beach',
      layout: 'auto',
      vertex: { module: mod, entryPoint: 'vs_full' },
      fragment: { module: mod, entryPoint: 'fs_beach', targets: [{ format: 'rgba16float' }] },
    });
    // Uniform buffer layout (16-byte aligned):
    // 0: dims   (width, height, cells, aspect)
    // 4: timing (time, phase, bpm, bar)
    // 8: audio  (rms, bass, onset_env, high)
    // 12: params (dolphins, jump, waves, dither)
    // 16: extra  (glow, spr_w, spr_h, spr_frames)
    // 20..35: bands[4] (16 floats = 4 vec4f)
    // 36..67: pal[8]   (32 floats = 8 vec4f)
    // Total: 68 floats = 272 bytes
    const ubuf = device.createBuffer({ size: 272, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const bg = device.createBindGroup({
      layout: pipe.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: ubuf } },
        { binding: 1, resource: tex.createView({ dimension: '2d-array' }) },
      ],
    });
    const data = new Float32Array(68);

    return {
      frame({ enc, out, params, audio, time, past, width, height, in: ins }) {
        let bassEnv = 0;
        let onsetEnv = 0;
        for (let a = 0; a < 10; a++) {
          const p = past(a);
          const decay = 1 - a / 10;
          bassEnv = Math.max(bassEnv, (p.bands[0] + p.bands[1]) * 0.5 * decay);
          if (p.onset) onsetEnv = Math.max(onsetEnv, decay);
        }
        const high = (audio.bands[11] + audio.bands[12] + audio.bands[13] + audio.bands[14]) * 0.25;
        const pal = (ins.palette as Palette | undefined)?.stops ?? [
          oklch(0.18, 0.09, 0.82),
          oklch(0.42, 0.19, 0.88),
          oklch(0.68, 0.24, 0.96),
          oklch(0.80, 0.18, 0.14),
          oklch(0.84, 0.16, 0.56),
          oklch(0.90, 0.15, 0.46),
        ];

        data.set([width, height, params.cells as number, width / Math.max(1, height)], 0);
        data.set([time, audio.phase, audio.bpm, audio.bar], 4);
        data.set([audio.rms, bassEnv, onsetEnv, high], 8);
        data.set([params.dolphins as number, params.jump as number, params.waves as number, params.dither as number], 12);
        data.set([params.glow as number, s.w, s.h, s.frames], 16);
        for (let k = 0; k < 16; k++) data[20 + k] = audio.bands[k];
        for (let k = 0; k < 8; k++) {
          const stop = pal[Math.min(pal.length - 1, Math.floor((k * pal.length) / 8))];
          const lin = oklabToLinear(stop).map((c) => Math.max(0, c));
          data.set([lin[0], lin[1], lin[2], 1], 36 + k * 4);
        }

        device.queue.writeBuffer(ubuf, 0, data);
        const rp = enc.beginRenderPass({
          colorAttachments: [{ view: out.out.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }],
        });
        rp.setPipeline(pipe);
        rp.setBindGroup(0, bg);
        rp.draw(3);
        rp.end();
      },
      dispose: () => {
        ubuf.destroy();
        tex.destroy();
      },
    };
  },
});
