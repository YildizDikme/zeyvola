// Bundles the Electron main process and preload script with esbuild.
import { build, context } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const app = resolve(here, '..');
const watch = process.argv.includes('--watch');
// Distribution profile (src/shared/distribution.ts), same value as the renderer build.
const dist = process.env.ZEYVOLA_DIST ?? 'mp4';
if (!['mp4', 'webm', 'webm-vp8'].includes(dist)) throw new Error(`ZEYVOLA_DIST must be mp4, webm or webm-vp8, got ${dist}`);

const common = {
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  sourcemap: true,
  external: ['electron'],
  define: { __ZEYVOLA_DIST__: JSON.stringify(dist) },
  logLevel: 'info',
};

const configs = [
  { ...common, entryPoints: [resolve(app, 'src/main/main.ts')], outfile: resolve(app, 'dist/main/main.cjs') },
  { ...common, entryPoints: [resolve(app, 'src/preload/preload.ts')], outfile: resolve(app, 'dist/main/preload.cjs') },
];

if (watch) {
  for (const c of configs) await (await context(c)).watch();
} else {
  await Promise.all(configs.map((c) => build(c)));
}
