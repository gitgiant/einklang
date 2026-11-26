declare module 'virtual:lab-assets' {
  /** Declared piece assets: base64 bytes by path relative to lab/ (scripts/lab/vite-assets.ts). */
  const files: Record<string, string>;
  export default files;
}
