#!/usr/bin/env node
// Checks what a Zeyvola package really contains, against its distribution profile
// (apps/desktop/src/shared/distribution.ts). Hiding a format in the UI is not enough, so this
// looks at the shipped files themselves:
//
//   node tools/codec-audit.mjs <package dir> --profile mp4|webm|webm-vp8 [--json <out.json>] [--probe] [--release]
//
// <package dir> holds Zeyvola.app (macOS) or Zeyvola.exe (Windows), as written by
// apps/desktop/scripts/package.mjs.
//   1. libffmpeg: codec list through FFmpeg's public API (macOS), or for Windows the SHA-256 of
//      ffmpeg.dll against Electron's official build without proprietary codecs.
//   2. OpenH264 compiled into Electron (reported; official Electron builds always contain it).
//   3. The macOS recorder: present in A, absent in B and VP8 (it encodes H.264 with VideoToolbox).
//   4. The renderer bundle: the VP8 package has no H.264 / AAC / HEVC codec strings at all; A and
//      B (MP4 = H.264 + AAC through the operating system's encoders since 2026-11-13) must carry
//      the AAC path (HEVC appears only in the smoke test's capability table).
//   5. Notices: every license file in place, Chromium notices identical to this platform's
//      Electron release, entries for each codec library found in the binaries.
//   6. --probe (macOS packages the host can run): starts the package with --codec-probe and
//      checks which decoders really work. --release: also fail on release blockers (no LICENSE).
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = join(ROOT, 'tools', '.cache');

const PROFILE_LABEL = { mp4: 'A (yayımlanan: MP4 H.264/AAC + WebM, macOS kayıt yardımcısı)', webm: 'B (Chromium kaydı, MP4 H.264/AAC + WebM)', 'webm-vp8': 'VP8 (WebM, deneysel)' };
/** Profiles with no patent-pool codec in our code at all (shared/distribution.ts PATENT_POOL_CODECS). */
const PATENT_FREE = new Set(['webm-vp8']);

/** FFmpeg decoders for codecs with active patent pools; neither profile may ship them. */
export const PATENT_POOL_DECODERS = ['h264', 'hevc', 'vvc', 'aac', 'aac_fixed', 'aac_latm', 'ac3', 'eac3', 'mpeg4', 'mpeg2video', 'mpeg1video', 'h263', 'vc1', 'amrnb', 'amrwb', 'dca', 'truehd', 'mlp'];
/** Codec strings that must not appear in a B renderer bundle. */
export const B_BUNDLE_FORBIDDEN = /avc1\.[0-9a-fA-F]{2}|avc3\.[0-9a-fA-F]{2}|mp4a\.40|hvc1\.\d|hev1\.\d|mp4a\.67/g;
/** Chromium notice titles for codec libraries, keyed by an identifier found in the binary. */
const NOTICE_FOR_MARKER = [
  { marker: '[OpenH264] this = ', title: 'OpenH264', component: 'OpenH264 (H.264 kodlayıcı, yazılım)' },
  { marker: 'aom_codec_enc', title: 'Alliance for Open Media Video Codec', component: 'libaom (AV1 kodlayıcı)' },
  { marker: 'dav1d', title: 'dav1d is an AV1 decoder :)', component: 'dav1d (AV1 çözücü)' },
  { marker: 'vpx_codec_', title: 'libvpx', component: 'libvpx (VP8/VP9)' },
  { marker: 'opus_encode', title: 'opus', component: 'libopus' },
];

/**
 * Every executable or library in a package must map to a notice: Electron's LICENSE ('electron'),
 * an entry of LICENSES.chromium.html ('chromium:<title>'), a supplementary notice for what that file
 * misses ('supplement:<id>', tools/notices-supplement.json), or Zeyvola's own code ('own').
 */
export const BINARY_NOTICES = {
  darwin: [
    [/^Zeyvola\.app\/Contents\/MacOS\/Zeyvola$/, 'electron'],
    [/\/Electron Framework\.framework\/Versions\/A\/Electron Framework$/, 'electron'],
    [/\/Electron Framework\.framework\/Versions\/A\/Helpers\/chrome_crashpad_handler$/, 'chromium:Crashpad'],
    [/\/Libraries\/libffmpeg\.dylib$/, 'chromium:ffmpeg'],
    [/\/Libraries\/libvk_swiftshader\.dylib$/, 'chromium:SwiftShader'],
    [/\/Mantle\.framework\//, 'supplement:mantle'],
    [/\/ReactiveObjC\.framework\//, 'supplement:reactiveobjc'],
    [/\/Squirrel\.framework\//, 'chromium:Squirrel'],
    [/\/Zeyvola Helper[^/]*\.app\/Contents\/MacOS\//, 'electron'],
    [/\/Resources\/bin\/zeyvola-recorder$/, 'own'],
    [/\/Resources\/bin\/zeyvola-input$/, 'own'],
    [/\/Resources\/bin\/zeyvola-audio$/, 'own'],
  ],
  win32: [
    [/^Zeyvola\.exe$/, 'electron'],
    [/^ffmpeg\.dll$/, 'chromium:ffmpeg'],
    [/^vk_swiftshader\.dll$/, 'chromium:SwiftShader'],
    [/^vulkan-1\.dll$/, 'chromium:Vulkan Loader Components'],
    [/^d3dcompiler_47\.dll$/, 'supplement:d3dcompiler'],
    [/^dxcompiler\.dll$/, 'chromium:DirectX-Shader-Compiler'],
    [/^resources\/bin\/zeyvola-win\.exe$/, 'own'],
  ],
};

/** Mach-O (macOS) or PE (Windows) files in a package, relative to it. */
function binaries(dir, platform) {
  const out = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) { walk(p); continue; }
      const fd = readFileSync(p, { flag: 'r' }).subarray(0, 4);
      const magic = fd.length === 4 ? fd.readUInt32BE(0) : 0;
      const macho = [0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe].includes(magic);
      const pe = fd[0] === 0x4d && fd[1] === 0x5a;
      if ((platform === 'darwin' && macho) || (platform === 'win32' && pe)) out.push(p.slice(dir.length + 1));
    }
  };
  walk(dir);
  return out.sort();
}

/**
 * A small macOS helper of our own: present, linked only to the named system frameworks (plus the
 * system and Swift runtime), and free of the given capture/codec markers.
 */
function machoHelper(file, label, frameworks, markers, fails) {
  const check = { present: existsSync(file) };
  if (!check.present) { fails.push(`macOS paketinde ${label} (bin/${basename(file)}) yok`); return check; }
  // Library lines are indented; the unindented lines name the file and its architectures.
  const libs = execFileSync('otool', ['-L', file], { encoding: 'utf8' }).split('\n').filter((l) => /^\s/.test(l)).map((l) => l.trim().split(' (')[0]).filter(Boolean);
  const fw = new RegExp(`^/System/Library/Frameworks/(${frameworks.join('|')})\\.framework/`);
  const allowed = (l) => fw.test(l) || /^\/usr\/lib\/(libSystem\.B|libobjc\.A)\.dylib$/.test(l) || l.startsWith('/usr/lib/swift/');
  check.libraries = [...new Set(libs)];
  check.notAllowed = check.libraries.filter((l) => !allowed(l));
  const bin = readFileSync(file).toString('latin1');
  check.codecMarkers = markers.filter((m) => bin.includes(m));
  if (check.notAllowed.length) fails.push(`${label} izin verilmeyen kitaplıklara bağlı: ${check.notAllowed.join(', ')}`);
  if (check.codecMarkers.length) fails.push(`${label} içinde codec/yakalama izi var: ${check.codecMarkers.join(', ')}`);
  return check;
}

/**
 * Import table of a PE32+ executable (PE/COFF specification: optional header data directory 1,
 * IMAGE_IMPORT_DESCRIPTOR array, 64-bit lookup entries). Read in JavaScript so the audit needs no
 * objdump, which a Windows machine does not have. Ordinal imports are listed as "#<n>".
 */
export function peImports(b) {
  const pe = b.readUInt32LE(0x3c);
  if (b.readUInt32LE(pe) !== 0x4550) throw new Error('PE imzası yok');
  const sections = b.readUInt16LE(pe + 6);
  const optSize = b.readUInt16LE(pe + 20);
  const opt = pe + 24;
  if (b.readUInt16LE(opt) !== 0x20b) throw new Error('PE32+ değil');
  const importRva = b.readUInt32LE(opt + 112 + 8); // data directory 1 (PE32+: directories start at 112)
  const table = [];
  for (let i = 0; i < sections; i++) {
    const h = opt + optSize + i * 40;
    table.push({ va: b.readUInt32LE(h + 12), size: Math.max(b.readUInt32LE(h + 8), b.readUInt32LE(h + 16)), raw: b.readUInt32LE(h + 20) });
  }
  const off = (rva) => {
    const s = table.find((x) => rva >= x.va && rva < x.va + x.size);
    if (!s) throw new Error(`RVA ${rva.toString(16)} hiçbir bölümde değil`);
    return rva - s.va + s.raw;
  };
  const cstr = (o) => b.toString('latin1', o, b.indexOf(0, o));
  const out = [];
  if (!importRva) return out;
  for (let d = off(importRva); ; d += 20) {
    const lookup = b.readUInt32LE(d) || b.readUInt32LE(d + 16); // OriginalFirstThunk, else FirstThunk
    const name = b.readUInt32LE(d + 12);
    if (!lookup && !name) break;
    const functions = [];
    for (let t = off(lookup); ; t += 8) {
      const e = b.readBigUInt64LE(t);
      if (e === 0n) break;
      functions.push(e & 0x8000000000000000n ? `#${Number(e & 0xffffn)}` : cstr(off(Number(e & 0x7fffffffn)) + 2));
    }
    out.push({ dll: cstr(off(name)), functions });
  }
  return out;
}

const sha256 = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');
const count = (file, needle) => { const b = readFileSync(file); let n = 0; let i = 0; const s = Buffer.from(needle); while ((i = b.indexOf(s, i)) >= 0) { n++; i += s.length; } return n; };
const titles = (html) => [...html.matchAll(/<span class="title">([\s\S]*?)<\/span>/g)].map((m) => m[1].replace(/<[^>]+>/g, '').trim());

function layout(dir) {
  if (existsSync(join(dir, 'Zeyvola.app'))) {
    const app = join(dir, 'Zeyvola.app');
    const fw = join(app, 'Contents', 'Frameworks', 'Electron Framework.framework', 'Versions', 'A');
    return { platform: 'darwin', app, resources: join(app, 'Contents', 'Resources'), main: join(fw, 'Electron Framework'), ffmpeg: join(fw, 'Libraries', 'libffmpeg.dylib'), exe: join(app, 'Contents', 'MacOS', 'Zeyvola') };
  }
  if (existsSync(join(dir, 'Zeyvola.exe'))) {
    return { platform: 'win32', app: dir, resources: join(dir, 'resources'), main: join(dir, 'Zeyvola.exe'), ffmpeg: join(dir, 'ffmpeg.dll'), exe: join(dir, 'Zeyvola.exe') };
  }
  throw new Error(`${dir}: Zeyvola.app veya Zeyvola.exe yok`);
}

function lister() {
  const bin = join(CACHE, 'ffmpeg-codecs');
  const src = join(ROOT, 'tools', 'codec-audit', 'ffmpeg-codecs.c');
  if (!existsSync(bin) || statSync(bin).mtimeMs < statSync(src).mtimeMs) {
    mkdirSync(CACHE, { recursive: true });
    execFileSync('clang', ['-O1', '-arch', 'arm64', '-arch', 'x86_64', '-o', bin, src]);
  }
  return bin;
}

/** Codecs of a macOS libffmpeg, run under the library's own architecture. */
export function ffmpegCodecs(dylib) {
  const archs = execFileSync('lipo', ['-archs', dylib], { encoding: 'utf8' }).trim().split(/\s+/);
  const a = archs.includes(process.arch === 'arm64' ? 'arm64' : 'x86_64') ? (process.arch === 'arm64' ? 'arm64' : 'x86_64') : archs[0];
  return JSON.parse(execFileSync('arch', [`-${a}`, lister(), dylib], { encoding: 'utf8' }));
}

async function officialZipEntry(spec, entry) {
  const { cached, extractZip } = await import(pathToFileURL(join(ROOT, 'tools', 'electron-artifacts.mjs')).href);
  const zip = cached(spec);
  if (!zip) return null;
  const work = mkdtempSync(join(tmpdir(), 'zeyvola-audit-'));
  try {
    extractZip(zip, work);
    const p = join(work, entry);
    return existsSync(p) ? { sha256: sha256(p), bytes: statSync(p).size, zip } : null;
  } finally { rmSync(work, { recursive: true, force: true }); }
}

export async function audit(dir, profile, { probe = false, release = false } = {}) {
  const L = layout(dir);
  const fails = [];
  const notes = [];
  const blockers = [];
  const report = { package: dir, platform: L.platform, profile, checks: {} };
  const peMachine = (f) => { const b = readFileSync(f); return b.readUInt16LE(b.readUInt32LE(0x3c) + 4); };
  const arch = L.platform === 'darwin'
    ? execFileSync('lipo', ['-archs', L.main], { encoding: 'utf8' }).trim()
    : (peMachine(L.main) === 0xaa64 ? 'arm64' : 'x64');
  report.arch = arch;
  const zipArch = arch.includes('arm64') ? 'arm64' : 'x64';
  const electronVersion = readFileSync(join(dir, 'version'), 'utf8').trim();
  report.electron = electronVersion;

  // 1) FFmpeg
  const ff = { file: L.ffmpeg, sha256: sha256(L.ffmpeg), bytes: statSync(L.ffmpeg).size };
  if (L.platform === 'darwin') {
    const c = ffmpegCodecs(L.ffmpeg);
    Object.assign(ff, c, { method: 'FFmpeg açık API (av_codec_iterate) ile listelendi' });
    const bad = c.decoders.filter((d) => PATENT_POOL_DECODERS.includes(d));
    if (bad.length) fails.push(`libffmpeg patent havuzlu çözücü içeriyor: ${bad.join(', ')}`);
    if (c.encoders.length) notes.push(`libffmpeg kodlayıcı içeriyor: ${c.encoders.join(', ')}`);
  }
  const official = await officialZipEntry(`ffmpeg:${L.platform}:${zipArch}`, L.platform === 'darwin' ? 'libffmpeg.dylib' : 'ffmpeg.dll');
  const stock = await officialZipEntry(`electron:${L.platform}:${zipArch}`, L.platform === 'darwin' ? 'Electron.app/Contents/Frameworks/Electron Framework.framework/Versions/A/Libraries/libffmpeg.dylib' : 'ffmpeg.dll');
  ff.matchesOfficialCodecFreeBuild = official ? official.sha256 === ff.sha256 : null;
  ff.matchesStockElectronBuild = stock ? stock.sha256 === ff.sha256 : null;
  if (ff.matchesOfficialCodecFreeBuild === false) fails.push('ffmpeg kitaplığı Electron\'un resmi codec\'siz derlemesiyle aynı değil');
  if (ff.matchesOfficialCodecFreeBuild === null) fails.push('karşılaştırma için resmi ffmpeg zip\'i önbellekte yok (tools/electron-artifacts.mjs)');
  if (L.platform === 'win32') notes.push('Windows ffmpeg.dll bu Mac\'te çalıştırılamadığı için codec listesi çıkarılamadı; resmi codec\'siz derlemeyle SHA-256 eşleşmesine bakıldı');
  report.checks.ffmpeg = ff;

  // 2) Codec libraries compiled into Electron
  const libs = NOTICE_FOR_MARKER.map((m) => ({ ...m, occurrences: count(L.main, m.marker) }));
  report.checks.compiledIn = libs.map(({ component, marker, occurrences }) => ({ component, marker, present: occurrences > 0 }));
  if (libs.find((l) => l.title === 'OpenH264')?.occurrences) {
    notes.push('OpenH264 Electron\'un içinde derlenmiş olarak bulunuyor (resmi Electron ikililerinde kaldırılamaz). Zeyvola kodu onu hiçbir profilde istemez; tamamen çıkarmak özel Electron derlemesi gerektirir.');
  }

  // 3) macOS recorder
  if (L.platform === 'darwin') {
    const helper = join(L.resources, 'bin', 'zeyvola-recorder');
    const present = existsSync(helper);
    report.checks.recorder = { present, ...(present ? { archs: execFileSync('lipo', ['-archs', helper], { encoding: 'utf8' }).trim() } : {}) };
    if (profile === 'mp4' && !present) fails.push('A paketinde macOS kayıt yardımcısı yok');
    if (profile !== 'mp4' && present) fails.push(`${PROFILE_LABEL[profile]} paketinde H.264 yazan macOS kayıt yardımcısı var`);

    // 3b) Pointer helper: clicks and scrolling only. It may link nothing but AppKit, Foundation,
    // CoreGraphics and the system/Swift runtime, and must contain no capture or codec code.
    report.checks.inputHelper = machoHelper(join(L.resources, 'bin', 'zeyvola-input'), 'tıklama yardımcısı', ['AppKit', 'Foundation', 'CoreGraphics'],
      ['VideoToolbox', 'AVAssetWriter', 'AVFoundation', 'ScreenCaptureKit', 'AudioToolbox', 'avc1', 'hvc1', 'mp4a'], fails);
    // 3c) Sound helper for imported videos: decodes their sound with AVFoundation and writes Opus
    // or PCM. No video codec, no screen capture.
    report.checks.audioHelper = machoHelper(join(L.resources, 'bin', 'zeyvola-audio'), 'ses yardımcısı', ['AVFoundation', 'AVFAudio', 'CoreMedia', 'Foundation'],
      ['VideoToolbox', 'ScreenCaptureKit', 'AVVideoCodec', 'avc1', 'hvc1', 'AppKit'], fails);
  }
  // 3d) Windows helper (--input: mouse buttons, and for window recordings the window's frame
  // through dwmapi; --extract-audio: imported videos' sound through Media Foundation). Only these
  // system DLLs; no encoder, keyboard or network functions.
  if (L.platform === 'win32') {
    const exe = join(L.resources, 'bin', 'zeyvola-win.exe');
    const check = { present: existsSync(exe) };
    if (check.present) {
      const imports = peImports(readFileSync(exe));
      check.dlls = imports.map((i) => i.dll);
      check.notAllowed = check.dlls.filter((d) => !/^(kernel32|user32|shell32|ole32|dwmapi|mfplat|mfreadwrite)\.dll$/i.test(d));
      check.functions = imports.flatMap((i) => i.functions);
      check.forbiddenFunctions = check.functions.filter((f) => /SinkWriter|Transcode|Encoder|KeyState|KeyboardState|RawInput|WH_KEYBOARD|socket|Internet|WinHttp/i.test(f));
      if (!check.functions.length) fails.push('Windows yardımcısının içe aktardığı işlevler okunamadı');
      if (check.notAllowed.length) fails.push(`Windows yardımcısı izin verilmeyen DLL'lere bağlı: ${check.notAllowed.join(', ')}`);
      if (check.forbiddenFunctions.length) fails.push(`Windows yardımcısında yasak işlevler var: ${check.forbiddenFunctions.join(', ')}`);
    } else fails.push('Windows paketinde yardımcı (resources/bin/zeyvola-win.exe) yok');
    report.checks.windowsHelper = check;

    // 3e) Microsoft's d3dcompiler_47.dll: while it ships, the app must show its user terms before
    // first use (apps/desktop/src/main/windows-terms.ts), and two decisions belong to the licensor.
    if (existsSync(join(dir, 'd3dcompiler_47.dll'))) {
      const decision = JSON.parse(readFileSync(join(ROOT, 'tools', 'windows-terms.json'), 'utf8'));
      const shipped = join(L.resources, 'licenses', 'MICROSOFT-D3DCOMPILER-TERMS.txt');
      const source = join(ROOT, decision.termsFile);
      const mainJs = join(L.resources, 'app', 'dist', 'main', 'main.cjs');
      const terms = {
        textShipped: existsSync(shipped) && sha256(shipped) === sha256(source),
        gateInApp: existsSync(mainJs) && readFileSync(mainJs, 'utf8').includes('third-party-terms.json'),
        legalReview: decision.legalReview, indemnity: decision.indemnity,
      };
      if (!terms.textShipped) fails.push('Windows paketinde Microsoft kullanıcı koşulları metni yok ya da güncel değil (resources/licenses/MICROSOFT-D3DCOMPILER-TERMS.txt)');
      if (!terms.gateInApp) fails.push('Windows paketinde ilk açılış kabul ekranı yok');
      if (!decision.legalReview) blockers.push('Windows: d3dcompiler_47.dll kullanıcı koşulları metni hukuki incelemeden geçmedi (tools/windows-terms.json)');
      if (!decision.indemnity) blockers.push('Windows: Windows SDK lisansının Microsoft\'u tazmin yükümlülüğü için lisans verenin kararı yok (tools/windows-terms.json)');
      report.checks.microsoftTerms = terms;
    } else {
      notes.push('d3dcompiler_47.dll pakette yok (--omit-d3dcompiler): WebGL için Windows\'un kendi kopyası ya da ANGLE Vulkan gerekir; gerçek Windows\'ta doğrulanmadı');
    }
  }

  // 4) Renderer bundle
  const assets = join(L.resources, 'app', 'dist', 'renderer', 'assets');
  const hits = {};
  for (const f of readdirSync(assets).filter((n) => n.endsWith('.js'))) {
    for (const m of readFileSync(join(assets, f), 'utf8').matchAll(B_BUNDLE_FORBIDDEN)) hits[m[0]] = (hits[m[0]] ?? 0) + 1;
  }
  report.checks.rendererCodecStrings = hits;
  const dist = JSON.parse(readFileSync(join(L.resources, 'licenses', 'DISTRIBUTION.json'), 'utf8'));
  if (dist.profile !== profile) fails.push(`paket ${dist.profile} profiliyle derlenmiş, beklenen ${profile}`);
  if (PATENT_FREE.has(profile) && Object.keys(hits).length) fails.push(`${PROFILE_LABEL[profile]} paketinin arayüz kodunda H.264/AAC/HEVC dizeleri var: ${Object.keys(hits).join(', ')}`);
  if (!PATENT_FREE.has(profile) && !Object.keys(hits).some((k) => k.startsWith('mp4a.40'))) fails.push(`${PROFILE_LABEL[profile]} paketinde MP4 için AAC yolu yok (mp4a.40 dizesi bulunamadı)`);
  if (existsSync(join(L.resources, 'app', 'dist')) && readdirSync(join(L.resources, 'app', 'dist'), { recursive: true }).some((n) => String(n).endsWith('.map'))) notes.push('pakette kaynak haritası (.map) var');

  // 5) Notices
  const lic = join(L.resources, 'licenses');
  const need = ['THIRD_PARTY_NOTICES.md', 'third-party.json', 'electron-LICENSE.txt', 'LICENSES.chromium.html', 'FFMPEG-LGPL.md'];
  const missing = need.filter((f) => !existsSync(join(lic, f)));
  for (const f of ['LICENSE', 'LICENSES.chromium.html']) if (!existsSync(join(dir, f))) missing.push(`(paket kökü) ${f}`);
  if (!existsSync(join(L.resources, 'app', 'dist', 'licenses', 'third-party.json'))) missing.push('app/dist/licenses/third-party.json (Lisanslar ekranı)');
  if (missing.length) fails.push(`eksik lisans dosyaları: ${missing.join(', ')}`);
  const notices = { missing };
  const chromium = join(lic, 'LICENSES.chromium.html');
  if (existsSync(chromium)) {
    const own = await officialZipEntry(`electron:${L.platform}:${zipArch}`, 'LICENSES.chromium.html');
    notices.chromium = { sha256: sha256(chromium), matchesThisPlatformsElectron: own ? own.sha256 === sha256(chromium) : null };
    if (notices.chromium.matchesThisPlatformsElectron === false) fails.push('LICENSES.chromium.html bu platformun Electron sürümündeki dosya değil');
    const t = titles(readFileSync(chromium, 'utf8'));
    notices.chromium.entries = t.length;
    notices.codecEntries = {};
    for (const l of libs.filter((x) => x.occurrences > 0)) {
      const ok = t.includes(l.title);
      notices.codecEntries[l.component] = ok;
      if (!ok) fails.push(`${l.component} ikilide var ama Chromium bildiriminde "${l.title}" girişi yok`);
    }
    if (!t.includes('ffmpeg')) fails.push('Chromium bildiriminde ffmpeg girişi yok');
  }
  const electronLicense = join(lic, 'electron-LICENSE.txt');
  if (existsSync(electronLicense) && existsSync(join(dir, 'LICENSE'))) {
    notices.electronLicenseMatches = sha256(electronLicense) === sha256(join(dir, 'LICENSE'));
    if (!notices.electronLicenseMatches) fails.push('electron-LICENSE.txt Electron\'un LICENSE dosyası değil');
  }
  // Every executable and library mapped to its notice.
  const chromiumTitles = existsSync(chromium) ? titles(readFileSync(chromium, 'utf8')) : [];
  const shippedJson = existsSync(join(lic, 'third-party.json')) ? JSON.parse(readFileSync(join(lic, 'third-party.json'), 'utf8')) : { supplements: [] };
  const inventory = binaries(dir, L.platform).map((file) => {
    const rule = BINARY_NOTICES[L.platform].find(([re]) => re.test(file));
    const notice = rule?.[1] ?? null;
    let ok = false;
    if (notice === 'electron') ok = existsSync(join(lic, 'electron-LICENSE.txt')) && chromiumTitles.length > 0;
    else if (notice === 'own') ok = true;
    else if (notice?.startsWith('chromium:')) ok = chromiumTitles.includes(notice.slice(9));
    else if (notice?.startsWith('supplement:')) ok = (shippedJson.supplements ?? []).some((x) => x.id === notice.slice(11));
    if (!notice) fails.push(`bildirimi tanımlanmamış ikili: ${file}`);
    else if (!ok) fails.push(`${file}: bildirimi pakette yok (${notice})`);
    return { file, notice, ok };
  });
  notices.binaries = { count: inventory.length, unmapped: inventory.filter((b) => !b.notice).map((b) => b.file), missing: inventory.filter((b) => b.notice && !b.ok).map((b) => b.file) };
  report.checks.binaries = inventory;

  const tp = join(lic, 'third-party.json');
  if (existsSync(tp)) {
    const j = JSON.parse(readFileSync(tp, 'utf8'));
    const { shippedPackages } = await import(pathToFileURL(join(ROOT, 'tools', 'third-party-notices.mjs')).href);
    const want = shippedPackages(ROOT).map((p) => `${p.name}@${p.version}`).sort();
    const have = j.packages.map((p) => `${p.name}@${p.version}`).sort();
    notices.packages = have.length;
    if (want.join() !== have.join()) fails.push(`third-party.json paket listesi dağıtılan paketlerle aynı değil: ${have.join(', ')}`);
    for (const p of j.packages) if (!p.text) fails.push(`${p.name}: lisans metni yok`);
    if (j.electron.version !== electronVersion) fails.push('third-party.json başka bir Electron sürümünü anlatıyor');
    if (j.ownLicense == null) blockers.push('Zeyvola\'nın kendi lisansı seçilmedi (LICENSE yok)');
    else {
      notices.ownLicense = j.ownLicense;
      if (!(j.ownNotice ?? []).some((l) => l.startsWith('Required Notice:'))) blockers.push('NOTICE dosyasında "Required Notice:" satırı yok');
      if ((j.ownNotice ?? []).some((l) => /<[^>]+>/.test(l))) blockers.push('NOTICE: lisans verenin adı ve GitHub adresi doldurulmadı');
      for (const f of ['ZEYVOLA-LICENSE.md', 'NOTICE.txt']) if (!existsSync(join(lic, f))) fails.push(`pakette licenses/${f} yok`);
    }
  }
  report.checks.notices = notices;

  // 6) Runtime probe
  if (probe) {
    if (L.platform !== 'darwin' || !(process.platform === 'darwin')) {
      notes.push('çalışma zamanı sondası yalnızca bu Mac\'in çalıştırabildiği macOS paketlerinde yapılır');
    } else {
      report.checks.runtime = runtimeProbe(L, fails);
    }
  }

  // LGPL source for the shipped libffmpeg: the bundle must exist and be the one the package names.
  const srcRecord = join(ROOT, 'docs', 'licenses', 'ffmpeg-source.json');
  if (!existsSync(srcRecord)) blockers.push('FFmpeg kaynak paketi kaydı yok (node tools/ffmpeg-source.mjs)');
  else {
    const rec = JSON.parse(readFileSync(srcRecord, 'utf8'));
    const bundle = join(ROOT, 'apps', 'desktop', 'out', 'release-sources', rec.bundle.file);
    const named = existsSync(join(lic, 'FFMPEG-LGPL.md')) && readFileSync(join(lic, 'FFMPEG-LGPL.md'), 'utf8').includes(rec.bundle.sha256);
    report.checks.ffmpegSource = { revision: rec.revision, tree: rec.tree, bundle: rec.bundle.file, bundlePresent: existsSync(bundle), bundleMatches: existsSync(bundle) && sha256(bundle) === rec.bundle.sha256, namedInPackage: named };
    if (rec.electron !== electronVersion) blockers.push(`FFmpeg kaynak paketi Electron ${rec.electron} için, paket ${electronVersion}`);
    if (!report.checks.ffmpegSource.bundleMatches) blockers.push(`FFmpeg kaynak paketi (${rec.bundle.file}) yok ya da kayıttaki dosya değil`);
    if (!named) fails.push('FFMPEG-LGPL.md kaynak paketini (SHA-256) anmıyor');
  }

  // A local test package (package.mjs --test-signing) keeps macOS permissions across builds with a
  // weaker signature requirement; it must never be released.
  const macApp = join(dir, 'Zeyvola.app');
  if (process.platform === 'darwin' && existsSync(macApp)) {
    let req = '';
    try { req = execFileSync('codesign', ['-d', '-r-', macApp], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); } catch { /* unsigned */ }
    report.checks.testSigning = /designated => identifier "/.test(req);
    if (report.checks.testSigning) blockers.push('macOS: yerel test imzası (package.mjs --test-signing); yayın için seçeneksiz yeniden paketleyin');
  }

  if (release) for (const b of blockers) fails.push(`yayın engeli: ${b}`);
  Object.assign(report, { ok: fails.length === 0, fails, notes, blockers });
  return report;
}

function fixtures() {
  const dir = join(CACHE, 'codec-fixtures');
  if (['fixture.mp4', 'fixture.m4a', 'fixture-opus.m4a'].every((f) => existsSync(join(dir, f)))) return dir;
  mkdirSync(dir, { recursive: true });
  const bin = join(CACHE, 'make-fixture');
  execFileSync('swiftc', ['-O', '-o', bin, join(ROOT, 'tests', 'real-capture', 'make-fixture.swift')], { stdio: 'ignore' });
  // By macOS's own encoders: H.264 (fixture.mp4), AAC (fixture.m4a), and Opus written like the recorder's mic.m4a.
  execFileSync(bin, [dir], { stdio: 'ignore' });
  return dir;
}

function runtimeProbe(L, fails) {
  const out = join(mkdtempSync(join(tmpdir(), 'zeyvola-probe-')), 'probe.json');
  // Both output streams are kept: OpenH264 logs to stderr whenever it is started.
  const run = spawnSync(L.exe, ['--codec-probe', out, '--codec-fixtures', fixtures()], { encoding: 'utf8', timeout: 60_000 });
  const log = `${run.stdout ?? ''}${run.stderr ?? ''}`;
  if (run.status !== 0 || !existsSync(out)) {
    fails.push(`çalışma zamanı sondası çalışmadı (çıkış ${run.status ?? run.error?.message})`);
    return null;
  }
  const p = JSON.parse(readFileSync(out, 'utf8'));
  const r = p.encodeRuns;
  const summary = {
    distribution: p.distribution,
    h264DecodeSoftware: r['h264:prefer-hardware']?.decodedFrames?.['prefer-software'],
    h264DecodeHardware: r['h264:prefer-hardware']?.decodedFrames?.['prefer-hardware'],
    aacEncode: r['aac:audio']?.chunks ?? 0,
    aacDecode: r['aac:audio']?.decodedSamples,
    opusRoundTrip: r['opus:audio']?.decodedSamples,
    vp9RoundTrip: r['vp9:prefer-software']?.decodedFrames,
    osH264File: p.files['fixture.mp4']?.element?.ok ?? null,
    osAacFile: p.files['fixture.m4a']?.element?.ok ?? null,
    recorderOpusFile: p.files['fixture-opus.m4a']?.decodeAudioData?.ok ?? null,
    webmRecording: p.files['mediarecorder.webm']?.element?.ok ?? null,
    openH264Started: /\[OpenH264\]/.test(log),
  };
  if (typeof summary.h264DecodeSoftware === 'number') fails.push('paket H.264\'ü yazılımla çözebiliyor (FFmpeg H.264 çözücüsü yerinde)');
  if (typeof summary.aacDecode === 'number') fails.push('paket AAC çözebiliyor (FFmpeg AAC çözücüsü yerinde)');
  if (!(summary.opusRoundTrip > 0)) fails.push('Opus kodlama/çözme çalışmıyor');
  if (!(summary.vp9RoundTrip?.['prefer-software'] > 0)) fails.push('VP9 kodlama/çözme çalışmıyor');
  if (summary.webmRecording !== true) fails.push('WebM (MediaRecorder) kaydı oynatılamadı');
  if (summary.openH264Started) fails.push('sonda sırasında OpenH264 başlatıldı');
  if (summary.recorderOpusFile !== true) fails.push('kayıt yardımcısının Opus ses dosyası (biçim örneği) çözülemedi');
  return { summary, raw: p };
}

function print(r) {
  const line = (s) => process.stdout.write(`${s}\n`);
  line(`Codec denetimi · ${PROFILE_LABEL[r.profile]} · ${r.platform}-${r.arch} · Electron ${r.electron}`);
  const ff = r.checks.ffmpeg;
  line(`  libffmpeg: ${ff.matchesOfficialCodecFreeBuild ? 'Electron\'un resmi codec\'siz derlemesi' : 'resmi codec\'siz derleme DEĞİL'}${ff.decoders ? ` · çözücüler: ${ff.decoders.join(', ')}` : ''}`);
  line(`  Electron içinde: ${r.checks.compiledIn.filter((c) => c.present).map((c) => c.component).join(', ')}`);
  if (r.checks.recorder) line(`  macOS kayıt yardımcısı: ${r.checks.recorder.present ? `var (${r.checks.recorder.archs})` : 'yok'}`);
  const helper = (label, h) => { if (h) line(`  ${label}: ${h.present ? `var · bağlı: ${h.libraries.filter((l) => !l.startsWith('/usr/lib/swift/')).map((l) => l.split('/').pop()).join(', ')} · codec izi: ${h.codecMarkers.length ? h.codecMarkers.join(', ') : 'yok'}` : 'yok'}`); };
  helper('tıklama yardımcısı', r.checks.inputHelper);
  helper('ses yardımcısı', r.checks.audioHelper);
  const w = r.checks.windowsHelper;
  if (w) line(`  Windows yardımcısı: ${w.present ? `var · DLL: ${w.dlls.join(', ')} · yasak işlev: ${w.forbiddenFunctions.length ? w.forbiddenFunctions.join(', ') : 'yok'}` : 'yok'}`);
  const m = r.checks.microsoftTerms;
  if (m) line(`  Microsoft d3dcompiler koşulları: metin ${m.textShipped ? 'pakette' : 'YOK'} · ilk açılış kabul ekranı ${m.gateInApp ? 'var' : 'YOK'} · hukuki inceleme ${m.legalReview ? 'var' : 'yok'} · tazmin kararı ${m.indemnity ? 'var' : 'yok'}`);
  line(`  arayüzde H.264/AAC/HEVC dizeleri: ${Object.keys(r.checks.rendererCodecStrings).length ? Object.entries(r.checks.rendererCodecStrings).map(([k, v]) => `${k}×${v}`).join(' ') : 'yok'}`);
  const n = r.checks.notices;
  line(`  bildirimler: ${n.missing.length ? `EKSİK ${n.missing.join(', ')}` : 'tam'} · Chromium ${n.chromium?.entries ?? '?'} giriş${n.chromium?.matchesThisPlatformsElectron ? ' (bu platformun dosyası)' : ''} · ${n.packages ?? '?'} npm paketi`);
  if (n.binaries) line(`  ikililer: ${n.binaries.count} dosya · eşleşmeyen ${n.binaries.unmapped.length} · bildirimi eksik ${n.binaries.missing.length}`);
  if (r.checks.ffmpegSource) line(`  FFmpeg kaynağı: ${r.checks.ffmpegSource.revision.slice(0, 12)} · paket ${r.checks.ffmpegSource.bundleMatches ? 'hazır' : 'YOK'} · pakette anılıyor: ${r.checks.ffmpegSource.namedInPackage ? 'evet' : 'hayır'}`);
  if (r.checks.runtime) line(`  çalışma zamanı: ${JSON.stringify(r.checks.runtime.summary)}`);
  for (const s of r.notes) line(`  · ${s}`);
  for (const s of r.blockers) line(`  ! yayın engeli: ${s}`);
  for (const s of r.fails) line(`  ✗ ${s}`);
  line(r.ok ? '  SONUÇ: uygun' : '  SONUÇ: SORUNLU');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const dir = args.find((a) => !a.startsWith('--') && args[args.indexOf(a) - 1] !== '--profile' && args[args.indexOf(a) - 1] !== '--json');
  const profile = args[args.indexOf('--profile') + 1];
  if (!dir || !PROFILE_LABEL[profile]) { console.error('Kullanım: codec-audit.mjs <paket klasörü> --profile mp4|webm|webm-vp8 [--json out] [--probe] [--release]'); process.exit(2); }
  const r = await audit(resolve(dir), profile, { probe: args.includes('--probe'), release: args.includes('--release') });
  if (args.includes('--json')) writeFileSync(args[args.indexOf('--json') + 1], `${JSON.stringify(r, null, 1)}\n`);
  print(r);
  process.exit(r.ok ? 0 : 1);
}
