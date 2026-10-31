import { defineConfig } from 'vite';

export default defineConfig({
  root: 'client',
  publicDir: 'public',
  build: {
    outDir: '../dist',
    emptyOutDir: true,
    chunkSizeWarningLimit: 1000,
  },
  server: {
    port: 5173,
    host: true,
    // In development, the game server runs on :8080 and is reached through this proxy.
    proxy: {
      '/ws': { target: 'ws://localhost:8080', ws: true },
      '/health': 'http://localhost:8080',
    },
  },
});
