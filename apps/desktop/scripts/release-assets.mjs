#!/usr/bin/env node
// Prepares the files of a GitHub release from a package built by package.mjs. Nothing is uploaded
// or published: the files are written to apps/desktop/out/release/<version>/ and a person attaches
// them to the release.
//
//   node apps/desktop/scripts/release-assets.mjs [--platform darwin|win32] [--arch arm64|x64] [--draft]
//
// First runs `codec-audit --release` on the package; any failure or release blocker stops here.
// --draft writes the files even when only release blockers remain (for review, never for publishing).
// Windows is always a draft: it has not been tested on real Windows yet.
// Files: Zeyvola-<v>-macos-<arch>.zip and .dmg, or Zeyvola-<v>-windows-<arch>.zip (the app plus
// README, RELEASE.txt, LICENSE, NOTICE and the third-party notices), the FFmpeg source bundle
// (LGPL-2.1: offered from the same place as the binary), SHA256SUMS.txt and RELEASE-STATUS.json
// (signing and open blockers). The disk image is made with macOS's own hdiutil.
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const appDir = resolve(here, '..');
const root = resolve(appDir, '..', '..');
const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : fallback; };
const platform = arg('platform', 'darwin');
const arch = arg('arch', platform === 'win32' ? 'x64' : process.arch);
const windows = platform === 'win32';
const draft = process.argv.includes('--draft') || windows;
const { version, author, homepage } = JSON.parse(readFileSync(join(appDir, 'package.json'), 'utf8'));
const pkgDir = join(appDir, 'out', 'webm', `${platform}-${arch}`);
const app = join(pkgDir, windows ? 'Zeyvola.exe' : 'Zeyvola.app');
if (!existsSync(app)) { console.error(`Önce paket: node apps/desktop/scripts/package.mjs --platform ${platform} --arch ${arch}${windows ? ' --experimental-windows' : ''}`); process.exit(1); }

// 1) Audit the exact package that will be zipped.
const auditJson = join(pkgDir, 'codec-audit-release.json');
const audit = spawnSync(process.execPath, [join(root, 'tools', 'codec-audit.mjs'), pkgDir, '--profile', 'webm', '--probe', '--release', '--json', auditJson], { encoding: 'utf8' });
process.stdout.write(audit.stdout);
const report = JSON.parse(readFileSync(auditJson, 'utf8'));
const onlyBlockers = report.fails.every((f) => f.startsWith('yayın engeli:'));
if (audit.status !== 0 && !(draft && onlyBlockers)) {
  console.error(draft ? 'Denetim yayın engeli dışında hata verdi; dosya üretilmedi.' : 'Denetim geçmedi; dosya üretilmedi (inceleme için: --draft).');
  process.exit(1);
}

// 2) Zip: the app and, next to it, the license files a recipient must get.
const out = join(appDir, 'out', 'release', version);
mkdirSync(out, { recursive: true });
const label = `${windows ? 'windows' : 'macos'}-${arch}`;
const stage = mkdtempSync(join(tmpdir(), 'zeyvola-release-'));
const folder = join(stage, `Zeyvola-${version}-${label}`);
mkdirSync(folder);
const lic = windows ? join(pkgDir, 'resources', 'licenses') : join(app, 'Contents', 'Resources', 'licenses');
if (windows) cpSync(pkgDir, join(folder, 'Zeyvola'), { recursive: true, filter: (src) => !src.endsWith('codec-audit-release.json') });
else execFileSync('ditto', [app, join(folder, 'Zeyvola.app')]); // keeps the signature and symlinks
copyFileSync(join(root, 'LICENSE'), join(folder, 'LICENSE.md'));
copyFileSync(join(root, 'NOTICE'), join(folder, 'NOTICE.txt'));
copyFileSync(join(root, 'TRADEMARKS.md'), join(folder, 'TRADEMARKS.md'));
copyFileSync(join(root, 'README.md'), join(folder, 'README.md'));
const electronVersion = readFileSync(join(pkgDir, 'version'), 'utf8').trim();
writeFileSync(join(folder, 'RELEASE.txt'), [
  `Zeyvola ${version} (${windows ? 'Windows' : 'macOS'} ${arch})`,
  `Developer: ${author}, Independent Software Developer`,
  `Copyright © 2026 ${author}`,
  'License: PolyForm Shield License 1.0.0 (LICENSE.md, NOTICE.txt). Third-party components keep their own licenses (THIRD_PARTY_NOTICES.md).',
  `Source: ${homepage}`,
  `Electron ${electronVersion} · FFmpeg without proprietary codecs (FFMPEG-LGPL.md)`,
  `Prepared: ${new Date().toISOString().slice(0, 10)}`,
  windows ? 'Status: test build, not tested on real Windows yet; not for general use.' : '',
].filter(Boolean).join('\n') + '\n');
const extra = [['THIRD_PARTY_NOTICES.md', 'THIRD_PARTY_NOTICES.md'], ['FFMPEG-LGPL.md', 'FFMPEG-LGPL.md'], ['LICENSES.chromium.html', 'LICENSES.chromium.html'], ['electron-LICENSE.txt', 'LICENSE.electron.txt']];
if (windows && existsSync(join(lic, 'MICROSOFT-D3DCOMPILER-TERMS.txt'))) extra.push(['MICROSOFT-D3DCOMPILER-TERMS.txt', 'MICROSOFT-D3DCOMPILER-TERMS.txt']);
for (const [from, to] of extra) copyFileSync(join(lic, from), join(folder, to));
const zip = join(out, `Zeyvola-${version}-${label}${windows ? '-TASLAK' : ''}.zip`);
rmSync(zip, { force: true });
execFileSync('ditto', ['-c', '-k', '--norsrc', '--noextattr', '--noqtn', '--keepParent', folder, zip]); // no __MACOSX entries
// macOS also as a disk image: the same folder plus a link to Applications for drag-to-install.
let dmg = null;
if (!windows) {
  dmg = join(out, `Zeyvola-${version}-${label}.dmg`);
  rmSync(dmg, { force: true });
  symlinkSync('/Applications', join(folder, 'Applications'));
  execFileSync('hdiutil', ['create', '-quiet', '-volname', `Zeyvola ${version}`, '-srcfolder', folder, '-fs', 'HFS+', '-format', 'UDZO', '-ov', dmg]);
}
rmSync(stage, { recursive: true, force: true });

// 3) FFmpeg corresponding source, the exact file the package's FFMPEG-LGPL.md names.
const src = JSON.parse(readFileSync(join(root, 'docs', 'licenses', 'ffmpeg-source.json'), 'utf8'));
const bundle = join(appDir, 'out', 'release-sources', src.bundle.file);
copyFileSync(bundle, join(out, basename(bundle)));

// 4) Checksums of every file in the release folder (both platforms when both were prepared).
const sha = (f) => createHash('sha256').update(readFileSync(f)).digest('hex');
if (sha(join(out, basename(bundle))) !== src.bundle.sha256) { console.error('FFmpeg kaynak paketi kayıttaki dosya değil'); process.exit(1); }
cpSync(auditJson, join(out, `codec-audit-${label}.json`));

// 5) What a recipient should know before running it: signing, and what still blocks publishing.
const codesign = windows ? null : spawnSync('codesign', ['-dv', app], { encoding: 'utf8' }).stderr;
const statusFile = join(out, 'RELEASE-STATUS.json');
const status = existsSync(statusFile) ? JSON.parse(readFileSync(statusFile, 'utf8')) : {};
status[label] = {
  zip: basename(zip), sha256: sha(zip), ...(dmg ? { dmg: basename(dmg), dmgSha256: sha(dmg) } : {}), draft, preparedAt: new Date().toISOString(),
  signing: windows
    ? 'imzasız (Authenticode yok): Windows SmartScreen "Windows bilgisayarınızı korudu" uyarısı gösterir'
    : `${/Signature=adhoc/.test(codesign ?? '') ? 'geçici (ad-hoc) imza' : 'imza okunamadı'}; Developer ID ve noter onayı (notarization) yok: Gatekeeper ilk açılışta uyarır`,
  tested: windows ? 'gerçek Windows\'ta test edilmedi' : 'bu Mac\'te (arm64) otomatik duman testi ve codec denetimi geçti; gerçek kayıt testi ayrıca raporlanır',
  blockers: report.blockers,
};
writeFileSync(statusFile, `${JSON.stringify(status, null, 1)}\n`);
const files = [...new Set([...Object.values(status).flatMap((s) => [join(out, s.zip), ...(s.dmg ? [join(out, s.dmg)] : [])]), join(out, basename(bundle))])].filter(existsSync);
writeFileSync(join(out, 'SHA256SUMS.txt'), files.map((f) => `${sha(f)}  ${basename(f)}`).join('\n') + '\n');
console.log(`\n${draft && report.blockers.length ? 'TASLAK (yayın engeli var, yayımlanmaz)' : 'Yayın dosyaları hazır'}: ${out}`);
for (const f of [...files, join(out, 'SHA256SUMS.txt'), statusFile]) console.log(`  ${basename(f)}`);
