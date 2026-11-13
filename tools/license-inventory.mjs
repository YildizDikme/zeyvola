// Lists every installed npm package with its declared license and whether a LICENSE file
// ships with it, classifies them against the project policy, and writes
// docs/licenses/inventory.md. Exit code 1 if anything is blocked or unknown.
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { shippedPackages } from './third-party-notices.mjs';

const ROOT = process.cwd();
const ALLOWED = new Set(['MIT', 'ISC', 'BSD-2-Clause', 'BSD-3-Clause', 'Apache-2.0', '0BSD', 'Zlib', 'BlueOak-1.0.0', 'CC0-1.0', 'Unlicense', 'Python-2.0', 'CC-BY-4.0']);
const CONDITIONAL = new Set(['MPL-2.0', 'LGPL-2.1', 'LGPL-3.0', 'LGPL-2.1-or-later', 'LGPL-3.0-or-later']);
const store = join(ROOT, 'node_modules', '.pnpm');
const rows = new Map();

function classify(lic) {
  if (!lic) return 'belirsiz';
  const parts = lic.replace(/[()]/g, '').split(/\s+(?:OR)\s+/);
  if (parts.some((p) => ALLOWED.has(p.trim()))) return 'izinli';
  if (/\bAND\b/.test(lic) && lic.split(/\s+AND\s+/).every((p) => ALLOWED.has(p.trim()))) return 'izinli';
  if (parts.some((p) => CONDITIONAL.has(p.trim()))) return 'koşullu';
  return 'engel';
}

const direct = new Map();
for (const pkgJson of ['package.json', 'apps/desktop/package.json', ...readdirSync('packages').map((p) => `packages/${p}/package.json`)]) {
  const j = JSON.parse(readFileSync(pkgJson, 'utf8'));
  for (const [n] of Object.entries(j.dependencies ?? {})) if (!n.startsWith('@zeyvola/')) direct.set(n, 'çalışma zamanı');
  for (const [n] of Object.entries(j.devDependencies ?? {})) if (!direct.has(n)) direct.set(n, 'geliştirme');
}

for (const entry of existsSync(store) ? readdirSync(store) : []) {
  const nm = join(store, entry, 'node_modules');
  if (!existsSync(nm)) continue;
  for (const scopeOrName of readdirSync(nm)) {
    const dirs = scopeOrName.startsWith('@') ? readdirSync(join(nm, scopeOrName)).map((n) => join(scopeOrName, n)) : [scopeOrName];
    for (const d of dirs) {
      const pj = join(nm, d, 'package.json');
      if (!existsSync(pj)) continue;
      let j;
      try { j = JSON.parse(readFileSync(pj, 'utf8')); } catch { continue; }
      if (!j.name || !j.version) continue;
      const key = `${j.name}@${j.version}`;
      if (rows.has(key)) continue;
      const lic = typeof j.license === 'string' ? j.license : Array.isArray(j.licenses) ? j.licenses.map((l) => l.type).join(' OR ') : j.license?.type;
      const hasFile = readdirSync(join(nm, d)).some((f) => /^(licen[cs]e|copying)/i.test(f));
      rows.set(key, { name: j.name, version: j.version, license: lic ?? '', hasFile, cls: classify(lic), use: direct.get(j.name) ?? 'dolaylı' });
    }
  }
}

const list = [...rows.values()].sort((a, b) => a.name.localeCompare(b.name));
const count = (c) => list.filter((r) => r.cls === c).length;
// A conditional license matters for what is distributed: the app's packages (third-party-notices.mjs),
// never node_modules. MPL-2.0, for example, creates obligations only on distribution (MPL 2.0 FAQ, Q5).
const shipped = new Set(shippedPackages(ROOT).map((p) => `${p.name}@${p.version}`));
const conditional = list.filter((r) => r.cls === 'koşullu').map((r) => {
  const ships = shipped.has(`${r.name}@${r.version}`);
  return `- ${r.name}@${r.version} (${r.license}): ${ships ? '**uygulamayla dağıtılıyor**; lisansın dağıtım yükümlülükleri yerine getirilmeli' : 'uygulamayla dağıtılmıyor (yalnızca geliştirme/derleme aracı); dağıtım olmadığı için lisansın yükümlülükleri doğmaz'}`;
});
const lines = [
  '# Lisans envanteri (otomatik)',
  '',
  `Üretildi: ${new Date().toISOString()} · \`node tools/license-inventory.mjs\``,
  '',
  `Toplam ${list.length} paket · izinli ${count('izinli')} · koşullu ${count('koşullu')} · engel ${count('engel')} · belirsiz ${count('belirsiz')}`,
  '',
  'Bu tablo paket meta verisine dayanır. Dağıtıma girecek bileşenlerin lisansı, yayın öncesi kullanılan sürümün LICENSE dosyasından ayrıca doğrulanır.',
  '',
  ...(conditional.length ? ['Koşullu lisanslı paketler ve dağıtım durumu (dağıtılan paketler: `tools/third-party-notices.mjs`):', '', ...conditional, ''] : []),
  '| Paket | Sürüm | Lisans | LICENSE dosyası | Kullanım | Sınıf |',
  '|---|---|---|---|---|---|',
  ...list.map((r) => `| ${r.name} | ${r.version} | ${r.license || '—'} | ${r.hasFile ? 'var' : 'yok'} | ${r.use} | ${r.cls} |`),
  '',
  '## Elle eklenen bileşenler',
  '',
  '| Bileşen | Lisans | Kaynak | Not |',
  '|---|---|---|---|',
  '| Electron ikili dosyası (Chromium, Node; OpenH264, libvpx, libaom, dav1d, Opus içinde derlenmiş) | MIT + LICENSES.chromium.html | electron/electron, resmi sürüm zip’i (SHA-256 doğrulamalı) | Her pakette o platformun LICENSE ve LICENSES.chromium.html dosyası bulunur (tools/codec-audit.mjs denetler) |',
  '| FFmpeg (libffmpeg.dylib / ffmpeg.dll) | LGPL-2.1+ (LICENSES.chromium.html, “ffmpeg”) | Electron’un resmi ffmpeg-v<sürüm>-<platform>-<mimari>.zip derlemesi | Paketlerde tescilli codec’siz derleme kullanılır (H.264/AAC çözücüsü yok). Dinamik bağlı; kaynak teklifi: FFMPEG-LGPL.md. Geliştirme ortamındaki node_modules/electron hâlâ tescilli codec’li derlemeyi içerir |',
  '| macOS sistem çerçeveleri (VideoToolbox, AudioToolbox, AVFoundation, ScreenCaptureKit) | Apple macOS lisansı | macOS | Uygulamayla dağıtılmaz; H.264/AAC yalnızca bunlarla kodlanır (yayımlanan A dağıtımında macOS kayıt yardımcısı ve MP4 dışa aktarma; 2026-11-13’ten beri B’de de MP4 dışa aktarma). AVC bildirimi: macOS SLA §14 D |',
  '| Mantle, ReactiveObjC (macOS; Electron Framework bunlara bağlı) | MIT (Mantle: Proton bölümleri BSD) | Mantle/Mantle, ReactiveCocoa/ReactiveObjC 3.1.0 | Electron’un Chromium bildiriminde yok; metinler tools/notices-supplement/ içinden pakete girer |',
  '| d3dcompiler_47.dll (Windows) | Microsoft, Windows SDK dağıtılabilir kodu | Electron Windows zip’i | Pakette olduğu sürece son kullanıcı koşulları ilk açılışta kabul ettirilir (MICROSOFT-D3DCOMPILER-TERMS.txt); metnin hukuki incelemesi ve Microsoft’u tazmin yükümlülüğü için lisans verenin kararı bekliyor (tools/windows-terms.json, boşken yayın engeli). DLL’siz dağıtım seçeneği tools/windows-test ile gerçek Windows’ta denenecek |',
  '| dxil.dll, dxcompiler.dll (Windows) | Microsoft DXC lisansı / NCSA | Electron Windows zip’i | Paketlerden çıkarılır (yalnızca WebGPU için; Zeyvola WebGL2 kullanır) |',
  '| İkonlar, imleç, tepsi simgesi, arka planlar | Proje içi özgün çalışma | — | Kodla üretilir; dış görsel yok |',
  '| Zeyvola yardımcıları: zeyvola-recorder (macOS, yalnızca A), zeyvola-input, zeyvola-audio (macOS), zeyvola-win.exe (Windows) | Zeyvola’nın kendi lisansı (LICENSE) | native/recorder-macos, native/input-macos, native/audio-macos, native/helper-windows | Yalnızca işletim sistemi çerçevelerine / sistem DLL’lerine bağlı; tools/codec-audit.mjs bağlantıları denetler |',
  '| Zig 0.17.0 (yalnızca derleme aracı, pakete girmez) | MIT | ziglang.org resmi arşivi (SHA-256 doğrulandı), tools/.cache/zig | zeyvola-win.exe’yi çapraz derler. C çalışma zamanı, compiler-rt, MinGW-w64 başlığı veya içe aktarma kitaplığı bağlanmaz (bağlayıcı girdileri doğrulandı: yalnızca kendi nesne dosyamız ve imports/*.def’ten üretilen kitaplıklar) |',
  '| Windows ve Media Foundation API bildirimleri (native/helper-windows/win-api.h) | Proje içi özgün çalışma | Microsoft Learn; microsoft/windows-rs 0.62.2 (MIT veya Apache-2.0) yalnızca başvuru | Arayüz adları, değerler, yapı düzenleri ve COM yöntem sıraları; kod kopyalanmadı |',
  '| Windows sistem DLL’leri (KERNEL32, USER32, SHELL32, ole32, dwmapi, MFPlat, MFReadWrite) ve Media Foundation çözücüleri / kodlayıcıları | Microsoft Windows lisansı | Windows | Uygulamayla dağıtılmaz; MP4 dışa aktarmanın H.264 ve AAC’si Chromium üzerinden Media Foundation kodlayıcılarıyla yazılır (deneysel Windows paketi; Windows’ta test edilmedi). AAC sesi Windows’un kendi çözücüsüyle çözülür (Windows’ta test edilmedi) |',
  '| macOS AVFoundation / AVFAudio / CoreMedia (ses yardımcısı) | Apple macOS lisansı | macOS | Uygulamayla dağıtılmaz; içe aktarılan videoların AAC sesi macOS’un çözücüsüyle çözülüp Opus olarak yazılır |',
  '| Yazı tipleri | Sistem yazı tipleri (paketlenmiyor) | — | OFL aday yazı tipleri henüz eklenmedi |',
  '',
];
writeFileSync(join(ROOT, 'docs', 'licenses', 'inventory.md'), lines.join('\n'));
const bad = list.filter((r) => r.cls === 'engel' || r.cls === 'belirsiz');
console.log(`${list.length} paket · izinli ${count('izinli')} · koşullu ${count('koşullu')} · engel ${count('engel')} · belirsiz ${count('belirsiz')}`);
for (const r of list.filter((x) => x.cls !== 'izinli')) console.log(`  ${r.cls.padEnd(9)} ${r.name}@${r.version} (${r.license || 'lisans alanı yok'}) [${r.use}]`);
process.exit(bad.length ? 1 : 0);
