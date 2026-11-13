// Puts the third-party license files into the app (dist/licenses) and fails the build if a
// bundled package has no notice, a license falls outside the policy, or
// docs/THIRD_PARTY_NOTICES.md is out of date. Runs after the main and renderer builds.
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..', '..');
const { collect, writeDist, NOTICES_PATH, renderMarkdown } = await import(resolve(root, 'tools', 'third-party-notices.mjs'));
const { readFileSync } = await import('node:fs');

// The app's own notices list only the codec rows of the distribution being built (ZEYVOLA_DIST).
const { problems, data } = writeDist(resolve(here, '..', 'dist'), root, { profile: process.env.ZEYVOLA_DIST ?? 'mp4', platform: process.platform });
if (readFileSync(resolve(root, NOTICES_PATH), 'utf8') !== renderMarkdown(collect(root))) {
  problems.push(`${NOTICES_PATH} güncel değil: \`node tools/third-party-notices.mjs --write\` çalıştırıp değişikliği gözden geçirin`);
}
for (const p of problems) console.error(`  ✗ ${p}`);
if (problems.length) {
  console.error('Lisans bildirimleri eksik veya güncel değil; derleme durduruldu.');
  process.exit(1);
}
console.log(`Lisans dosyaları: dist/licenses (${data.packages.length} paket + Electron ${data.electron.version}, ${data.electron.chromium.entries} Chromium girişi)`);
