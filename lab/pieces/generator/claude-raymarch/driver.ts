import { definePiece, oklch, type Palette } from '../../../api/index.ts';

// SDF fly-through. The camera's distance along the tube is integrated per frame (host-local float
// state, not synced): a base speed, a surge at the start of every beat and a push from the bass.
// The march renders at `scale` of the output and is upscaled with a bilinear pass.

const FLOATS = 44 + 8 * 4;

/** Must match path() in march.wgsl. */
const path = (z: number): [number, number] => [Math.sin(z * 0.11) * 1.6 + Math.sin(z * 0.037) * 1.2, Math.cos(z * 0.09) * 0.9];
const norm = (a: number[]) => { const l = Math.hypot(...a) || 1; return a.map((x) => x / l); };
const cross = (a: number[], b: number[]) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

export default definePiece({
  gpu: ({ device, shader }) => {
    const mod = shader('march.wgsl');
    const march = device.createRenderPipeline({
      label: 'claude-raymarch march', layout: 'auto',
      vertex: { module: mod, entryPoint: 'vs_full' },
      fragment: { module: mod, entryPoint: 'fs_march', targets: [{ format: 'rgba16float' }] },
    });
    const up = device.createRenderPipeline({
      label: 'claude-raymarch up', layout: 'auto',
      vertex: { module: mod, entryPoint: 'vs_full' },
      fragment: { module: mod, entryPoint: 'fs_up', targets: [{ format: 'rgba16float' }] },
    });
    const ubuf = device.createBuffer({ label: 'claude-raymarch u', size: FLOATS * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const marchBg = device.createBindGroup({ layout: march.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: ubuf } }] });
    const samp = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });
    const data = new Float32Array(FLOATS);
    let low: GPUTexture | null = null, upBg: GPUBindGroup | null = null;
    let z = 0, lastTime = NaN;

    return {
      frame({ enc, out, in: ins, params, audio, time, past, width, height }) {
        const sc = Math.min(1, Math.max(0.25, params.scale as number));
        const lw = Math.max(16, Math.round(width * sc)), lh = Math.max(16, Math.round(height * sc));
        if (!low || low.width !== lw || low.height !== lh) {
          low?.destroy();
          low = device.createTexture({ label: 'claude-raymarch low', size: [lw, lh], format: 'rgba16float', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING });
          upBg = device.createBindGroup({ layout: up.getBindGroupLayout(0), entries: [{ binding: 1, resource: low.createView() }, { binding: 2, resource: samp }] });
        }

        const bass = (audio.bands[0] + audio.bands[1] + audio.bands[2]) / 3;
        let kick = 0;
        for (let ago = 0; ago < 30; ago++) if (past(ago).onset) kick = Math.max(kick, Math.exp(-ago / 8));
        // speed: cells per second; the surge peaks right on the beat and eases out over it
        const surge = (1 - audio.phase) ** 4;
        const speed = (params.speed as number) * (1 + (params.surge as number) * surge + 1.2 * bass);
        const dt = Number.isFinite(lastTime) ? Math.min(0.1, Math.max(0, time - lastTime)) : 0;
        if (!Number.isFinite(lastTime) || time < lastTime) z = time * (params.speed as number);
        z += dt * speed;
        lastTime = time;

        const [ex, ey] = path(z), [tx, ty] = path(z + 3);
        const eye = [ex, ey, z], fwd = norm([tx - ex, ty - ey, 3]);
        const roll = 0.35 * Math.sin(time * 0.13) + 0.25 * (tx - ex) + 0.08 * kick * Math.sin(time * 7);
        const r0 = norm(cross(fwd, [0, 1, 0])), u0 = cross(r0, fwd);
        const right = r0.map((x, i) => x * Math.cos(roll) + u0[i] * Math.sin(roll));
        const upv = u0.map((x, i) => x * Math.cos(roll) - r0[i] * Math.sin(roll));

        const pal = (ins.palette as Palette | undefined)?.stops ?? Array.from({ length: 6 }, (_, i) => oklch(0.4 + i * 0.08, 0.15, audio.pal + i / 6));
        data.fill(0);
        data.set([lw, lh, time, width / height], 0);
        data.set([...eye, 1.1 + 0.15 * kick], 4);
        data.set(right, 8); data.set(upv, 12); data.set(fwd, 16);
        data.set([bass, kick, params.morph as number, params.glow as number], 20);
        data.set([params.fog as number, audio.rms, Math.min(8, pal.length), params.tunnel as number], 24);
        data.set(audio.bands.subarray(0, 16), 28);
        pal.slice(0, 8).forEach((s, i) => data.set(s, 44 + i * 4));
        device.queue.writeBuffer(ubuf, 0, data);

        let rp = enc.beginRenderPass({ colorAttachments: [{ view: low.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }] });
        rp.setPipeline(march); rp.setBindGroup(0, marchBg); rp.draw(3); rp.end();
        rp = enc.beginRenderPass({ colorAttachments: [{ view: out.out.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }] });
        rp.setPipeline(up); rp.setBindGroup(0, upBg!); rp.draw(3); rp.end();
      },
      dispose: () => { ubuf.destroy(); low?.destroy(); },
      status: () => `z ${z.toFixed(1)}`,
    };
  },
});
