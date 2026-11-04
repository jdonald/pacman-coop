import { defineConfig } from 'vite';
import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';

/** Emits sw.js with a precache list of every built file (offline-first PWA). */
function serviceWorker() {
  return {
    name: 'pcoop-service-worker',
    apply: 'build',
    generateBundle(_, bundle) {
      const files = [...Object.keys(bundle), ...readdirSync('client/public')].filter((f) => f !== 'sw.js');
      const h = createHash('sha1');
      for (const f of files.sort()) h.update(f).update(String(bundle[f]?.code ?? bundle[f]?.source ?? ''));
      const version = h.digest('hex').slice(0, 10);
      const source = readFileSync('client/sw.js', 'utf8')
        .replace("'__VERSION__'", JSON.stringify(version))
        .replace('__PRECACHE__', JSON.stringify(['./', ...files]));
      this.emitFile({ type: 'asset', fileName: 'sw.js', source });
    },
  };
}

export default defineConfig({
  root: 'client',
  plugins: [serviceWorker()],
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
