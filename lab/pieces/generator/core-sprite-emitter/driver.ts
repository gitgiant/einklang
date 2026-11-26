import { definePiece, oklabToLinear, oklch, parseSheet, sheetTexture, type Palette } from '../../../api/index.ts';

const SHEETS = ['dancer', 'sparkle', 'heart', 'note'].map((n) => `assets/sprites/${n}.spr`);
/** Most sprites alive at once. */
const MAX = 2048;
/** Floats per instance (see P in emitter.wgsl). */
const STRIDE = 12;

export default definePiece({
  gpu: ({ device, shader, asset }) => {
    const sheets = SHEETS.map((p) => { const s = parseSheet(asset(p)); return { s, tex: sheetTexture(device, s, p) }; });
    const mod = shader('emitter.wgsl');
    const pipe = device.createRenderPipeline({
      label: 'sprite-emitter', layout: 'auto',
      vertex: { module: mod, entryPoint: 'vs_quad' },
      fragment: {
        module: mod, entryPoint: 'fs_quad',
        targets: [{ format: 'rgba16float', blend: { color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' }, alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' } } }],
      },
    });
    const ubuf = device.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const pbuf = device.createBuffer({ size: MAX * STRIDE * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    const groups = sheets.map((x) => device.createBindGroup({
      layout: pipe.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: ubuf } }, { binding: 1, resource: { buffer: pbuf } }, { binding: 2, resource: x.tex.createView({ dimension: '2d-array' }) }],
    }));
    const data = new Float32Array(MAX * STRIDE);
    let n = 0;
    return {
      frame({ enc, out, params, past, tick, sub, rand, audio, width, height, in: ins }) {
        const i = Math.min(sheets.length - 1, Math.max(0, Math.round(params.sheet as number))), { s } = sheets[i];
        const life = Math.round((params.life as number) * 60), burst = params.burst as number, trickle = params.trickle as number;
        const speed = params.speed as number, grav = params.gravity as number, spread = params.spread as number, size = params.size as number;
        const pal = (ins.palette as Palette | undefined)?.stops ?? Array.from({ length: 6 }, (_, k) => oklch(0.75, 0.16, audio.pal + k / 6));
        const cols = pal.map((c) => oklabToLinear(c).map((x) => Math.max(0, x)));
        const every = trickle > 0 ? Math.max(1, Math.round(60 / trickle)) : 0;
        n = 0;
        // every sprite alive now was born on one of the last `life` ticks: replay those births
        for (let ago = Math.min(life, 600) - 1; ago >= 0 && n < MAX; ago--) {
          const born = tick - ago, a = past(ago);
          const count = (a.onset ? burst : 0) + (every && born % every === 0 ? 1 : 0);
          for (let k = 0; k < count && n < MAX; k++) {
            const r = (j: number) => rand(born, k * 8 + j);
            const ang = -Math.PI / 2 + (r(0) - 0.5) * 2 * Math.PI * spread;
            const v = speed * (0.4 + 0.8 * r(1)) * (a.onset ? 1 + a.rms : 0.6);
            const t = (ago + sub / 256) / 60, f = t / (life / 60);
            const x = params.x as number + (Math.cos(ang) * v * t) * (height / width);
            const y = params.y as number + Math.sin(ang) * v * t + 0.5 * grav * t * t;
            const c = cols[Math.floor(r(2) * cols.length)];
            data.set([x, y, size * (0.7 + 0.6 * r(3)) * (1 - 0.3 * f), (r(4) - 0.5) * 2 * t, Math.floor(r(5) * s.frames + t * 8) % s.frames, Math.min(1, (1 - f) * 3), 0, 0, c[0], c[1], c[2], params.tint as number], n * STRIDE);
            n++;
          }
        }
        device.queue.writeBuffer(ubuf, 0, new Float32Array([width, height, 0, 0, s.w, s.h, s.frames, params.glow as number]));
        if (n) device.queue.writeBuffer(pbuf, 0, data, 0, n * STRIDE);
        const rp = enc.beginRenderPass({ colorAttachments: [{ view: out.out.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 0] }] });
        if (n) { rp.setPipeline(pipe); rp.setBindGroup(0, groups[i]); rp.draw(6, n); }
        rp.end();
      },
      dispose: () => { ubuf.destroy(); pbuf.destroy(); for (const x of sheets) x.tex.destroy(); },
      status: () => `${n} sprites`,
    };
  },
});
