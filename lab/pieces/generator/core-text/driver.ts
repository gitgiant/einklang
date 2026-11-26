import { definePiece, fontTexture, layoutText, MSDF_WGSL, oklabToLinear, oklch, parseFont, type Font, type Layout, type Palette } from '../../../api/index.ts';

const FONTS = ['pixel5x8', 'display-msdf'].map((n) => `assets/fonts/${n}.efont`);
const MAX = 1024;
/** Floats per glyph instance (see G in text.wgsl). */
const STRIDE = 12;
const MODES = ['center', 'kinetic', 'typewriter', 'marquee', 'sine scroll'] as const;

export default definePiece({
  gpu: ({ device, wgsl, compile, asset }) => {
    const fonts = FONTS.map((p) => { const f = parseFont(asset(p)); return { f, tex: fontTexture(device, f) }; });
    const mod = compile(MSDF_WGSL + wgsl('text.wgsl'), 'core-text');
    const pipe = device.createRenderPipeline({
      label: 'text', layout: 'auto',
      vertex: { module: mod, entryPoint: 'vs_glyph' },
      fragment: {
        module: mod, entryPoint: 'fs_glyph',
        targets: [{ format: 'rgba16float', blend: { color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' }, alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' } } }],
      },
    });
    const ubuf = device.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const gbuf = device.createBuffer({ size: MAX * STRIDE * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    const nearest = device.createSampler({ magFilter: 'nearest', minFilter: 'nearest' }), linear = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });
    const groups = fonts.map(({ f, tex }) => device.createBindGroup({
      layout: pipe.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: ubuf } }, { binding: 1, resource: { buffer: gbuf } }, { binding: 2, resource: tex.createView() }, { binding: 3, resource: f.mode === 'msdf' ? linear : nearest }],
    }));
    const data = new Float32Array(MAX * STRIDE);
    // layout only changes with the text, font, wrap or mode
    let cacheKey = '', lay: Layout | null = null, shown = '';
    const layout = (f: Font, text: string, wrap: number | undefined) => {
      const key = `${f.name}|${wrap}|${text}`;
      if (key !== cacheKey) { cacheKey = key; lay = layoutText(f, text, { wrap, align: 'center' }); }
      return lay!;
    };
    return {
      frame({ enc, out, params, audio, past, time, lyric, width, height, in: ins }) {
        const fi = Math.min(fonts.length - 1, Math.max(0, Math.round(params.font as number))), { f } = fonts[fi];
        const mode = MODES[Math.round(params.mode as number)] ?? 'center', source = Math.round(params.source as number);
        const line = source === 0 ? null : lyric();
        let text = line ? line.text : source === 1 ? '' : String(params.text);
        if (params.upper) text = text.toUpperCase();
        shown = text;
        // screen px per font px; the pixel font snaps to whole steps
        let s = ((params.size as number) * height) / f.lineHeight;
        if (f.mode === 'bitmap') s = Math.max(1, Math.round(s));
        const scroll = mode === 'marquee' || mode === 'sine scroll';
        const L = layout(f, scroll ? text.replace(/\n/g, '   ') : text, scroll ? undefined : ((params.wrap as number) * width) / s);
        const pal = (ins.palette as Palette | undefined)?.stops ?? Array.from({ length: 6 }, (_, k) => oklch(0.78, 0.15, audio.pal + k / 6));
        // only stops light enough to read (OKLab L): a dark stop on a dark background would drop letters
        const light = pal.filter((c) => c[0] >= 0.55), readable = light.length ? light : [...pal].sort((a, b) => b[0] - a[0]).slice(0, 1);
        const cols = readable.map((c) => oklabToLinear(c).map((x) => Math.max(0, x)));
        // onset envelope over the last ~0.4 s, per letter delayed a little
        const onsetAge = (() => { for (let a = 0; a < 24; a++) if (past(a).onset) return a; return 99; })();
        const glow = (params.glow as number) * (0.8 + 0.6 * audio.rms);
        const total = L.quads.length ? L.quads[L.quads.length - 1].i + 1 : 0;
        let shownChars = Infinity;
        if (mode === 'typewriter') shownChars = line ? Math.ceil(total * Math.min(1, line.progress * 1.6 + 0.05)) : Math.floor(((time * audio.bpm) / 60 / 4 % 1) * (total + 8));
        const ox = (params.x as number) * width - (L.width * s) / 2, oy = (params.y as number) * height - (L.height * s) / 2;
        // scrollers enter at the right edge and leave at the left, then come round again
        const span = L.width * s + width, baseX = scroll ? width - ((time * (params.speed as number) * width) % span) : ox;
        let n = 0;
        for (const q of L.quads) {
          if (n >= MAX || q.i >= shownChars) break;
          let x = baseX + q.x * s, y = oy + q.y * s, sc = 1;
          if (scroll && (x > width + 50 || x + q.w * s < -50)) continue;
          if (mode === 'sine scroll') y += Math.sin(x / width * 9 + time * 3) * height * 0.06;
          const age = onsetAge + (mode === 'kinetic' ? q.i * 0.7 : 0), env = age < 24 ? Math.exp(-age / 5) : 0;
          const kick = params.kick as number;
          if (mode === 'kinetic' || mode === 'center') { y -= env * kick * f.lineHeight * s * 0.35 * (mode === 'kinetic' ? 1 : 0.4); sc = 1 + env * kick * (mode === 'kinetic' ? 0.35 : 0.1); }
          if (mode === 'typewriter' && q.i === shownChars - 1) sc = 1.25;
          const w = q.w * s * sc, h = q.h * s * sc;
          x -= (w - q.w * s) / 2; y -= (h - q.h * s) / 2;
          const c = cols[q.i % cols.length], b = glow * (1 + env * kick);
          data.set([x, y, w, h, q.u0, q.v0, q.u1, q.v1, c[0] * b, c[1] * b, c[2] * b, 1], n * STRIDE);
          n++;
        }
        device.queue.writeBuffer(ubuf, 0, new Float32Array([width, height, f.mode === 'msdf' ? 1 : 0, f.range, s, 0, 0, 0]));
        if (n) device.queue.writeBuffer(gbuf, 0, data, 0, n * STRIDE);
        const rp = enc.beginRenderPass({ colorAttachments: [{ view: out.out.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 0] }] });
        if (n) { rp.setPipeline(pipe); rp.setBindGroup(0, groups[fi]); rp.draw(6, n); }
        rp.end();
      },
      dispose: () => { ubuf.destroy(); gbuf.destroy(); for (const x of fonts) x.tex.destroy(); },
      status: () => (shown ? `“${shown.slice(0, 40)}”` : 'no text'),
    };
  },
});
