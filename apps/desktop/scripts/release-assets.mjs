#!/usr/bin/env node
// Prepares the files of a GitHub release from a package built by package.mjs. Nothing is uploaded
// or published: the files are written to apps/desktop/out/release/<version>/ and a person attaches
// them to the release.
//
//   node apps/desktop/scripts/release-assets.mjs [--platform darwin|win32] [--arch arm64|x64] [--draft] [--smoke <report.json>] [--out <dir>]
//
// --smoke: a report written by the packaged app itself (`… --smoke --smoke-report <file>`); its
// pass count and GPU go into RELEASE-STATUS.json, so "tested" says what ran and where.
//
// First runs `codec-audit --release` on the package; any failure or release blocker stops here.
// --draft writes the files even when only release blockers remain (for review, never for publishing).
// Windows is released as a beta (RELEASE-STATUS.json: channel "beta"): automated tests on GitHub's
// Windows machine only, not yet tried on a real Windows 10/11 PC.
// Files: Zeyvola-<v>-macos-<arch>.zip and .dmg, or Zeyvola-<v>-windows-<arch>.zip (the app plus
// README, RELEASE.txt, LICENSE, NOTICE and the third-party notices), the FFmpeg source bundle
// (LGPL-2.1: offered from the same place as the binary), SHA256SUMS.txt and RELEASE-STATUS.json
// (signing and open blockers). The disk image is made with macOS's own hdiutil.
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const appDir = resolve(here, '..');
const root = resolve(appDir, '..', '..');
const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : fallback; };
const platform = arg('platform', 'darwin');
const arch = arg('arch', platform === 'win32' ? 'x64' : process.arch);
const windows = platform === 'win32';
const draft = process.argv.includes('--draft');
const BETA_NOTE = 'GitHub\'ın Windows makinesinde otomatik testlerden geçti; gerçek bir Windows 10/11 bilgisayarda henüz denenmedi.';
const { version, author, homepage } = JSON.parse(readFileSync(join(appDir, 'package.json'), 'utf8'));
const { createZip } = await import(pathToFileURL(join(root, 'tools', 'electron-artifacts.mjs')).href);
// The released profile is A (package.mjs default since 2026-11-13).
const PROFILE = 'mp4';
const pkgDir = join(appDir, 'out', PROFILE, `${platform}-${arch}`);
const app = join(pkgDir, windows ? 'Zeyvola.exe' : 'Zeyvola.app');
if (!existsSync(app)) { console.error(`Önce paket: node apps/desktop/scripts/package.mjs --platform ${platform} --arch ${arch}`); process.exit(1); }

// 1) Audit the exact package that will be zipped.
const auditJson = join(pkgDir, 'codec-audit-release.json');
const audit = spawnSync(process.execPath, [join(root, 'tools', 'codec-audit.mjs'), pkgDir, '--profile', PROFILE, '--probe', '--release', '--json', auditJson], { encoding: 'utf8' });
process.stdout.write(audit.stdout);
const report = JSON.parse(readFileSync(auditJson, 'utf8'));
const onlyBlockers = report.fails.every((f) => f.startsWith('yayın engeli:'));
if (audit.status !== 0 && !(draft && onlyBlockers)) {
  console.error(draft ? 'Denetim yayın engeli dışında hata verdi; dosya üretilmedi.' : 'Denetim geçmedi; dosya üretilmedi (inceleme için: --draft).');
  process.exit(1);
}

// 2) Zip: the app and, next to it, the license files a recipient must get.
const out = resolve(arg('out', join(appDir, 'out', 'release', version))); // --out: a trial run elsewhere
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
  windows ? 'Status: beta. Passed the automated tests on GitHub\'s Windows machine; not yet tried on a real Windows 10/11 PC.' : '',
].filter(Boolean).join('\n') + '\n');
const extra = [['THIRD_PARTY_NOTICES.md', 'THIRD_PARTY_NOTICES.md'], ['FFMPEG-LGPL.md', 'FFMPEG-LGPL.md'], ['LICENSES.chromium.html', 'LICENSES.chromium.html'], ['electron-LICENSE.txt', 'LICENSE.electron.txt']];
if (windows && existsSync(join(lic, 'MICROSOFT-D3DCOMPILER-TERMS.txt'))) extra.push(['MICROSOFT-D3DCOMPILER-TERMS.txt', 'MICROSOFT-D3DCOMPILER-TERMS.txt']);
for (const [from, to] of extra) copyFileSync(join(lic, from), join(folder, to));
const zip = join(out, `Zeyvola-${version}-${label}.zip`);
rmSync(zip, { force: true });
createZip(folder, zip); // macOS: ditto without __MACOSX entries; Windows: System32 bsdtar
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
// The release copy names paths relative to the repository (and ~ for the home folder), so a
// published audit carries no user name or local folder layout.
const anonymize = (text) => [[root + sep, ''], [root, '.'], [homedir(), '~']]
  .reduce((t, [from, to]) => t.replaceAll(from, to).replaceAll(JSON.stringify(from).slice(1, -1), to.replaceAll('\\', '\\\\')), text);
writeFileSync(join(out, `codec-audit-${label}.json`), anonymize(readFileSync(auditJson, 'utf8')));

// 5) What a recipient should know before running it: signing, and what still blocks publishing.
const codesign = windows ? null : spawnSync('codesign', ['-dv', app], { encoding: 'utf8' }).stderr;
const statusFile = join(out, 'RELEASE-STATUS.json');
const status = existsSync(statusFile) ? JSON.parse(readFileSync(statusFile, 'utf8')) : {};
status[label] = {
  zip: basename(zip), sha256: sha(zip), ...(dmg ? { dmg: basename(dmg), dmgSha256: sha(dmg) } : {}), draft, ...(windows ? { channel: 'beta', note: BETA_NOTE } : {}), preparedAt: new Date().toISOString(),
  signing: windows
    ? 'imzasız (Authenticode yok): Windows SmartScreen "Windows bilgisayarınızı korudu" uyarısı gösterir'
    : `${/Signature=adhoc/.test(codesign ?? '') ? 'geçici (ad-hoc) imza' : 'imza okunamadı'}; Developer ID ve noter onayı (notarization) yok: Gatekeeper ilk açılışta uyarır`,
  tested: tested(),
  warnings: report.warnings ?? [],
  blockers: report.blockers,
};
writeFileSync(statusFile, `${JSON.stringify(status, null, 1)}\n`);
function tested() {
  const smokeFile = arg('smoke', null);
  const smoke = smokeFile ? JSON.parse(readFileSync(smokeFile, 'utf8')) : null;
  const passed = smoke ? `${smoke.checks.filter((c) => c.ok).length}/${smoke.checks.length}` : null;
  const host = `${process.platform === 'darwin' ? 'macOS' : process.platform} ${process.arch === 'arm64' ? 'Apple Silicon' : process.arch}`;
  const where = windows ? `${process.platform === 'win32' && smoke ? `bu dosya Windows'ta (${process.env.GITHUB_ACTIONS ? 'GitHub Actions makinesi' : process.arch}) çalıştırıldı` : 'bu dosya Windows\'ta çalıştırılmadı'}; gerçek bir Windows 10/11 bilgisayarda denenmedi`
    : arch === process.arch ? `bu Mac'te (${host}) çalıştırıldı`
      : arch === 'x64' && process.arch === 'arm64' ? `${host} Mac'te Rosetta 2 altında çalıştırıldı; gerçek Intel donanımında (Intel GPU, Intel VideoToolbox) test edilmedi`
        : `bu mimaride çalıştırılmadı (derleyen makine ${host})`;
  return smoke ? `${where}; paketin kendi duman testi ${passed} geçti${smoke.ok ? '' : ' (TAMAMI DEĞİL)'}${smoke.gpu ? ` · GPU: ${smoke.gpu}` : ''}; codec denetimi ayrıca (codec-audit-${label}.json)` : `${where}; duman testi sonucu verilmedi (--smoke)`;
}
const files = [...new Set([...Object.values(status).flatMap((s) => [join(out, s.zip), ...(s.dmg ? [join(out, s.dmg)] : [])]), join(out, basename(bundle))])].filter(existsSync);
writeFileSync(join(out, 'SHA256SUMS.txt'), files.map((f) => `${sha(f)}  ${basename(f)}`).join('\n') + '\n');
console.log(`\n${draft && report.blockers.length ? 'TASLAK (yayın engeli var, yayımlanmaz)' : 'Yayın dosyaları hazır'}: ${out}`);
for (const f of [...files, join(out, 'SHA256SUMS.txt'), statusFile]) console.log(`  ${basename(f)}`);
