#!/usr/bin/env node
// Third-party notices for everything that ships inside Zeyvola.
//
//   node tools/third-party-notices.mjs --write        regenerate docs/THIRD_PARTY_NOTICES.md
//   node tools/third-party-notices.mjs --check        exit 1 if the notices or the inventory are out of date
//   node tools/third-party-notices.mjs --dist <dir>   write <dir>/licenses (used by the desktop build) and verify the bundle
//
// What ships is derived, not listed by hand: the production dependency graph of
// apps/desktop (workspace packages are our own code and are walked through), plus the
// Electron runtime. License texts are read from the installed packages; pnpm verifies each
// package against the integrity hash in pnpm-lock.yaml, so these are the files the authors
// published for exactly that version. The output has no timestamps, so it is reproducible.
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, parse, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const NOTICES_PATH = join('docs', 'THIRD_PARTY_NOTICES.md');
const SHIPPED_ALLOWED = new Set(['MIT', 'ISC', 'BSD-2-Clause', 'BSD-3-Clause', 'Apache-2.0', 'Zlib', '0BSD']);
const LICENSE_FILE = /^(licen[cs]e|copying)(\.(md|txt|markdown))?$/i;

const sha256 = (data) => createHash('sha256').update(data).digest('hex');
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));

/** Node-style lookup of `name` from `fromDir` (works with pnpm's layout and workspace links). */
function resolvePackage(fromDir, name) {
  let d = realpathSync(fromDir);
  for (;;) {
    const candidate = join(d, 'node_modules', name, 'package.json');
    if (existsSync(candidate)) return realpathSync(dirname(candidate));
    const up = dirname(d);
    if (up === d) return null;
    d = up;
  }
}

function describe(dir, pj) {
  const file = readdirSync(dir).find((f) => LICENSE_FILE.test(f));
  const text = file ? readFileSync(join(dir, file), 'utf8').replace(/\r\n/g, '\n').trim() : '';
  const repo = typeof pj.repository === 'string' ? pj.repository : pj.repository?.url ?? '';
  return {
    name: pj.name,
    version: pj.version,
    license: typeof pj.license === 'string' ? pj.license : pj.license?.type ?? '',
    licenseFile: file ?? null,
    copyright: text.split('\n').filter((l) => /^\s*copyright\b/i.test(l)).map((l) => l.trim()),
    repository: repo.replace(/^git\+/, '').replace(/\.git$/, '').replace(/^git:\/\//, 'https://'),
    textSha256: text ? sha256(text) : null,
    text,
  };
}

/** Packages that end up in the app: production dependency closure of apps/desktop. */
export function shippedPackages(root = ROOT) {
  const appDir = join(root, 'apps', 'desktop');
  const out = new Map();
  const visited = new Set();
  const visit = (fromDir, name, optional) => {
    const dir = resolvePackage(fromDir, name);
    if (!dir) {
      if (optional) return;
      throw new Error(`Paket bulunamadı: ${name} (${fromDir})`);
    }
    const pj = readJson(join(dir, 'package.json'));
    const key = `${pj.name}@${pj.version}`;
    if (visited.has(key)) return;
    visited.add(key);
    if (!pj.name.startsWith('@zeyvola/')) out.set(key, describe(dir, pj));
    for (const dep of Object.keys(pj.dependencies ?? {})) visit(dir, dep, false);
    for (const dep of Object.keys(pj.optionalDependencies ?? {})) visit(dir, dep, true);
  };
  const app = readJson(join(appDir, 'package.json'));
  for (const dep of Object.keys(app.dependencies ?? {})) visit(appDir, dep, false);
  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * The Electron runtime that is packaged with the app, with its Chromium notices.
 * `distDir` points at another platform's unpacked Electron (its LICENSE and
 * LICENSES.chromium.html differ per platform); by default the installed one is used.
 */
export function electronRuntime(root = ROOT, distDir = null) {
  const dir = resolvePackage(join(root, 'apps', 'desktop'), 'electron');
  if (!dir) throw new Error('electron paketi bulunamadı');
  const pj = readJson(join(dir, 'package.json'));
  const dist = distDir ?? join(dir, 'dist');
  if (distDir && existsSync(join(distDir, 'version')) && readFileSync(join(distDir, 'version'), 'utf8').trim() !== pj.version) {
    throw new Error(`${distDir}: Electron sürümü ${pj.version} değil`);
  }
  const licensePath = join(dist, 'LICENSE');
  const chromiumPath = join(dist, 'LICENSES.chromium.html');
  if (!existsSync(licensePath) || !existsSync(chromiumPath)) {
    throw new Error('Electron ikili dosyası kurulmamış (dist/LICENSE veya dist/LICENSES.chromium.html yok). `node node_modules/electron/install.js` çalıştırın.');
  }
  const text = readFileSync(licensePath, 'utf8').replace(/\r\n/g, '\n').trim();
  const html = readFileSync(chromiumPath, 'utf8');
  const titles = [...html.matchAll(/<span class="title">([\s\S]*?)<\/span>/g)].map((m) => m[1].replace(/<[^>]+>/g, '').trim());
  return {
    name: 'electron',
    version: pj.version,
    license: pj.license,
    copyright: text.split('\n').filter((l) => /^\s*copyright\b/i.test(l)).map((l) => l.trim()),
    text,
    licensePath,
    chromium: { path: chromiumPath, bytes: statSync(chromiumPath).size, sha256: sha256(html), entries: titles.length, titles },
  };
}

/**
 * Components Electron ships that its LICENSES.chromium.html does not cover (tools/notices-supplement.json).
 * `platform` keeps the rows of one package's platform; without it all rows are listed.
 */
export function supplementNotices(root = ROOT, platform = null) {
  const rows = readJson(join(root, 'tools', 'notices-supplement.json')).rows;
  return rows
    .filter((r) => !platform || r.platforms.includes(platform))
    .map((r) => ({ ...r, text: r.licenseFile ? readFileSync(join(root, 'tools', 'notices-supplement', r.licenseFile), 'utf8').replace(/\r\n/g, '\n').trim() : '' }));
}

export function codecNotes(root = ROOT) {
  return readJson(join(root, 'tools', 'codec-notes.json')).rows;
}

/**
 * Everything the notices are built from. `profile` (mp4 = A, webm = B, webm-vp8 = experimental
 * VP8) keeps only the codec rows of that distribution, for the notices inside a package; without
 * it all rows are listed.
 */
/**
 * The app's own license: the root LICENSE (PolyForm Shield 1.0.0, unchanged) and the NOTICE lines the
 * license asks every recipient to get ("Required Notice:", "Licensor Line of Business:").
 * null when there is no LICENSE yet.
 */
export function ownLicense(root = ROOT) {
  const file = join(root, 'LICENSE');
  if (!existsSync(file)) return null;
  const text = readFileSync(file, 'utf8');
  const name = /^# (.+)$/m.exec(text)?.[1]?.trim() ?? 'LICENSE';
  const noticeFile = join(root, 'NOTICE');
  const notice = existsSync(noticeFile) ? readFileSync(noticeFile, 'utf8').split('\n').filter((l) => /^(Required Notice|Licensor Line of Business):/.test(l)) : [];
  return { name, text, notice, placeholders: notice.some((l) => /<[^>]+>/.test(l)) };
}

export function collect(root = ROOT, { electronDist = null, profile = null, platform = null } = {}) {
  const electron = electronRuntime(root, electronDist);
  const codecs = codecNotes(root)
    .filter((c) => !profile || c.profiles.includes(profile))
    .map((c) => ({
      ...c,
      inChromiumNotice: c.chromiumTitle ? electron.chromium.titles.some((t) => t.toLowerCase() === c.chromiumTitle.toLowerCase()) : null,
    }));
  return { own: ownLicense(root), packages: shippedPackages(root), electron, codecs, profile, platform, supplements: supplementNotices(root, platform) };
}

const PROFILE_NAME = { mp4: 'A (yayımlanan: MP4 + WebM, macOS kayıt yardımcısı)', webm: 'B (MP4 + WebM, Chromium kaydı)', 'webm-vp8': 'VP8 (WebM, deneysel)' };

const STATUS_TR = { 'legal-review': 'Hukuki inceleme gerekli', 'low-risk-unverified': 'Düşük risk — hukuken doğrulanmadı' };

export function renderMarkdown(data) {
  const { packages, electron, codecs } = data;
  const L = [];
  L.push('# Üçüncü Taraf Yazılımlar / Third-Party Software');
  L.push('');
  L.push('<!-- Bu dosya `node tools/third-party-notices.mjs --write` ile üretilir; elle düzenlemeyin. -->');
  L.push('');
  L.push('Zeyvola, aşağıdaki üçüncü taraf yazılımları içerir. Her bileşen kendi lisansıyla dağıtılır; lisans metinleri aşağıdadır.');
  L.push('Zeyvola contains the third-party software listed below. Each component is distributed under its own license; the texts follow.');
  L.push('');
  if (data.own) {
    L.push(`**Zeyvola\'nın kendi lisansı: ${data.own.name}** (\`LICENSE\`). Bu dosya yalnızca üçüncü taraf bileşenleri kapsar.`);
    L.push(`*Zeyvola\'s own license: ${data.own.name}* (\`LICENSE\`). This file covers third-party components only.`);
    if (data.own.notice.length) { L.push(''); for (const l of data.own.notice) L.push(`> ${l}`); }
  } else {
    L.push('**Zeyvola\'nın kendi lisansı henüz seçilmedi.** Bu dosya yalnızca üçüncü taraf bileşenleri kapsar.');
    L.push('*Zeyvola\'s own license has not been chosen yet.* This file covers third-party components only.');
  }
  L.push('');
  L.push('## 1. Uygulamayla dağıtılan JavaScript paketleri / Bundled JavaScript packages');
  L.push('');
  L.push('| Paket / Package | Sürüm / Version | Lisans / License | Telif / Copyright |');
  L.push('|---|---|---|---|');
  for (const p of packages) L.push(`| ${p.name} | ${p.version} | ${p.license} | ${p.copyright.join('; ') || '—'} |`);
  L.push('');
  for (const p of packages) {
    L.push(`### ${p.name} ${p.version}`);
    L.push('');
    L.push(`Lisans / License: ${p.license}${p.repository ? ` · ${p.repository}` : ''}`);
    L.push('');
    L.push('```text');
    L.push(p.text);
    L.push('```');
    L.push('');
  }
  L.push(`## 2. Electron ${electron.version} ve Chromium / Electron and Chromium`);
  L.push('');
  L.push(`Zeyvola, Electron ${electron.version} çalışma ortamıyla dağıtılır. Electron ${electron.license} lisanslıdır:`);
  L.push('');
  L.push('```text');
  L.push(electron.text);
  L.push('```');
  L.push('');
  L.push(`Electron; Chromium, Node.js, FFmpeg ve diğer bileşenleri içerir. Bunların ${electron.chromium.entries} giriş içeren lisans bildirimleri`);
  L.push('uygulama paketinde `licenses/LICENSES.chromium.html` dosyasında yer alır ve uygulamanın Ayarlar → Lisanslar bölümünden açılabilir.');
  L.push(`Electron bundles Chromium, Node.js, FFmpeg and other components; their notices (${electron.chromium.entries} entries) ship as \`licenses/LICENSES.chromium.html\`.`);
  L.push('');
  L.push(`SHA-256 (LICENSES.chromium.html): \`${electron.chromium.sha256}\``);
  L.push('');
  L.push('## 2b. Electron ile gelen, Chromium bildiriminde bulunmayan bileşenler / Components shipped with Electron but missing from its Chromium notices');
  L.push('');
  L.push('Electron\'un `LICENSES.chromium.html` dosyası aşağıdaki bileşenleri kapsamıyor; lisansları burada verilir.');
  L.push('Electron\'s `LICENSES.chromium.html` does not cover the components below; their licenses follow.');
  L.push('');
  for (const r of data.supplements) {
    L.push(`### ${r.name} (${r.platforms.map((p) => (p === 'darwin' ? 'macOS' : 'Windows')).join(', ')})`);
    L.push('');
    L.push(`Sürüm / Version: ${r.version} · Lisans / License: ${r.license} · Kaynak / Source: ${r.source}`);
    L.push('');
    if (r.text) { L.push('```text'); L.push(r.text); L.push('```'); L.push(''); }
  }
  L.push('## 3. Codec\'ler: açık kaynak lisansı ve patent durumu ayrıdır / Codecs: open-source license and patents are separate');
  L.push('');
  L.push('Bir bileşenin açık kaynak (telif) lisansı, onu kullananlara patent lisansı vermez. Aşağıdaki patent notları **çözülmüş değildir**;');
  L.push('Bu tablo hukuki görüş değildir.');
  L.push('An open-source (copyright) license does not grant patent rights. The patent notes below are **not resolved** and are not legal advice.');
  L.push('');
  if (data.profile) L.push(`Bu paketin dağıtımı: **${PROFILE_NAME[data.profile]}**. This package's distribution: **${PROFILE_NAME[data.profile]}**.`, '');
  L.push('| Bileşen | Dağıtım | Nerede | Açık kaynak lisansı | Patent durumu | Değerlendirme |');
  L.push('|---|---|---|---|---|---|');
  for (const c of codecs) {
    const where = c.where.tr + (c.inChromiumNotice === true ? ' · Chromium bildiriminde var' : c.inChromiumNotice === false ? ' · Chromium bildiriminde bulunamadı' : '');
    L.push(`| ${c.name} | ${c.profiles.map((p) => PROFILE_NAME[p].split(' ')[0]).join(', ')} | ${where} | ${c.license.tr} | ${c.patent.tr} | ${STATUS_TR[c.status]} |`);
  }
  L.push('');
  return `${L.join('\n')}\n`;
}

/** Compact form for the in-app "Licenses" screen. */
export function renderJson(data) {
  const { packages, electron, codecs } = data;
  return JSON.stringify({
    ownLicense: data.own?.name ?? null,
    ownNotice: data.own?.notice ?? [],
    distribution: data.profile ?? null,
    packages: packages.map(({ name, version, license, copyright, repository, text }) => ({ name, version, license, copyright, repository, text })),
    electron: { version: electron.version, license: electron.license, copyright: electron.copyright, text: electron.text, chromiumEntries: electron.chromium.entries, chromiumFile: 'LICENSES.chromium.html' },
    codecs: codecs.map(({ id, name, profiles, where, license, patent, status, inChromiumNotice }) => ({ id, name, profiles, where, license, patent, status, inChromiumNotice })),
    supplements: data.supplements.map(({ id, name, platforms, version, license, source, text }) => ({ id, name, platforms, version, license, source, text })),
  }, null, 1);
}

/** npm packages present in a build's source maps. */
export function bundledPackages(distDir) {
  const found = new Set();
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.map')) {
        for (const s of readJson(p).sources ?? []) {
          const m = /node_modules\/(?:\.pnpm\/[^/]+\/node_modules\/)?((?:@[^/]+\/)?[^/]+)\//.exec(s);
          if (m && !m[1].startsWith('@zeyvola/')) found.add(m[1]);
        }
      }
    }
  };
  walk(distDir);
  return [...found].sort();
}

/** Problems with the shipped set itself (missing texts, licenses outside the policy). */
export function shippedProblems(data) {
  const problems = [];
  for (const p of data.packages) {
    if (!p.text) problems.push(`${p.name}@${p.version}: LICENSE dosyası yok`);
    if (!SHIPPED_ALLOWED.has(p.license)) problems.push(`${p.name}@${p.version}: lisans "${p.license}" dağıtım politikasında yok — kullanıcıya bildirin`);
  }
  if (data.electron.license !== 'MIT') problems.push(`electron: beklenmeyen lisans ${data.electron.license}`);
  for (const r of data.supplements) if (r.licenseFile && !r.text) problems.push(`${r.name}: lisans metni boş (tools/notices-supplement/${r.licenseFile})`);
  for (const c of data.codecs) {
    if (c.inChromiumNotice === false) problems.push(`codec "${c.name}": Chromium bildiriminde "${c.chromiumTitle}" girişi bulunamadı`);
    if (!STATUS_TR[c.status]) problems.push(`codec "${c.name}": geçersiz durum ${c.status}`);
    if (!Array.isArray(c.profiles) || !c.profiles.length || c.profiles.some((p) => !(p in PROFILE_NAME))) problems.push(`codec "${c.name}": geçersiz dağıtım listesi`);
  }
  return problems;
}

/** Installed packages (name@version); `portable` leaves out platform-specific binaries. */
function installedPackages(root) {
  const store = join(root, 'node_modules', '.pnpm');
  const all = new Set();
  const portable = new Set();
  for (const entry of existsSync(store) ? readdirSync(store) : []) {
    const nm = join(store, entry, 'node_modules');
    if (!existsSync(nm)) continue;
    for (const s of readdirSync(nm)) {
      for (const d of s.startsWith('@') ? readdirSync(join(nm, s)).map((n) => join(s, n)) : [s]) {
        const pjPath = join(nm, d, 'package.json');
        if (!existsSync(pjPath)) continue;
        let pj;
        try { pj = readJson(pjPath); } catch { continue; }
        if (!pj.name || !pj.version) continue;
        all.add(`${pj.name}@${pj.version}`);
        if (!pj.os && !pj.cpu) portable.add(`${pj.name}@${pj.version}`);
      }
    }
  }
  return { all, portable };
}

/** New or removed dependencies that docs/licenses/inventory.md does not reflect yet. */
export function inventoryGaps(root = ROOT) {
  const md = readFileSync(join(root, 'docs', 'licenses', 'inventory.md'), 'utf8');
  const listed = new Set();
  for (const line of md.split('\n')) {
    const m = /^\| ([^|]+?) \| ([^|]+?) \| [^|]*\| (?:var|yok) \|/.exec(line);
    if (m) listed.add(`${m[1].trim()}@${m[2].trim()}`);
  }
  const { all, portable } = installedPackages(root);
  return {
    // Platform-specific binaries (esbuild/rollup per OS, fsevents) differ between machines,
    // so only portable packages must be listed; stale rows are judged against everything installed.
    missingFromInventory: [...portable].filter((k) => !listed.has(k)).sort(),
    notInstalled: [...listed].filter((k) => !all.has(k) && !/(darwin|win32|linux|freebsd|android)/.test(k)).sort(),
  };
}

/** Writes <distDir>/licenses and checks that every bundled package is covered. */
export function writeDist(distDir, root = ROOT, { electronDist = null, profile = null, platform = null } = {}) {
  const data = collect(root, { electronDist, profile, platform });
  const out = join(distDir, 'licenses');
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, 'THIRD_PARTY_NOTICES.md'), renderMarkdown(data));
  writeFileSync(join(out, 'third-party.json'), renderJson(data));
  copyFileSync(data.electron.licensePath, join(out, 'electron-LICENSE.txt'));
  if (data.own) {
    writeFileSync(join(out, 'ZEYVOLA-LICENSE.md'), data.own.text);
    writeFileSync(join(out, 'NOTICE.txt'), `${data.own.notice.join('\n')}\n`);
  }
  copyFileSync(data.electron.chromium.path, join(out, 'LICENSES.chromium.html'));
  const shipped = new Set(data.packages.map((p) => p.name));
  const problems = shippedProblems(data);
  for (const b of bundledPackages(distDir)) if (!shipped.has(b)) problems.push(`derlemede ${b} var ama lisans bildirimlerinde yok`);
  return { problems, data };
}

function main(argv) {
  const has = (f) => argv.includes(f);
  if (has('--write')) {
    const data = collect();
    writeFileSync(join(ROOT, NOTICES_PATH), renderMarkdown(data));
    console.log(`${NOTICES_PATH} yazıldı: ${data.packages.length} paket + Electron ${data.electron.version}`);
    const problems = shippedProblems(data);
    for (const p of problems) console.error(`  ✗ ${p}`);
    return problems.length ? 1 : 0;
  }
  if (has('--dist')) {
    const dir = argv[argv.indexOf('--dist') + 1];
    if (!dir) { console.error('--dist <klasör> gerekli'); return 2; }
    const { problems } = writeDist(resolve(dir), ROOT, { profile: process.env.ZEYVOLA_DIST ?? 'mp4', platform: process.platform });
    const data = collect();
    const stale = readFileSync(join(ROOT, NOTICES_PATH), 'utf8') !== renderMarkdown(data);
    if (stale) problems.push(`${NOTICES_PATH} güncel değil: \`node tools/third-party-notices.mjs --write\` çalıştırıp değişikliği gözden geçirin`);
    for (const p of problems) console.error(`  ✗ ${p}`);
    console.log(problems.length ? 'Lisans bildirimleri: SORUNLU' : `Lisans bildirimleri: tamam (${data.packages.length} paket + Electron, ${data.electron.chromium.entries} Chromium girişi)`);
    return problems.length ? 1 : 0;
  }
  if (has('--check')) {
    const data = collect();
    const problems = shippedProblems(data);
    if (!existsSync(join(ROOT, NOTICES_PATH)) || readFileSync(join(ROOT, NOTICES_PATH), 'utf8') !== renderMarkdown(data)) {
      problems.push(`${NOTICES_PATH} güncel değil: \`node tools/third-party-notices.mjs --write\``);
    }
    const gaps = inventoryGaps();
    for (const k of gaps.missingFromInventory) problems.push(`envanterde yok: ${k} — lisansını doğrulayın, sonra \`node tools/license-inventory.mjs\``);
    for (const k of gaps.notInstalled) problems.push(`envanterde var ama kurulu değil: ${k} — \`node tools/license-inventory.mjs\``);
    for (const p of problems) console.error(`  ✗ ${p}`);
    console.log(problems.length ? `${problems.length} sorun` : 'Lisans bildirimleri ve envanter güncel.');
    return problems.length ? 1 : 0;
  }
  console.log('Kullanım: --write | --check | --dist <klasör>');
  return 2;
}

if (process.argv[1] && parse(process.argv[1]).base === 'third-party-notices.mjs') process.exit(main(process.argv.slice(2)));
