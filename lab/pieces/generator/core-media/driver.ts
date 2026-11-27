import { BarCounter, CYCLE_BARS, definePiece, fitScale, pickItem } from '../../../api/index.ts';

/** How long an onset keeps pushing the zoom / pulse (ticks). */
const HIT = 12;

export default definePiece({
  gpu: ({ device, shader, media }) => {
    const mod = shader('media.wgsl');
    const pipe = device.createRenderPipeline({
      label: 'core-media', layout: 'auto',
      vertex: { module: mod, entryPoint: 'vs_full' },
      fragment: { module: mod, entryPoint: 'fs_media', targets: [{ format: 'rgba16float' }, { format: 'r16float' }, { format: 'rg16float' }] },
    });
    const samp = device.createSampler({ magFilter: 'linear', minFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' });
    const none = device.createTexture({ size: [1, 1], format: 'rgba8unorm-srgb', usage: GPUTextureUsage.TEXTURE_BINDING, label: 'core-media none' });
    const ubuf = device.createBuffer({ size: 80, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST, label: 'core-media' });
    const data = new Float32Array(20);
    const bars = new BarCounter();
    let bound: GPUTexture | null = null, group: GPUBindGroup | null = null, shown = 'media: none picked';
    return {
      frame({ enc, out, params, audio, past, time, width, height }) {
        const n = media.count(), per = CYCLE_BARS[params.cycle as number] ?? 0;
        const idx = pickItem(n, bars.step(audio.bar), per, params.item as number);
        const f = idx >= 0 ? media.frame(idx) : null, tex = f?.texture ?? none;
        shown = f ? `media ${idx + 1}/${n}: ${f.kind} ${f.width}x${f.height}` : n ? 'media: loading' : 'media: none picked';
        if (tex !== bound) {
          bound = tex;
          group = device.createBindGroup({ layout: pipe.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: ubuf } }, { binding: 1, resource: samp }, { binding: 2, resource: tex.createView() }] });
        }
        // beat envelope: the grid beat (scaled by the bass) or a fresh onset, whichever is stronger
        let hit = 0;
        for (let a = 0; a < HIT; a++) if (past(a).onset) { hit = 1 - a / HIT; break; }
        const bass = (audio.bands[0] + audio.bands[1] + audio.bands[2]) / 3;
        const env = Math.max((1 - audio.phase) ** 4 * (0.3 + 0.7 * bass), hit * hit);
        const drift = params.drift as number;
        const zoom = 1 + 0.15 * (params.beat_zoom as number) * env + 0.08 * drift * (0.5 + 0.5 * Math.sin(time * 0.09));
        const [sx, sy] = f ? fitScale(f.width / f.height, width / height, params.fit as number) : [1, 1];
        // pan within the crop (what cover cut off, plus what the zoom did)
        const slack = (s: number) => Math.max(0, (1 - s / zoom) * 0.5);
        const cx = 0.5 + slack(sx) * drift * Math.sin(time * 0.071), cy = 0.5 + slack(sy) * drift * Math.cos(time * 0.053);
        const mirror = (params.mirror as boolean) !== (f?.mirror ?? false);
        data.set([width, height, f?.width ?? 1, f?.height ?? 1, sx, sy, zoom, mirror ? 1 : 0], 0);
        data.set([params.brightness as number, params.contrast as number, params.saturation as number, params.pulse as number], 8);
        data.set([f ? 1 : 0, time, audio.pal, bass, cx, cy, params.edge_width as number, env], 12);
        device.queue.writeBuffer(ubuf, 0, data);
        const att = (t: GPUTexture): GPURenderPassColorAttachment => ({ view: t.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] });
        const rp = enc.beginRenderPass({ colorAttachments: [att(out.out), att(out.luma), att(out.edges)] });
        rp.setPipeline(pipe); rp.setBindGroup(0, group!); rp.draw(3); rp.end();
      },
      status: () => shown,
      dispose: () => { ubuf.destroy(); none.destroy(); },
    };
  },
});
