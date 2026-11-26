import { definePiece, oklch, type Palette } from '../../../api/index.ts';

// Julia set / 2D mandelbox. Closed-form in (time, audio history): c circles the Mandelbrot boundary
// at `orbit`, smoothed bass pushes the radius out and mids lead the phase; the view rotates and
// breathes in and out (zoom); onsets flash the boundary glow.

const FLOATS = 24 + 8 * 4;

export default definePiece({
  gpu: ({ device, shader }) => {
    const mod = shader('julia.wgsl');
    const pipe = device.createRenderPipeline({
      label: 'claude-julia', layout: 'auto',
      vertex: { module: mod, entryPoint: 'vs_full' },
      fragment: { module: mod, entryPoint: 'fs_julia', targets: [{ format: 'rgba16float' }] },
    });
    const ubuf = device.createBuffer({ label: 'claude-julia u', size: FLOATS * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const bg = device.createBindGroup({ layout: pipe.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: ubuf } }] });
    const data = new Float32Array(FLOATS);
    let shown = '';

    return {
      frame({ enc, out, in: ins, params, audio, time, past, width, height }) {
        const W = 12;
        let bass = 0, mid = 0, kick = 0;
        for (let ago = 0; ago < W; ago++) {
          const f = past(ago);
          bass += (f.bands[0] + f.bands[1] + f.bands[2]) / (3 * W);
          mid += (f.bands[5] + f.bands[6] + f.bands[7] + f.bands[8]) / (4 * W);
        }
        for (let ago = 0; ago < 30; ago++) if (past(ago).onset) { kick = Math.max(kick, Math.exp(-ago / 7)); }

        const mode = Math.round(params.mode as number);
        const nudge = params.nudge as number;
        const bps = (audio.bpm > 0 ? audio.bpm : 120) / 60;
        // c: one turn every `period` seconds; the music bends radius and phase
        const th = (time / Math.max(1, params.period as number)) * Math.PI * 2 + (params.phase as number) * Math.PI * 2 + nudge * 0.35 * mid;
        const r = (params.orbit as number) + nudge * 0.035 * bass;
        const cx = r * Math.cos(th), cy = r * Math.sin(th);
        // zoom: base magnification, breathing over `breathe` beats (0 = still)
        const br = params.breathe as number;
        const z0 = Math.exp((params.zoom as number) * Math.log(60));
        const zoom = br > 0 ? z0 * Math.exp(Math.log(params.depth as number) * (0.5 - 0.5 * Math.cos((time * bps / br) * Math.PI * 2))) : z0;
        const rot = time * (params.spin as number) * Math.PI * 2;
        // mandelbox scale wanders slowly around `box`, the bass leans on it
        const box = (params.box as number) + 0.12 * Math.sin(time * 0.07) - nudge * 0.08 * bass;

        data.fill(0);
        data.set([width, height, width / height, time], 0);
        data.set([cx, cy, zoom, rot], 4);
        data.set([params.fx as number, params.fy as number, mode, Math.round(params.iters as number)], 8);
        const pal = (ins.palette as Palette | undefined)?.stops ?? Array.from({ length: 6 }, (_, i) => oklch(0.18 + i * 0.14, 0.15, audio.pal + i / 7));
        data.set([params.glow as number, kick * (params.flash as number), (time * bps / 16) * (params.cycle as number), Math.min(8, pal.length)], 12);
        data.set([box, params.edge as number, audio.rms, params.density as number], 16);
        data.set([params.aa ? 2 : 1, params.inner as number, 0, 0], 20);
        pal.slice(0, 8).forEach((s, i) => data.set(s, 24 + i * 4));
        device.queue.writeBuffer(ubuf, 0, data);
        shown = `${mode ? 'mandelbox' : 'julia'} c=${cx.toFixed(3)},${cy.toFixed(3)} x${zoom.toFixed(1)}`;

        const rp = enc.beginRenderPass({ colorAttachments: [{ view: out.out.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }] });
        rp.setPipeline(pipe); rp.setBindGroup(0, bg); rp.draw(3); rp.end();
      },
      dispose: () => ubuf.destroy(),
      status: () => shown,
    };
  },
});
