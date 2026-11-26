import common from './shaders/common.wgsl?raw';
import { W, H } from '../../core/constants.ts';

export interface Gpu { device: GPUDevice; format: GPUTextureFormat; adapterInfo: string }

export const HDR: GPUTextureFormat = 'rgba16float';

export async function initGpu(): Promise<Gpu> {
  if (!navigator.gpu) throw new Error('WebGPU is not available here. Open this page in desktop Chrome or Edge (113+).');
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) throw new Error('No WebGPU adapter found.');
  const device = await adapter.requestDevice();
  device.lost.then((i) => console.error('WebGPU device lost:', i.message));
  device.addEventListener('uncapturederror', (e) => console.error('WebGPU:', (e as GPUUncapturedErrorEvent).error.message));
  const info = adapter.info;
  return { device, format: navigator.gpu.getPreferredCanvasFormat(), adapterInfo: [info.vendor, info.architecture, info.description].filter(Boolean).join(' ') };
}

/** Compile a shader with the shared prelude (h32, hsv2rgb, fullscreen vertex). */
export function shader(device: GPUDevice, code: string, label: string): GPUShaderModule {
  const m = device.createShaderModule({ code: common + '\n' + code, label });
  m.getCompilationInfo().then((ci) => { for (const msg of ci.messages) if (msg.type === 'error') console.error(`[${label}] ${msg.lineNum}:${msg.linePos} ${msg.message}`); });
  return m;
}

/** Letterbox mapping from the virtual W x H canvas into a target of size (tw, th). */
export function letterbox(tw: number, th: number): { scale: number; ox: number; oy: number } {
  const scale = Math.min(tw / W, th / H);
  return { scale, ox: (tw - W * scale) / 2, oy: (th - H * scale) / 2 };
}
