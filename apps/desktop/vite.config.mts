import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, 'src/renderer');
// Distribution profile (src/shared/distribution.ts): code for codecs a profile does not ship is dropped.
const dist = process.env.ZEYVOLA_DIST ?? 'mp4';
if (!['mp4', 'webm', 'webm-vp8'].includes(dist)) throw new Error(`ZEYVOLA_DIST must be mp4, webm or webm-vp8, got ${dist}`);

export default defineConfig({
  root,
  base: './',
  define: { __ZEYVOLA_DIST__: JSON.stringify(dist) },
  build: {
    outDir: resolve(here, 'dist/renderer'),
    emptyOutDir: true,
    target: 'chrome140',
    sourcemap: true,
    rollupOptions: {
      input: {
        index: resolve(root, 'index.html'),
        hud: resolve(root, 'hud.html'),
        capture: resolve(root, 'capture.html'),
      },
    },
  },
  oxc: { jsx: { runtime: 'automatic' } },
});
