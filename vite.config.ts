import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Dev: plain Vite server. Build: everything (JS, CSS, fonts) is inlined into a
// single dist/index.html that runs by double-clicking — no server, no network.
export default defineConfig(({ command }) => ({
  // keep Vite's dependency cache out of the OneDrive-synced project folder
  cacheDir: join(tmpdir(), 'neon-rush-vite-cache'),
  plugins: command === 'build' ? [viteSingleFile({ removeViteModuleLoader: true })] : [],
  server: { port: 5173, strictPort: true },
  preview: { port: 4188, strictPort: true },
  build: {
    target: 'es2022',
    assetsInlineLimit: 100_000_000,
    chunkSizeWarningLimit: 4000,
    cssCodeSplit: false,
    reportCompressedSize: false,
  },
}));
