import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The Mini App frontend lives in web/ and builds to web/dist, which the Hono
// server (src/web/server.ts) serves as static assets in production. In dev,
// /rpc, /api and /config are proxied to the bot's in-process web server (run the
// bot with WEB_PORT=8080), so the typed oRPC client talks to the real API.
export default defineConfig({
  root: 'web',
  plugins: [react()],
  build: { outDir: 'dist', emptyOutDir: true },
  server: {
    port: 5173,
    proxy: {
      '/rpc': 'http://localhost:8080',
      '/api': 'http://localhost:8080',
      '/config': 'http://localhost:8080',
    },
  },
});
