import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * The client is a plain Vite SPA. In development it runs on its own port and
 * proxies `/api` (including the SSE stream) to the Hono server; in production
 * the Hono server serves the built assets from `dist/client`.
 */
const apiPort = Number(process.env.PORT ?? process.env.API_PORT ?? 4317);

export default defineConfig({
  root: fileURLToPath(new URL('./src/client', import.meta.url)),
  plugins: [react()],
  server: {
    port: Number(process.env.WEB_PORT ?? 4318),
    strictPort: false,
    proxy: {
      '/api': {
        target: `http://127.0.0.1:${apiPort}`,
        changeOrigin: true,
        // SSE must not be buffered by the dev proxy.
        configure: (proxy) => {
          proxy.on('proxyRes', (proxyRes) => {
            if (proxyRes.headers['content-type']?.includes('text/event-stream')) {
              proxyRes.headers['cache-control'] = 'no-cache, no-transform';
            }
          });
        },
      },
    },
  },
  build: {
    outDir: fileURLToPath(new URL('./dist/client', import.meta.url)),
    emptyOutDir: true,
    sourcemap: true,
  },
});
