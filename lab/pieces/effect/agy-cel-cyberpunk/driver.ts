// Cyberpunk cel-shading effect driver.
// Supports core-media (image/video/camera) and switches cleanly to an optional generator
// `fallback` input when no host media is picked (media.count() === 0).
import { definePiece, hexToOklab, type Palette } from '../../../api/index.ts';

/** How long an onset keeps driving chromatic tears and neon flashes (ticks at 60 Hz). */
const HIT_TICKS = 14;

/** Default city-night cyberpunk palette in OKLab: deep indigo -> violet -> magenta -> cyan -> acid yellow. */
const DEFAULT_PAL: [number, number, number][] = [
  '#060516', '#260a4f', '#ff007f', '#00f0ff', '#eaff00',
].map((h) => hexToOklab(h) ?? [0.5, 0, 0]);

export default definePiece({
  gpu: ({ device, shader, media }) => {
    const mod = shader('cel.wgsl');
    const pipe = device.createRenderPipeline({
      label: 'agy-cel-cyberpunk',
      layout: 'auto',
      vertex: { module: mod, entryPoint: 'vs_full' },
      fragment: { module: mod, entryPoint: 'fs_cel', targets: [{ format: 'rgba16float' }] },
    });
    const samp = device.createSampler({
      magFilter: 'linear',
      minFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
    });
    // 1x1 fallback textures for unwired optional ports
    const dummySrc = device.createTexture({
      size: [1, 1], format: 'rgba16float', usage: GPUTextureUsage.TEXTURE_BINDING, label: 'cel dummy src',
    });
    const dummyLuma = device.createTexture({
      size: [1, 1], format: 'r16float', usage: GPUTextureUsage.TEXTURE_BINDING, label: 'cel dummy luma',
    });
    const dummyEdges = device.createTexture({
      size: [1, 1], format: 'rg16float', usage: GPUTextureUsage.TEXTURE_BINDING, label: 'cel dummy edges',
    });

    // 18 vec4f = 72 floats = 288 bytes
    const ubuf = device.createBuffer({
      size: 72 * 4,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      label: 'agy-cel-cyberpunk',
    });
    const u = new Float32Array(72);

    let boundSrc: GPUTexture | null = null;
    let boundLuma: GPUTexture | null = null;
    let boundEdges: GPUTexture | null = null;
    let group: GPUBindGroup | null = null;

    return {
      frame({ enc, in: ins, out, params, audio, past, time, width, height }) {
        const fbTex = ins.fallback as GPUTexture | undefined;
        const useFallback = media.count() === 0 && Boolean(fbTex);
        const srcTex = (useFallback ? fbTex : (ins.in as GPUTexture | undefined)) ?? dummySrc;
        const lumaIn = useFallback ? undefined : (ins.luma as GPUTexture | undefined);
        const edgesIn = useFallback ? undefined : (ins.edges as GPUTexture | undefined);
        const lumaTex = lumaIn ?? dummyLuma;
        const edgesTex = edgesIn ?? dummyEdges;

        if (srcTex !== boundSrc || lumaTex !== boundLuma || edgesTex !== boundEdges) {
          boundSrc = srcTex;
          boundLuma = lumaTex;
          boundEdges = edgesTex;
          group = device.createBindGroup({
            layout: pipe.getBindGroupLayout(0),
            entries: [
              { binding: 0, resource: { buffer: ubuf } },
              { binding: 1, resource: samp },
              { binding: 2, resource: srcTex.createView() },
              { binding: 3, resource: lumaTex.createView() },
              { binding: 4, resource: edgesTex.createView() },
            ],
          });
        }

        // Smooth decaying onset hit envelope from history (pure over past ticks)
        let hit = 0;
        for (let a = 0; a < HIT_TICKS; a++) {
          if (past(a).onset) {
            const x = 1 - a / HIT_TICKS;
            hit = x * x;
            break;
          }
        }

        const bands = audio.bands;
        const bass = (bands[0] + bands[1] + bands[2]) / 3;
        const mid = (bands[4] + bands[5] + bands[6] + bands[7] + bands[8] + bands[9]) / 6;
        const high = (bands[11] + bands[12] + bands[13] + bands[14] + bands[15]) / 5;

        const aspect = width / Math.max(height, 1);
        u[0] = width; u[1] = height; u[2] = time; u[3] = aspect;
        u[4] = bass; u[5] = mid; u[6] = high; u[7] = audio.rms;
        u[8] = audio.onset ? 1 : 0; u[9] = hit; u[10] = audio.phase; u[11] = audio.bar;
        u[12] = params.bands as number;
        u[13] = params.neon_mix as number;
        u[14] = params.ink as number;
        u[15] = params.ink_glow as number;
        u[16] = params.rain as number;
        u[17] = params.scanlines as number;
        u[18] = params.glitch as number;
        u[19] = params.glow as number;

        const pal = ins.palette as Palette | undefined;
        const stops = pal && pal.stops.length > 0 ? pal.stops : DEFAULT_PAL;
        const count = Math.min(8, stops.length);
        u[20] = lumaIn ? 1 : 0;
        u[21] = edgesIn ? 1 : 0;
        u[22] = useFallback ? 1 : 0;
        u[23] = count;

        for (let i = 0; i < 16; i++) u[24 + i] = bands[i] ?? 0;

        for (let i = 0; i < 8; i++) {
          const s = stops[Math.min(i, count - 1)];
          const o = 40 + i * 4;
          u[o] = s[0];
          u[o + 1] = s[1];
          u[o + 2] = s[2];
          u[o + 3] = 0;
        }

        device.queue.writeBuffer(ubuf, 0, u);
        const rp = enc.beginRenderPass({
          colorAttachments: [{
            view: out.out.createView(),
            loadOp: 'clear',
            storeOp: 'store',
            clearValue: [0, 0, 0, 1],
          }],
        });
        rp.setPipeline(pipe);
        rp.setBindGroup(0, group!);
        rp.draw(3);
        rp.end();
      },
      dispose: () => {
        ubuf.destroy();
        dummySrc.destroy();
        dummyLuma.destroy();
        dummyEdges.destroy();
      },
    };
  },
});
