import { definePiece, oklabToLinear, oklch, parseVox, voxWorld, type Palette } from '../../../api/index.ts';

/** The `model` enum's files, in order (declared in piece.json `assets`). */
const MODELS = ['fighter.vox', 'bomber.vox', 'corvette.vox', 'agent-ship/shrikeTerran.vox'].map((f) => `assets/vox/${f}`);
const UBYTES = 64 + 16 * 3 + 16 * 4 + 16 * 8;

/** Voxels -> storage data: per voxel [x, y, z, band] [r, g, b, seed], y-up, centred, hull length 1. */
function pack(bytes: Uint8Array): { data: Float32Array; count: number; inv: number } {
  const f = parseVox(bytes), w = voxWorld(f);
  const ext = [0, 1, 2].map((k) => w.max[k] - w.min[k] + 1), L = Math.max(...ext), long = ext.indexOf(L);
  const mid = [0, 1, 2].map((k) => (w.min[k] + w.max[k] + 1) / 2);
  const data = new Float32Array(w.count * 8);
  for (let i = 0; i < w.count; i++) {
    const v = [0, 1, 2].map((k) => (w.pos[i * 3 + k] + 0.5 - mid[k]) / L);
    const [r, g, b] = f.palette[w.color[i]];
    // vox is z-up: world (x, z, -y)
    data.set([v[0], v[2], -v[1], Math.min(15, Math.floor(((w.pos[i * 3 + long] - w.min[long]) / L) * 16))], i * 8);
    const seed = ((Math.imul(i + 1, 2654435761) >>> 8) & 0xffff) / 0xffff;
    data.set([(r / 255) ** 2.2, (g / 255) ** 2.2, (b / 255) ** 2.2, seed], i * 8 + 4);
  }
  return { data, count: w.count, inv: 1 / L };
}

function perspective(fovy: number, aspect: number, near: number, far: number): number[] {
  const f = 1 / Math.tan(fovy / 2), nf = 1 / (near - far);
  return [f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, far * nf, -1, 0, 0, near * far * nf, 0];
}
function lookAt(eye: number[], at: number[]): number[] {
  const sub = (a: number[], b: number[]) => a.map((x, i) => x - b[i]);
  const norm = (a: number[]) => { const l = Math.hypot(...a); return a.map((x) => x / l); };
  const cross = (a: number[], b: number[]) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const z = norm(sub(eye, at)), x = norm(cross([0, 1, 0], z)), y = cross(z, x);
  return [x[0], y[0], z[0], 0, x[1], y[1], z[1], 0, x[2], y[2], z[2], 0, -dot(x, eye), -dot(y, eye), -dot(z, eye), 1];
}
const mul4 = (a: number[], b: number[]) => Array.from({ length: 16 }, (_, i) => {
  const c = Math.floor(i / 4), r = i % 4;
  return a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
});

export default definePiece({
  gpu: ({ device, shader, asset }) => {
    const mod = shader('ship.wgsl');
    const ships = MODELS.map((p) => {
      const s = pack(asset(p));
      const buf = device.createBuffer({ label: `vox-ship ${p}`, size: s.data.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
      device.queue.writeBuffer(buf, 0, s.data);
      return { buf, count: s.count, inv: s.inv };
    });
    const ubuf = device.createBuffer({ label: 'vox-ship', size: UBYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const stars = device.createRenderPipeline({
      label: 'vox-ship stars', layout: 'auto',
      vertex: { module: mod, entryPoint: 'vs_full' },
      fragment: { module: mod, entryPoint: 'fs_stars', targets: [{ format: 'rgba16float' }] },
      // same pass as the cubes, so it declares the depth attachment (without testing or writing it)
      depthStencil: { format: 'depth24plus', depthWriteEnabled: false, depthCompare: 'always' },
    });
    const cubes = device.createRenderPipeline({
      label: 'vox-ship cubes', layout: 'auto',
      vertex: { module: mod, entryPoint: 'vs_cube' },
      fragment: { module: mod, entryPoint: 'fs_cube', targets: [{ format: 'rgba16float' }] },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: { format: 'depth24plus', depthWriteEnabled: true, depthCompare: 'less' },
    });
    const starsBg = device.createBindGroup({ layout: stars.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: ubuf } }] });
    const cubeBg = ships.map((s) => device.createBindGroup({ layout: cubes.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: ubuf } }, { binding: 1, resource: { buffer: s.buf } }] }));
    let depth: GPUTexture | null = null;
    const data = new Float32Array(UBYTES / 4);
    let shown = 0;
    return {
      frame({ enc, out, in: ins, params, audio, time, past, width, height }) {
        const target = out.out, aspect = width / height;
        if (!depth || depth.width !== width || depth.height !== height) {
          depth?.destroy();
          depth = device.createTexture({ label: 'vox-ship depth', size: [width, height], format: 'depth24plus', usage: GPUTextureUsage.RENDER_ATTACHMENT });
        }
        shown = Math.min(ships.length - 1, Math.max(0, Math.round(params.model as number)));
        const ship = ships[shown];
        // camera: orbit (turns per 16 beats), gentle bob
        const bps = (audio.bpm > 0 ? audio.bpm : 120) / 60;
        const ang = time * bps / 16 * (params.spin as number) * 2 * Math.PI + 0.6;
        const eye = [Math.sin(ang) * 0.95, 0.3 + 0.06 * Math.sin(time * 0.37), Math.cos(ang) * 0.95];
        const vp = mul4(perspective(0.75, aspect, 0.05, 10), lookAt(eye, [0, 0, 0]));
        // onset kick: decays over ~0.3 s
        let kick = 0;
        for (let ago = 0; ago < 24; ago++) if (past(ago).onset) kick = Math.max(kick, Math.exp(-ago / 6));
        const pal = (ins.palette as Palette | undefined)?.stops ?? Array.from({ length: 6 }, (_, i) => oklch(0.72, 0.15, audio.pal + i / 6));
        data.set(vp, 0);
        data.set([time, audio.rms, params.shatter as number, params.glow as number], 16);
        data.set([params.tint as number, params.stars as number, aspect, kick], 20);
        data.set([eye[0], eye[1], eye[2], ship.inv], 24);
        data.set(audio.bands.subarray(0, 16), 28);
        for (let i = 0; i < 8; i++) data.set([...oklabToLinear(pal[Math.floor((i * pal.length) / 8)]).map((c) => Math.max(0, c)), 1], 44 + i * 4);
        device.queue.writeBuffer(ubuf, 0, data);
        const rp = enc.beginRenderPass({
          colorAttachments: [{ view: target.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }],
          depthStencilAttachment: { view: depth.createView(), depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'discard' },
        });
        rp.setPipeline(stars); rp.setBindGroup(0, starsBg); rp.draw(3);
        rp.setPipeline(cubes); rp.setBindGroup(0, cubeBg[shown]); rp.draw(36, ship.count);
        rp.end();
      },
      dispose: () => { ubuf.destroy(); depth?.destroy(); for (const s of ships) s.buf.destroy(); },
      status: () => `${MODELS[shown].split('/').pop()} ${ships[shown].count} voxels`,
    };
  },
});
