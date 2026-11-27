// A two-texture mix pass for drivers: out = blend(a, b, w, mode). core-switch and core-crossfade use
// it; any piece may. Missing inputs read as black. The pipeline compiles in the background
// (createRenderPipelineAsync) and is made on the spot only if a frame needs it before then.
import type { GpuInit } from './index.ts';

/** Blend modes: how b comes in over a as w goes 0 -> 1 (w = 0 is a, w = 1 is the blend's full result). */
export const MIX_MODES = ['mix', 'add', 'screen', 'multiply', 'difference', 'lighten', 'darken', 'over'] as const;

const WGSL = /* wgsl */ `
struct MixU { w: f32, mode: u32, has_a: u32, has_b: u32 }
@group(0) @binding(0) var<uniform> mu: MixU;
@group(0) @binding(1) var ms: sampler;
@group(0) @binding(2) var ma: texture_2d<f32>;
@group(0) @binding(3) var mb: texture_2d<f32>;
@fragment fn fs_mix(in: VOut) -> @location(0) vec4f {
  let a = select(vec4f(0.0, 0.0, 0.0, 1.0), textureSampleLevel(ma, ms, in.uv, 0.0), mu.has_a == 1u);
  let b = select(vec4f(0.0, 0.0, 0.0, 1.0), textureSampleLevel(mb, ms, in.uv, 0.0), mu.has_b == 1u);
  let ca = a.rgb; let cb = b.rgb; let w = clamp(mu.w, 0.0, 1.0);
  var full = cb;
  switch (mu.mode) {
    case 1u: { full = ca + cb; }
    case 2u: { full = 1.0 - (1.0 - clamp(ca, vec3f(0.0), vec3f(1.0))) * (1.0 - clamp(cb, vec3f(0.0), vec3f(1.0))); }
    case 3u: { full = ca * cb; }
    case 4u: { full = abs(ca - cb); }
    case 5u: { full = max(ca, cb); }
    case 6u: { full = min(ca, cb); }
    case 7u: { full = ca * (1.0 - b.a) + cb; }
    default: {}
  }
  return vec4f(mix(ca, full, w), 1.0);
}
`;

export interface MixPass {
  /** Encode out = blend(a, b, w, mode) (mode: index into MIX_MODES). */
  draw(enc: GPUCommandEncoder, out: GPUTexture, a: GPUTexture | undefined, b: GPUTexture | undefined, w: number, mode: number): void;
  dispose(): void;
}

export function mixPass(init: GpuInit): MixPass {
  const { device: d } = init, F = GPUShaderStage.FRAGMENT;
  const mod = init.compile(WGSL, 'mixpass');
  const bgl = d.createBindGroupLayout({
    label: 'mixpass',
    entries: [
      { binding: 0, visibility: F, buffer: { type: 'uniform' } }, { binding: 1, visibility: F, sampler: {} },
      { binding: 2, visibility: F, texture: {} }, { binding: 3, visibility: F, texture: {} },
    ],
  });
  const desc: GPURenderPipelineDescriptor = {
    label: 'mixpass', layout: d.createPipelineLayout({ bindGroupLayouts: [bgl] }),
    vertex: { module: mod, entryPoint: 'vs_full' },
    fragment: { module: mod, entryPoint: 'fs_mix', targets: [{ format: init.formats.tex }] },
  };
  let pipe: GPURenderPipeline | null = null;
  d.createRenderPipelineAsync(desc).then((p) => { pipe ??= p; }).catch((e: Error) => console.error(`[mixpass] ${e.message}`));
  const samp = d.createSampler({ magFilter: 'linear', minFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' });
  const black = d.createTexture({ size: [1, 1], format: init.formats.tex, usage: GPUTextureUsage.TEXTURE_BINDING, label: 'mixpass.black' });
  const ubuf = d.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const buf = new ArrayBuffer(16), f = new Float32Array(buf), u = new Uint32Array(buf);
  let bg: GPUBindGroup | null = null, bgA: GPUTexture | null = null, bgB: GPUTexture | null = null;
  return {
    draw(enc, out, a, b, w, mode) {
      f[0] = w; u[1] = mode >>> 0; u[2] = a ? 1 : 0; u[3] = b ? 1 : 0;
      d.queue.writeBuffer(ubuf, 0, buf);
      const A = a ?? black, B = b ?? black;
      if (!bg || A !== bgA || B !== bgB) {
        bgA = A; bgB = B;
        bg = d.createBindGroup({ layout: bgl, entries: [
          { binding: 0, resource: { buffer: ubuf } }, { binding: 1, resource: samp },
          { binding: 2, resource: A.createView() }, { binding: 3, resource: B.createView() },
        ] });
      }
      const rp = enc.beginRenderPass({ colorAttachments: [{ view: out.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }] });
      rp.setPipeline((pipe ??= d.createRenderPipeline(desc))); rp.setBindGroup(0, bg); rp.draw(3); rp.end();
    },
    dispose: () => { ubuf.destroy(); black.destroy(); },
  };
}
