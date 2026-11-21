import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // Listen on every interface so other devices on the LAN can reach the
    // dev server via the host's IP.
    host: true,
    proxy: {
      // Dev proxy so the browser only ever talks to the Vite origin.
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
    },
  },
  build: {
    target: 'es2022',
    outDir: 'dist',
    // No source maps in the served build: `bun run lan` serves dist/ to the
    // LAN, and `.map` files would hand anyone on the network the full
    // original client source. Debugging tip: run `bun run build` once with
    // `sourcemap: true` locally, then flip back before committing/serving.
    sourcemap: false,
    // Suppress the per-chunk file listing and the >500 kB chunk-size
    // warning so `bun run lan` (which builds before serving) stays quiet.
    reportCompressedSize: false,
    chunkSizeWarningLimit: Infinity,
  },
});
