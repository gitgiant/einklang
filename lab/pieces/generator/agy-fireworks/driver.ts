import { definePiece, oklabToLinear, oklch, type Palette } from '../../../api/index.ts';

const MAX_PARTICLES = 16384;
// SimU: 6 vec4fs = 96 bytes
const SIM_UBYTES = 6 * 16;
// DrawU: 6 vec4fs = 96 bytes
const DRAW_UBYTES = 6 * 16;

const ADD_BLEND: GPUBlendState = {
  color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
  alpha: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
};

function samplePaletteAt(pal: Palette | undefined, t: number, fallbackHue: number): [number, number, number] {
  const stops = pal?.stops?.length
    ? pal.stops
    : Array.from({ length: 6 }, (_, i) => oklch(0.78, 0.2, (fallbackHue + i * 0.16) % 1));
  const n = stops.length;
  const wrapped = ((t % 1) + 1) % 1;
  const pos = wrapped * (n - 1);
  const a = Math.min(n - 1, Math.floor(pos));
  const b = Math.min(n - 1, a + 1);
  const f = pos - a;
  const lab: [number, number, number] = [
    stops[a][0] + (stops[b][0] - stops[a][0]) * f,
    stops[a][1] + (stops[b][1] - stops[a][1]) * f,
    stops[a][2] + (stops[b][2] - stops[a][2]) * f,
  ];
  const rgb = oklabToLinear(lab);
  return [Math.max(0.02, rgb[0]), Math.max(0.02, rgb[1]), Math.max(0.02, rgb[2])];
}

export default definePiece({
  gpu: ({ device, shader }) => {
    const simMod = shader('sim.wgsl');
    const drawMod = shader('draw.wgsl');

    const simBuf = device.createBuffer({
      label: 'fireworks-sim-u',
      size: SIM_UBYTES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    const drawBuf = device.createBuffer({
      label: 'fireworks-draw-u',
      size: DRAW_UBYTES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    // 3 vec4fs (48 bytes) per particle
    const ptsBuf = device.createBuffer({
      label: 'fireworks-pts',
      size: MAX_PARTICLES * 48,
      usage: GPUBufferUsage.STORAGE,
    });

    const csBgl = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
      ],
    });
    const csLayout = device.createPipelineLayout({ bindGroupLayouts: [csBgl] });
    const clearPipe = device.createComputePipeline({
      label: 'fireworks-clear',
      layout: csLayout,
      compute: { module: simMod, entryPoint: 'cs_clear' },
    });
    const stepPipe = device.createComputePipeline({
      label: 'fireworks-step',
      layout: csLayout,
      compute: { module: simMod, entryPoint: 'cs_step' },
    });
    const csBind = device.createBindGroup({
      layout: csBgl,
      entries: [
        { binding: 0, resource: { buffer: simBuf } },
        { binding: 1, resource: { buffer: ptsBuf } },
      ],
    });

    const sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });

    const fadePipe = device.createRenderPipeline({
      label: 'fireworks-fade',
      layout: 'auto',
      vertex: { module: drawMod, entryPoint: 'vs_full' },
      fragment: { module: drawMod, entryPoint: 'fs_fade', targets: [{ format: 'rgba16float' }] },
    });
    const sparkPipe = device.createRenderPipeline({
      label: 'fireworks-spark',
      layout: 'auto',
      vertex: { module: drawMod, entryPoint: 'vs_spark' },
      fragment: {
        module: drawMod,
        entryPoint: 'fs_spark',
        targets: [{ format: 'rgba16float', blend: ADD_BLEND }],
      },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
    });
    const composePipe = device.createRenderPipeline({
      label: 'fireworks-compose',
      layout: 'auto',
      vertex: { module: drawMod, entryPoint: 'vs_full' },
      fragment: { module: drawMod, entryPoint: 'fs_compose', targets: [{ format: 'rgba16float' }] },
    });

    const sparkBind = device.createBindGroup({
      layout: sparkPipe.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: drawBuf } },
        { binding: 3, resource: { buffer: ptsBuf } },
      ],
    });

    let texW = 0;
    let texH = 0;
    let trailTex: [GPUTexture, GPUTexture] | null = null;
    let fadeBinds: [GPUBindGroup, GPUBindGroup] | null = null;
    let composeBinds: [GPUBindGroup, GPUBindGroup] | null = null;
    let ping = 0;

    function ensureTrails(w: number, h: number) {
      if (trailTex && texW === w && texH === h) return;
      trailTex?.[0].destroy();
      trailTex?.[1].destroy();
      texW = w;
      texH = h;
      const make = (label: string) =>
        device.createTexture({
          label,
          size: [w, h],
          format: 'rgba16float',
          usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
        });
      trailTex = [make('fireworks-trail-a'), make('fireworks-trail-b')];
      fadeBinds = [
        device.createBindGroup({
          layout: fadePipe.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: { buffer: drawBuf } },
            { binding: 1, resource: trailTex[0].createView() },
            { binding: 2, resource: sampler },
          ],
        }),
        device.createBindGroup({
          layout: fadePipe.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: { buffer: drawBuf } },
            { binding: 1, resource: trailTex[1].createView() },
            { binding: 2, resource: sampler },
          ],
        }),
      ];
      composeBinds = [
        device.createBindGroup({
          layout: composePipe.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: { buffer: drawBuf } },
            { binding: 1, resource: trailTex[0].createView() },
            { binding: 2, resource: sampler },
          ],
        }),
        device.createBindGroup({
          layout: composePipe.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: { buffer: drawBuf } },
            { binding: 1, resource: trailTex[1].createView() },
            { binding: 2, resource: sampler },
          ],
        }),
      ];
    }

    const simData = new Float32Array(SIM_UBYTES / 4);
    const drawData = new Float32Array(DRAW_UBYTES / 4);

    let initialized = false;
    let lastTick = -1;
    let ringHead = 0;
    let burstSeq = 0;
    let ticksSinceBurst = 999;
    let flashStrength = 0;
    let flashX = 0;
    let flashY = 0.2;
    let flashCol: [number, number, number] = [1, 0.8, 0.5];

    return {
      frame({ enc, out, in: ins, params, audio, tick, time, width, height, rand }) {
        ensureTrails(width, height);
        const asp = width / Math.max(1, height);

        const burstScale = params.burst_scale as number;
        const gravity = params.gravity as number;
        const trailsDecay = params.trails as number;
        const sparkle = params.sparkle as number;
        const gain = params.gain as number;
        const pal = ins.palette as Palette | undefined;

        const bass = (audio.bands[0] + audio.bands[1] + audio.bands[2]) / 3;
        const treble =
          (audio.bands[10] + audio.bands[11] + audio.bands[12] + audio.bands[13] + audio.bands[14]) / 5;
        const loudness = Math.min(1.8, Math.max(0.18, audio.rms * 1.35 + bass * 0.75 + treble * 0.25));

        if (!initialized) {
          const cp = enc.beginComputePass();
          cp.setPipeline(clearPipe);
          cp.setBindGroup(0, csBind);
          cp.dispatchWorkgroups(MAX_PARTICLES / 128);
          cp.end();
          initialized = true;
          // Clear both trail targets once
          for (let i = 0; i < 2; i++) {
            const rp = enc.beginRenderPass({
              colorAttachments: [
                {
                  view: trailTex![i].createView(),
                  loadOp: 'clear',
                  clearValue: { r: 0, g: 0, b: 0, a: 1 },
                  storeOp: 'store',
                },
              ],
            });
            rp.end();
          }
        }

        const isNewTick = tick !== lastTick;
        if (isNewTick) {
          const dtTicks = lastTick < 0 ? 1 : Math.min(4, Math.max(1, tick - lastTick));
          const dt = dtTicks / 60;
          lastTick = tick;
          ticksSinceBurst += dtTicks;
          flashStrength *= Math.pow(0.84, dtTicks);

          // Spawn a firework burst on onset (with brief 3-tick debounce) or gentle ambient cadence on quiet tracks
          const onsetFire = audio.onset && ticksSinceBurst >= 3;
          const ambientFire = ticksSinceBurst >= 52;
          let spawnStart = 0;
          let spawnCount = 0;
          let bx = 0;
          let by = 0.2;
          let bSpd = 0.8;
          let bSize = 1.0;
          let bLife = 1.3;
          let bShape = 0;
          let colA: [number, number, number] = [1, 0.8, 0.4];
          let colB: [number, number, number] = [0.4, 0.8, 1];

          if (onsetFire || ambientFire) {
            burstSeq += 1;
            ticksSinceBurst = 0;

            const amp = onsetFire ? loudness : Math.max(0.24, loudness * 0.75);
            spawnCount = Math.round(Math.min(720, Math.max(220, 200 + amp * 340)));
            spawnStart = ringHead;
            ringHead = (ringHead + spawnCount) % MAX_PARTICLES;

            // Well-framed upper/mid sky burst position
            bx = (rand(burstSeq, 11) * 2 - 1) * asp * 0.72;
            by = -0.14 + rand(burstSeq, 23) * 0.8;
            bSpd = (0.48 + amp * 0.72) * burstScale;
            bSize = (0.72 + amp * 0.65) * Math.sqrt(burstScale);
            bLife = 1.05 + amp * 0.65 + rand(burstSeq, 37) * 0.35;
            bShape = Math.floor(rand(burstSeq, 47) * 5);

            const palPos = (burstSeq * 0.29 + audio.bar * 0.12 + rand(burstSeq, 61) * 0.15) % 1;
            colA = samplePaletteAt(pal, palPos, 0.08 + burstSeq * 0.13);
            colB = samplePaletteAt(pal, (palPos + 0.36) % 1, 0.58 + burstSeq * 0.13);

            flashX = bx;
            flashY = by;
            flashCol = colA;
            flashStrength = Math.min(1.3, 0.35 + amp * 0.65);
          }

          simData[0] = dt;
          simData[1] = gravity;
          simData[2] = time;
          simData[3] = sparkle;
          simData[4] = spawnStart;
          simData[5] = spawnCount;
          simData[6] = bx;
          simData[7] = by;
          simData[8] = bSpd;
          simData[9] = bSize;
          simData[10] = bLife;
          simData[11] = bShape;
          simData[12] = burstSeq;
          simData[13] = loudness;
          simData[14] = treble;
          simData[15] = 0.82;
          simData[16] = colA[0];
          simData[17] = colA[1];
          simData[18] = colA[2];
          simData[19] = 1;
          simData[20] = colB[0];
          simData[21] = colB[1];
          simData[22] = colB[2];
          simData[23] = 1;

          device.queue.writeBuffer(simBuf, 0, simData);

          const cp = enc.beginComputePass();
          cp.setPipeline(stepPipe);
          cp.setBindGroup(0, csBind);
          cp.dispatchWorkgroups(MAX_PARTICLES / 128);
          cp.end();
        }

        const skyCol = samplePaletteAt(pal, 0.15, 0.68);
        drawData[0] = width;
        drawData[1] = height;
        drawData[2] = asp;
        drawData[3] = time;
        drawData[4] = trailsDecay;
        drawData[5] = gravity;
        drawData[6] = gain;
        drawData[7] = sparkle;
        drawData[8] = audio.rms;
        drawData[9] = bass;
        drawData[10] = treble;
        drawData[11] = flashStrength;
        drawData[12] = flashX;
        drawData[13] = flashY;
        drawData[14] = 0;
        drawData[15] = 0;
        drawData[16] = flashCol[0];
        drawData[17] = flashCol[1];
        drawData[18] = flashCol[2];
        drawData[19] = 1;
        drawData[20] = skyCol[0];
        drawData[21] = skyCol[1];
        drawData[22] = skyCol[2];
        drawData[23] = 1;

        device.queue.writeBuffer(drawBuf, 0, drawData);

        // Ping-pong trail update: fade prev -> additively draw live sparks into dst
        const src = ping;
        const dst = 1 - ping;
        ping = dst;

        const tp = enc.beginRenderPass({
          colorAttachments: [
            {
              view: trailTex![dst].createView(),
              loadOp: 'clear',
              clearValue: { r: 0, g: 0, b: 0, a: 1 },
              storeOp: 'store',
            },
          ],
        });
        tp.setPipeline(fadePipe);
        tp.setBindGroup(0, fadeBinds![src]);
        tp.draw(3);
        tp.setPipeline(sparkPipe);
        tp.setBindGroup(0, sparkBind);
        tp.draw(6, MAX_PARTICLES);
        tp.end();

        // Final composite over starry twilight sky
        const cp = enc.beginRenderPass({
          colorAttachments: [
            {
              view: out.out.createView(),
              loadOp: 'clear',
              clearValue: { r: 0, g: 0, b: 0, a: 1 },
              storeOp: 'store',
            },
          ],
        });
        cp.setPipeline(composePipe);
        cp.setBindGroup(0, composeBinds![dst]);
        cp.draw(3);
        cp.end();
      },
      dispose() {
        simBuf.destroy();
        drawBuf.destroy();
        ptsBuf.destroy();
        trailTex?.[0].destroy();
        trailTex?.[1].destroy();
      },
    };
  },
});
