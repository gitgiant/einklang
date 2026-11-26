import { defineConfig } from 'vite';
import { resolve } from 'node:path';

// Dev: Vite serves the page and proxies /ws and /track to the Node server (npm run server).
export default defineConfig({
  server: {
    host: '127.0.0.1', // like the server: localhost only (use `tailscale serve 5173` for other devices)
    proxy: {
      '/ws': { target: 'ws://localhost:8080', ws: true },
      '/track': 'http://localhost:8080',
    },
  },
  build: {
    target: 'es2022',
    rollupOptions: { input: { main: resolve(import.meta.dirname, 'index.html'), gallery: resolve(import.meta.dirname, 'gallery.html') } },
  },
});
