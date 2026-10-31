import { defineConfig } from 'vite';

export default defineConfig({
  root: 'client',
  // Relative asset URLs so the build works under any path (e.g. GitHub Pages
  // project sites at /pacman-coop/) as well as at a domain root.
  base: './',
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
