#!/usr/bin/env node
// Builds a local test package of Zeyvola for one distribution profile, platform and architecture.
// No packaging dependency: the official Electron zip (SHA-256 checked by @electron/get,
// tools/electron-artifacts.mjs) is unpacked and our app is put inside it.
//
//   node apps/desktop/scripts/package.mjs [--profile mp4|webm|webm-vp8] [--arch arm64|x64] [--skip-build] [--test-signing]
//
// --test-signing (macOS, local tests only): the ad hoc signature names a fixed requirement (the bundle
// identifier) instead of the build's own hash, so macOS keeps the screen recording, camera and
// microphone permissions from one test build to the next. Weaker than a real signature: never for
// release (codec-audit --release refuses such a package).
//
// Releases are macOS only for now. A Windows package needs both `--platform win32` and
// `--experimental-windows` (Windows ships d3dcompiler_47.dll, whose Microsoft terms are not met yet).
//
// Output: apps/desktop/out/<profile>/<platform>-<arch>/ (git-ignored), then tools/codec-audit.mjs
// checks what really ended up in the package. Both profiles replace Electron's libffmpeg with
// Electron's official build without proprietary codecs (no FFmpeg H.264 / AAC decoders).
// macOS packages get an ad hoc signature, Windows ones none; distribution needs real signing.
// The executable's version details name Zeyvola and its developer; the icon is still Electron's.
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const appDir = resolve(here, '..');
const root = resolve(appDir, '..', '..');
const { artifact, cached, extractZip, ELECTRON_VERSION } = await import(pathToFileURL(join(root, 'tools', 'electron-artifacts.mjs')).href);
const { writeDist } = await import(pathToFileURL(join(root, 'tools', 'third-party-notices.mjs')).href);
const { setVersionInfo } = await import(pathToFileURL(join(root, 'tools', 'win-version-info.mjs')).href);

const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : fallback; };
// The released distribution is A (since 2026-11-13, docs/denetim/2026-11-13-mp4-h264-karari.md):
// MP4 (H.264 + AAC) and WebM (VP9 + Opus) export, and the macOS recorder (ScreenCaptureKit; it writes
// H.264 with VideoToolbox). The released profile carries the plain identifier com.zeyvola.app, which
// users' macOS permissions belong to; the other profiles get a suffix (bundleIdFor).
const profile = arg('profile', 'mp4');
const platform = arg('platform', 'darwin');
const arch = arg('arch', process.arch);
if (!['mp4', 'webm', 'webm-vp8'].includes(profile)) throw new Error('--profile mp4 | webm | webm-vp8');
if (!['darwin', 'win32'].includes(platform)) throw new Error('--platform darwin | win32');
if (platform === 'win32' && !process.argv.includes('--experimental-windows')) {
  throw new Error('Zeyvola şimdilik yalnızca macOS için dağıtılıyor. Deneysel Windows paketi için: --platform win32 --experimental-windows');
}
if (!['arm64', 'x64'].includes(arch)) throw new Error('--arch arm64 | x64');
// A macOS package needs macOS's own tools (ditto, PlistBuddy, codesign, lipo, swiftc). A Windows
// package is made on macOS (helper cross-compiled with zig) or on Windows itself (GitHub
// windows-latest: bsdtar from System32, zig from tools/.cache/zig or ZIG or PATH).
if (platform === 'darwin' && process.platform !== 'darwin') throw new Error('macOS paketi yalnızca macOS üzerinde derlenir (ditto, codesign, PlistBuddy, lipo)');
if (platform === 'win32' && !['darwin', 'win32'].includes(process.platform)) throw new Error('Windows paketi macOS ya da Windows üzerinde derlenir');

const pkg = JSON.parse(readFileSync(join(appDir, 'package.json'), 'utf8'));
/** The app's own copyright line (also in NOTICE and src/shared/brand.ts; brand.test.ts keeps them equal). */
const COPYRIGHT = `Copyright © 2026 ${pkg.author}`;
const out = join(appDir, 'out', profile, `${platform}-${arch}`);
const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: 'inherit', ...opts });
/** Copies native/<dir>/bin/<name> into the package's resources/bin, building it first if missing. */
function shipHelper(dir, name) {
  const built = join(root, 'native', dir, 'bin', name);
  if (!existsSync(built)) {
    if (dir === 'helper-windows' && process.platform === 'win32') buildWindowsHelperOnWindows();
    else sh('bash', [join(root, 'native', dir, 'build.sh')]);
  }
  mkdirSync(join(resources, 'bin'), { recursive: true });
  cpSync(built, join(resources, 'bin', name));
}

// 1) Build the app for this profile (renderer, main, dist/licenses).
if (!process.argv.includes('--skip-build')) {
  // pnpm is pnpm.cmd on Windows, which Node starts only through a shell.
  sh('pnpm', ['run', 'build'], { cwd: appDir, env: { ...process.env, ZEYVOLA_DIST: profile }, shell: process.platform === 'win32' });
}

// 2) Official artifacts, verified against SHASUMS256.txt when first downloaded.
const zip = async (spec) => cached(spec) ?? artifact(spec);
const electronZip = await zip(`electron:${platform}:${arch}`);
const ffmpegZip = await zip(`ffmpeg:${platform}:${arch}`);

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
// On macOS ditto keeps the framework symlinks of the bundle (extractZip).
extractZip(electronZip, out);
const work = mkdtempSync(join(tmpdir(), 'zeyvola-ffmpeg-'));
extractZip(ffmpegZip, work);

let resources;
let ffmpegTarget;
if (platform === 'darwin') {
  renameSync(join(out, 'Electron.app'), join(out, 'Zeyvola.app'));
  const bundle = join(out, 'Zeyvola.app');
  resources = join(bundle, 'Contents', 'Resources');
  ffmpegTarget = join(bundle, 'Contents', 'Frameworks', 'Electron Framework.framework', 'Versions', 'A', 'Libraries', 'libffmpeg.dylib');
  cpSync(join(work, 'libffmpeg.dylib'), ffmpegTarget);
  const plist = join(bundle, 'Contents', 'Info.plist');
  const set = (key, type, value) => {
    try { execFileSync('/usr/libexec/PlistBuddy', ['-c', `Delete :${key}`, plist], { stdio: 'ignore' }); } catch { /* absent */ }
    execFileSync('/usr/libexec/PlistBuddy', ['-c', `Add :${key} ${type} ${value}`, plist]);
  };
  // The experimental VP8 build gets its own identifier so it never shares macOS permissions with B.
  const bundleId = bundleIdFor(profile);
  set('CFBundleName', 'string', 'Zeyvola');
  set('CFBundleDisplayName', 'string', 'Zeyvola');
  set('CFBundleIdentifier', 'string', bundleId);
  // Electron's "Rebranding with downloaded binaries": the executable and the helper apps get the
  // app's name too. Electron also treats an executable still called "Electron" as unpackaged
  // (app.isPackaged), and would then look for the recorder outside the bundle.
  renameSync(join(bundle, 'Contents', 'MacOS', 'Electron'), join(bundle, 'Contents', 'MacOS', 'Zeyvola'));
  set('CFBundleExecutable', 'string', 'Zeyvola');
  const frameworks = join(bundle, 'Contents', 'Frameworks');
  for (const suffix of ['', ' (GPU)', ' (Renderer)', ' (Plugin)']) {
    const from = join(frameworks, `Electron Helper${suffix}.app`);
    if (!existsSync(from)) continue;
    const name = `Zeyvola Helper${suffix}`;
    const to = join(frameworks, `${name}.app`);
    renameSync(from, to);
    renameSync(join(to, 'Contents', 'MacOS', `Electron Helper${suffix}`), join(to, 'Contents', 'MacOS', name));
    const hp = join(to, 'Contents', 'Info.plist');
    const hset = (key, value) => {
      try { execFileSync('/usr/libexec/PlistBuddy', ['-c', `Delete :${key}`, hp], { stdio: 'ignore' }); } catch { /* absent */ }
      execFileSync('/usr/libexec/PlistBuddy', ['-c', `Add :${key} string ${value}`, hp]);
    };
    hset('CFBundleName', name);
    hset('CFBundleDisplayName', name);
    hset('CFBundleExecutable', name);
    hset('CFBundleIdentifier', `${bundleId}.helper`);
    try { execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Add :NSCameraUseContinuityCameraDeviceType bool true', hp], { stdio: 'ignore' }); } catch { /* present */ }
  }
  set('CFBundleShortVersionString', 'string', pkg.version);
  set('CFBundleVersion', 'string', pkg.version);
  set('NSHumanReadableCopyright', 'string', COPYRIGHT);
  set('NSCameraUsageDescription', 'string', 'Zeyvola, kamera görüntünüzü ekrandan ayrı kaydetmek için kameraya erişir.');
  set('NSMicrophoneUsageDescription', 'string', 'Zeyvola, sesinizi kaydetmek için mikrofona erişir.');
  // System audio is recorded only by the macOS recorder, which ships in the A profile alone.
  if (profile === 'mp4') set('NSAudioCaptureUsageDescription', 'string', 'Zeyvola, bilgisayarın sesini ekran kaydına eklemek için sistem sesine erişir.');
  else { try { execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Delete :NSAudioCaptureUsageDescription', plist], { stdio: 'ignore' }); } catch { /* absent */ } }
  set('NSCameraUseContinuityCameraDeviceType', 'bool', 'true');
  // The macOS recorder (H.264 with VideoToolbox) ships only in A; B and VP8 record through Chromium.
  // It is a universal binary (arm64 + x86_64, native/recorder-macos/build.sh), so one build serves
  // both package architectures; the check below refuses a binary without this package's.
  if (profile === 'mp4') {
    shipHelper('recorder-macos', 'zeyvola-recorder');
    const archs = execFileSync('lipo', ['-archs', join(resources, 'bin', 'zeyvola-recorder')], { encoding: 'utf8' }).trim().split(/\s+/);
    if (!archs.includes(arch === 'x64' ? 'x86_64' : arch)) throw new Error(`Kayıt yardımcısında ${arch} yok (${archs.join(', ')}): native/recorder-macos/build.sh`);
  }
  // The pointer helper (mouse buttons and scrolling only; AppKit, no codecs) ships in every
  // macOS profile: the Chromium recording path cannot see clicks on its own.
  // The sound helper (AVFoundation decode → Opus; no video codecs) gives imported MP4/MOV videos
  // their AAC sound, which the codec-free libffmpeg cannot decode.
  shipHelper('input-macos', 'zeyvola-input');
  shipHelper('audio-macos', 'zeyvola-audio');
} else {
  renameSync(join(out, 'electron.exe'), join(out, 'Zeyvola.exe'));
  // Properties › Details of the executable: Zeyvola and its developer instead of Electron's details.
  const exe = join(out, 'Zeyvola.exe');
  const image = readFileSync(exe);
  setVersionInfo(image, {
    fileVersion: pkg.version,
    productVersion: pkg.version,
    strings: {
      CompanyName: pkg.author, FileDescription: 'Zeyvola', FileVersion: pkg.version, InternalName: 'Zeyvola',
      LegalCopyright: COPYRIGHT, OriginalFilename: 'Zeyvola.exe', ProductName: 'Zeyvola', ProductVersion: pkg.version,
    },
  });
  writeFileSync(exe, image);
  resources = join(out, 'resources');
  ffmpegTarget = join(out, 'ffmpeg.dll');
  cpSync(join(work, 'ffmpeg.dll'), ffmpegTarget);
  // DirectX Shader Compiler (dxcompiler.dll) and Microsoft's DXIL signer (dxil.dll) serve WebGPU's
  // D3D12 backend only. Zeyvola renders with WebGL2, so they are left out; dxil.dll would otherwise
  // bring Microsoft's DXC license terms (end-user terms protecting Microsoft, indemnification).
  // d3dcompiler_47.dll stays: WebGL on Windows compiles shaders with it (Microsoft: not a system
  // component, redistributed side by side). It ships as "d3dcompiler_47.dll.terms-pending", a name
  // Windows' loader never looks for, and gets its real name only after the user has accepted
  // Microsoft's terms (apps/desktop/src/main/windows-terms.ts). Unsigned today; Authenticode signs
  // each file on its own, so the later rename keeps a file signature (a catalog would need a new look).
  for (const f of ['dxil.dll', 'dxcompiler.dll']) rmSync(join(out, f), { force: true });
  if (existsSync(join(out, 'd3dcompiler_47.dll'))) renameSync(join(out, 'd3dcompiler_47.dll'), join(out, 'd3dcompiler_47.dll.terms-pending'));
  // Test build only (--omit-d3dcompiler): without the bundled Microsoft DLL, Chromium has to use
  // Windows' own copy or another ANGLE backend (start with --use-angle=vulkan), and the app shows
  // no Microsoft terms. Whether WebGL2 and export work this way is untested on real Windows.
  if (process.argv.includes('--omit-d3dcompiler')) rmSync(join(out, 'd3dcompiler_47.dll.terms-pending'), { force: true });
  // One helper for mouse buttons (--input) and imported videos' AAC sound (--extract-audio,
  // Media Foundation → WAV). Built with zig from native/helper-windows, no C runtime linked.
  shipHelper('helper-windows', 'zeyvola-win.exe');
}
rmSync(work, { recursive: true, force: true });
rmSync(join(resources, 'default_app.asar'), { force: true });

// 3) The app: package.json + bundled output. Source maps stay out of the package.
const app = join(resources, 'app');
mkdirSync(app, { recursive: true });
writeFileSync(join(app, 'package.json'), `${JSON.stringify({ name: pkg.name, productName: pkg.productName, version: pkg.version, description: pkg.description, main: pkg.main, private: true }, null, 2)}\n`);
cpSync(join(appDir, 'dist'), join(app, 'dist'), { recursive: true, filter: (src) => !src.endsWith('.map') });

// 4) Notices for this platform's Electron (its LICENSE and Chromium notices differ per platform).
const electronDist = out; // the zip's root: LICENSE, LICENSES.chromium.html, version
const versionFile = join(electronDist, 'version');
if (!existsSync(versionFile) || readFileSync(versionFile, 'utf8').trim() !== ELECTRON_VERSION) throw new Error('Electron zip sürümü beklenen değil');
const { problems } = writeDist(join(app, 'dist'), root, { electronDist, profile, platform });
// The same files inside the bundle's resources, so a copy of the app alone still carries them.
cpSync(join(app, 'dist', 'licenses'), join(resources, 'licenses'), { recursive: true });
// Windows: the user terms for Microsoft's d3dcompiler_47.dll, shown on first start (windows-terms.ts).
if (platform === 'win32') cpSync(join(root, 'tools', 'notices-supplement', 'MICROSOFT-D3DCOMPILER-TERMS.txt'), join(resources, 'licenses', 'MICROSOFT-D3DCOMPILER-TERMS.txt'));
writeFileSync(join(resources, 'licenses', 'FFMPEG-LGPL.md'), ffmpegNotice());
cpSync(join(resources, 'licenses', 'FFMPEG-LGPL.md'), join(out, 'FFMPEG-LGPL.md'));
writeFileSync(join(resources, 'licenses', 'DISTRIBUTION.json'), `${JSON.stringify({ app: pkg.version, profile, platform, arch, electron: ELECTRON_VERSION, ffmpeg: 'electron-official-without-proprietary-codecs', recorder: platform === 'darwin' && profile === 'mp4', mp4Export: profile === 'webm-vp8' ? null : 'h264+aac (operating-system encoders)' }, null, 1)}\n`);
if (problems.length) {
  for (const p of problems) console.error(`  ✗ ${p}`);
  throw new Error('Lisans bildirimleri eksik; paket tamamlanmadı');
}

if (platform === 'darwin') {
  sh('codesign', ['--force', '--deep', '--sign', '-', join(out, 'Zeyvola.app')], { stdio: 'ignore' });
  // The outer bundle again, now with the fixed requirement; the nested helpers keep their own.
  if (process.argv.includes('--test-signing')) sh('codesign', ['--force', '--sign', '-', '--requirements', `=designated => identifier "${bundleIdFor(profile)}"`, join(out, 'Zeyvola.app')], { stdio: 'ignore' });
}

// 5) What really ended up in the package.
sh(process.execPath, [join(root, 'tools', 'codec-audit.mjs'), out, '--profile', profile, '--json', join(out, '..', `codec-audit-${platform}-${arch}.json`)]);
console.log(`Paket: ${out}`);

/**
 * native/helper-windows/build.sh, step for step, for a Windows host (no POSIX shell needed; on
 * GitHub runners `bash` may resolve to the WSL launcher). Keep the two in step.
 */
function buildWindowsHelperOnWindows() {
  const dir = join(root, 'native', 'helper-windows');
  const zig = findZig();
  mkdirSync(join(dir, 'bin'), { recursive: true });
  mkdirSync(join(dir, '.build'), { recursive: true });
  const libs = readdirSync(join(dir, 'imports')).filter((f) => f.endsWith('.def')).sort().map((def) => {
    const lib = join('.build', def.replace(/\.def$/, '.lib'));
    sh(zig, ['dlltool', '-m', 'i386:x86-64', '-d', join('imports', def), '-l', lib], { cwd: dir });
    return lib;
  });
  sh(zig, ['cc', '-target', 'x86_64-windows-gnu', '-O2', '-Wall', '-Wextra', '-Wno-unused-parameter',
    '-nostdinc', '-nostdlib', '-fno-stack-protector', '-mno-stack-arg-probe', '-fno-builtin',
    '-s', '-Wl,--entry=mainCRTStartup', '-Wl,--subsystem,console',
    'zeyvola-win.c', 'zeyvola-win.rc', '-o', join('bin', 'zeyvola-win.exe'), ...libs], { cwd: dir });
  for (const f of ['zeyvola-win.lib', 'zeyvola-win.pdb']) rmSync(join(dir, 'bin', f), { force: true });
}

/** zig: $ZIG, then tools/.cache/zig/zig(.exe), then the one on PATH. */
function findZig() {
  if (process.env.ZIG) return process.env.ZIG;
  for (const f of ['zig.exe', 'zig']) { const p = join(root, 'tools', '.cache', 'zig', f); if (existsSync(p)) return p; }
  return 'zig';
}

function bundleIdFor(p) {
  // The released profile (A) is com.zeyvola.app; until 2026-11-13 that identifier was B's, so a
  // released A replaces an installed B in place and keeps its settings and permissions entry.
  return { mp4: 'com.zeyvola.app', webm: 'com.zeyvola.app.webm', 'webm-vp8': 'com.zeyvola.app.vp8' }[p];
}

function ffmpegNotice() {
  const src = JSON.parse(readFileSync(join(root, 'docs', 'licenses', 'ffmpeg-source.json'), 'utf8'));
  if (src.electron !== ELECTRON_VERSION) throw new Error('docs/licenses/ffmpeg-source.json başka bir Electron sürümü için: node tools/ffmpeg-source.mjs');
  return `# FFmpeg (LGPL-2.1-or-later)

Zeyvola, Electron ile gelen FFmpeg kitaplığını dinamik olarak bağlanan ayrı bir dosya olarak içerir:
${platform === 'darwin' ? '`Zeyvola.app/Contents/Frameworks/Electron Framework.framework/Versions/A/Libraries/libffmpeg.dylib`' : '`ffmpeg.dll`'}.
Bu dosya Electron ${ELECTRON_VERSION} sürümünün resmi \`ffmpeg-v${ELECTRON_VERSION}-${platform}-${arch}.zip\` derlemesidir (tescilli codec'ler olmadan;
H.264 ve AAC çözücüleri içermez). Sürüm dizesi: \`git-2026-07-15-6cfe2122b0\`.

Zeyvola contains the FFmpeg library shipped with Electron as a separate, dynamically linked file (path above),
taken unchanged from Electron's official \`ffmpeg-v${ELECTRON_VERSION}-${platform}-${arch}.zip\` (built without proprietary codecs).

- License: GNU Lesser General Public License 2.1 or later. Full text: \`LICENSES.chromium.html\`, entry "ffmpeg".
- Source: the corresponding source is offered from the same place as this download, as the asset
  \`${src.bundle.file}\` of the same GitHub release (SHA-256 ${src.bundle.sha256}). It holds
  chromium/third_party/ffmpeg at revision ${src.revision} (pinned by Chromium ${src.chromium}, the Chromium in
  Electron ${src.electron}; its version headers carry the same id as this binary, \`${src.binaryVersionString}\`), Electron's
  patches for it and Electron's build arguments for this library.
  Kaynak: aynı GitHub sürümünün \`${src.bundle.file}\` dosyası (yukarıdaki revizyon, Electron yamaları ve derleme ayarları).
  FFmpeg project: https://ffmpeg.org/ · Chromium fork: https://chromium.googlesource.com/chromium/third_party/ffmpeg
- You may replace this library with a modified, interface-compatible build. On macOS, re-sign the app afterwards
  (for example \`codesign --force --deep --sign - Zeyvola.app\`). Zeyvola's terms do not forbid modifying the library or
  reverse engineering for debugging such modifications.
- Zeyvola does not own FFmpeg. FFmpeg is a trademark of Fabrice Bellard.
`;
}
