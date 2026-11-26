import { definePiece, oklabToLinear, oklch, parseSheet, sheetTexture, type Palette } from '../../../api/index.ts';

/** The `sheet` enum's files (piece.json assets), in order. */
const SHEETS = ['dancer', 'sparkle', 'heart', 'note'].map((n) => `assets/sprites/${n}.spr`);

export default definePiece({
  gpu: ({ device, shader, asset }) => {
    const sheets = SHEETS.map((p) => { const s = parseSheet(asset(p)); return { s, tex: sheetTexture(device, s, p) }; });
    const mod = shader('sprite.wgsl');
    const pipe = device.createRenderPipeline({
      label: 'sprite', layout: 'auto',
      vertex: { module: mod, entryPoint: 'vs_full' },
      fragment: { module: mod, entryPoint: 'fs_sprite', targets: [{ format: 'rgba16float' }] },
    });
    const ubuf = device.createBuffer({ size: 64 + 128, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const groups = sheets.map((x) => device.createBindGroup({ layout: pipe.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: ubuf } }, { binding: 1, resource: x.tex.createView({ dimension: '2d-array' }) }] }));
    const data = new Float32Array(48);
    return {
      frame({ enc, out, params, audio, time, past, width, height, in: ins }) {
        const i = Math.min(sheets.length - 1, Math.max(0, Math.round(params.sheet as number))), { s } = sheets[i];
        // whole screen pixels per sprite pixel, so it stays crisp
        const scale = Math.max(1, Math.round(((params.size as number) * height) / s.h));
        const beats = (time * audio.bpm) / 60;
        // bass jump: the strongest of the last few ticks, eased
        let bass = 0;
        for (let a = 0; a < 8; a++) bass = Math.max(bass, (past(a).bands[0] + past(a).bands[1]) * 0.5 * (1 - a / 8));
        const pal = (ins.palette as Palette | undefined)?.stops ?? Array.from({ length: 6 }, (_, k) => oklch(0.75, 0.16, audio.pal + k / 6));
        data.set([width, height, s.w, s.h], 0);
        data.set([params.x as number, params.y as number, scale, params.mode as number], 4);
        data.set([Math.floor(beats * (params.per_beat as number)) % s.frames, s.frames, params.count as number, bass * (params.bounce as number) * s.h * scale * 0.4], 8);
        data.set([params.swap as number, params.outline as number, params.glow as number, time], 12);
        for (let k = 0; k < 8; k++) data.set([...oklabToLinear(pal[Math.floor((k * pal.length) / 8)]).map((c) => Math.max(0, c)), 1], 16 + k * 4);
        device.queue.writeBuffer(ubuf, 0, data);
        const rp = enc.beginRenderPass({ colorAttachments: [{ view: out.out.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 0] }] });
        rp.setPipeline(pipe); rp.setBindGroup(0, groups[i]); rp.draw(3); rp.end();
      },
      dispose: () => { ubuf.destroy(); for (const x of sheets) x.tex.destroy(); },
    };
  },
});
