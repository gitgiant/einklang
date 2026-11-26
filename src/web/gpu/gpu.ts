import common from './shaders/common.wgsl?raw';


export interface Gpu { device: GPUDevice; format: GPUTextureFormat; adapterInfo: string }


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

const PRELUDE_LINES = common.split('\n').length;

/**
 * Compile a shader with the shared prelude (h32, hsv2rgb, fullscreen vertex). Errors are logged
 * against `file` when given: `skip` generated lines sit between the prelude and that file's text.
 */
export function shader(device: GPUDevice, code: string, label: string, file?: { name: string; skip: number }): GPUShaderModule {
  const m = device.createShaderModule({ code: common + '\n' + code, label });
  m.getCompilationInfo().then((ci) => {
    for (const msg of ci.messages) {
      if (msg.type !== 'error') continue;
      const line = msg.lineNum - PRELUDE_LINES - (file?.skip ?? 0);
      console.error(file && line > 0 ? `[${label}] ${file.name}:${line}:${msg.linePos} ${msg.message}` : `[${label}] ${msg.lineNum}:${msg.linePos} ${msg.message} (generated code)`);
    }
  });
  return m;
}

