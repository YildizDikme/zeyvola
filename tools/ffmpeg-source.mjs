#!/usr/bin/env node
// Builds the FFmpeg source bundle that must accompany every Zeyvola release (LGPL-2.1 §4 and §6 d:
// the corresponding source is offered "from the same place" as the binaries, i.e. as an asset of
// the same GitHub release). Zeyvola ships Electron's libffmpeg (ffmpeg.dll on Windows) unchanged.
//
//   node tools/ffmpeg-source.mjs [--out <dir>] [--rebundle]   → <dir>/zeyvola-ffmpeg-lgpl-source-electron-<v>.tar.gz
//
// What it collects (with the user's approval, 2026-10-17; only these files are read):
//   - the ffmpeg revision pinned by Chromium's DEPS for the Chromium version inside our Electron
//     (only the `ffmpeg_revision` line is extracted);
//   - the source archive of chromium/third_party/ffmpeg at that revision (served by Chromium's git host);
//   - Electron's patches for that repository (patches/ffmpeg) and its build arguments for the
//     separately published ffmpeg library (build/args/ffmpeg.gn), at the matching Electron tag.
// Nothing from these files goes into Zeyvola's code.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MAX_BYTES = 300 * 1024 * 1024;
const arg = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d; };
const out = resolve(arg('--out', join(ROOT, 'apps', 'desktop', 'out', 'release-sources')));

const req = createRequire(join(ROOT, 'apps', 'desktop', 'package.json'));
const electronPkg = JSON.parse(readFileSync(req.resolve('electron/package.json'), 'utf8'));
const electronVersion = electronPkg.version;
const electronBin = req('electron'); // path to the Electron executable
const chromeVersion = execFileSync(electronBin, ['-p', 'process.versions.chrome'], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8' }).trim();

async function get(url, { binary = false } = {}) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return binary ? Buffer.from(await res.arrayBuffer()) : res.text();
}

/** Streams a download to disk, stopping above MAX_BYTES. */
async function download(url, file) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const hash = createHash('sha256');
  const w = createWriteStream(file);
  let n = 0;
  for await (const chunk of res.body) {
    n += chunk.length;
    if (n > MAX_BYTES) { w.destroy(); rmSync(file, { force: true }); throw new Error(`${url}: ${MAX_BYTES} baytı aştı, durduruldu`); }
    hash.update(chunk);
    if (!w.write(chunk)) await new Promise((r) => w.once('drain', r));
  }
  await new Promise((r) => w.end(r));
  return { bytes: n, sha256: hash.digest('hex') };
}

const work = join(out, `ffmpeg-source-electron-${electronVersion}`);
// --rebundle: rebuild the bundle (README, tarball, record) from the files already downloaded into
// `work`, after checking them against SOURCE-INFO.json; nothing is downloaded.
const REBUNDLE = process.argv.includes('--rebundle');
const tag = `v${electronVersion}`;
const sha256File = (f) => createHash('sha256').update(readFileSync(f)).digest('hex');
let info, rev, commit, archiveName, patches;
if (REBUNDLE) {
  info = JSON.parse(readFileSync(join(work, 'SOURCE-INFO.json'), 'utf8'));
  if (info.electron !== electronVersion) throw new Error(`Kaynaklar Electron ${info.electron} için, kurulu ${electronVersion}`);
  ({ revision: rev } = info);
  commit = { tree: info.tree };
  archiveName = info.archive.file;
  if (sha256File(join(work, archiveName)) !== info.archive.sha256) throw new Error(`${archiveName} SOURCE-INFO.json ile eşleşmiyor`);
  patches = info.electronPatches.files;
  for (const f of patches) if (sha256File(join(work, 'electron-patches', f.name)) !== f.sha256) throw new Error(`${f.name} eşleşmiyor`);
  if (sha256File(join(work, info.buildArgs.file)) !== info.buildArgs.sha256) throw new Error(`${info.buildArgs.file} eşleşmiyor`);
} else {
  rmSync(work, { recursive: true, force: true });
  mkdirSync(join(work, 'electron-patches'), { recursive: true });

  // 1) Revision pinned by Chromium for this Chromium version (only the ffmpeg_revision line).
  const deps = Buffer.from(await get(`https://chromium.googlesource.com/chromium/src/+/refs/tags/${chromeVersion}/DEPS?format=TEXT`), 'base64').toString('utf8');
  rev = /'ffmpeg_revision':\s*'([0-9a-f]{40})'/.exec(deps)?.[1];
  if (!rev) throw new Error('DEPS içinde ffmpeg_revision bulunamadı');
  commit = JSON.parse((await get(`https://chromium.googlesource.com/chromium/third_party/ffmpeg/+/${rev}?format=JSON`)).slice(4));

  // 2) Source archive at that revision.
  archiveName = `chromium-ffmpeg-${rev.slice(0, 12)}.tar.gz`;
  const archive = await download(`https://chromium.googlesource.com/chromium/third_party/ffmpeg/+archive/${rev}.tar.gz`, join(work, archiveName));

  // 3) Electron's patches for that repository and its build arguments for the ffmpeg library.
  const config = JSON.parse(await get(`https://raw.githubusercontent.com/electron/electron/${tag}/patches/config.json`));
  const entry = config.find((c) => c.repo === 'src/third_party/ffmpeg');
  patches = [];
  if (entry) {
    const dir = entry.patch_dir.replace(/^src\/electron\//, '');
    const list = JSON.parse(await get(`https://api.github.com/repos/electron/electron/contents/${dir}?ref=${tag}`));
    for (const f of list.filter((x) => x.type === 'file')) {
      const data = await get(`https://raw.githubusercontent.com/electron/electron/${tag}/${dir}/${f.name}`, { binary: true });
      writeFileSync(join(work, 'electron-patches', f.name), data);
      patches.push({ name: f.name, bytes: data.length, sha256: createHash('sha256').update(data).digest('hex') });
    }
  }
  const gn = await get(`https://raw.githubusercontent.com/electron/electron/${tag}/build/args/ffmpeg.gn`, { binary: true });
  writeFileSync(join(work, `electron-${tag}-build-args-ffmpeg.gn`), gn);

  info = {
    library: 'FFmpeg (Chromium fork) as shipped by Electron: libffmpeg.dylib (macOS) / ffmpeg.dll (Windows)',
    license: 'LGPL-2.1-or-later (full text: LICENSES.chromium.html, entry "ffmpeg")',
    electron: electronVersion, chromium: chromeVersion,
    binaryVersionString: 'git-2026-07-15-6cfe2122b0',
    ffmpegRepository: 'https://chromium.googlesource.com/chromium/third_party/ffmpeg',
    revision: rev, tree: commit.tree, revisionDate: commit.committer?.time, revisionSubject: commit.message.split('\n')[0],
    archive: { file: archiveName, ...archive, url: `https://chromium.googlesource.com/chromium/third_party/ffmpeg/+archive/${rev}.tar.gz` },
    electronPatches: { source: `https://github.com/electron/electron/tree/${tag}/${entry?.patch_dir.replace(/^src\/electron\//, '') ?? 'patches/ffmpeg'}`, files: patches },
    buildArgs: { file: `electron-${tag}-build-args-ffmpeg.gn`, source: `https://github.com/electron/electron/blob/${tag}/build/args/ffmpeg.gn`, sha256: createHash('sha256').update(gn).digest('hex') },
    binaries: 'Electron official release assets ffmpeg-' + tag + '-<platform>-<arch>.zip (built without proprietary codecs), https://github.com/electron/electron/releases/tag/' + tag,
  };
  writeFileSync(join(work, 'SOURCE-INFO.json'), `${JSON.stringify(info, null, 1)}\n`);
}
writeFileSync(join(work, 'README.md'), `# FFmpeg source for Zeyvola ${JSON.parse(readFileSync(join(ROOT, 'apps', 'desktop', 'package.json'), 'utf8')).version}

Zeyvola ships the FFmpeg library from Electron ${electronVersion} unchanged (Electron's release asset
\`ffmpeg-${tag}-<platform>-<arch>.zip\`, built without proprietary codecs) as a separate, dynamically linked file.
It is licensed under the GNU Lesser General Public License 2.1 or later; the full text is in
\`LICENSES.chromium.html\` (entry "ffmpeg") inside every Zeyvola package.

Corresponding source (this folder):
- \`${archiveName}\`: chromium/third_party/ffmpeg at ${rev}, the revision Chromium ${chromeVersion} pins
  (the Chromium version inside Electron ${electronVersion}); git tree ${commit.tree}.
- \`electron-patches/\`: Electron's patches for this repository at ${tag} (applied in the order of \`.patches\`).
- \`electron-${tag}-build-args-ffmpeg.gn\`: Electron's build arguments for the separately published ffmpeg library.
  The rest of the build system is Chromium ${chromeVersion} and Electron ${tag} (both public).

Zeyvola bu FFmpeg kitaplığını değiştirmeden dağıtır. Kitaplığı arayüzle uyumlu bir sürümle değiştirebilirsiniz
(macOS'ta ardından uygulamayı yeniden imzalayın). Zeyvola'nın koşulları kitaplığın değiştirilmesini ve bu amaçla
hata ayıklama için tersine mühendisliği yasaklamaz.
`);
const bundle = join(out, `zeyvola-ffmpeg-lgpl-source-electron-${electronVersion}.tar.gz`);
execFileSync('tar', ['-czf', bundle, '-C', out, `ffmpeg-source-electron-${electronVersion}`]);
const bundleSha = createHash('sha256').update(readFileSync(bundle)).digest('hex');
writeFileSync(`${bundle}.sha256`, `${bundleSha}  ${bundle.split('/').pop()}\n`);
// The archive is regenerated by the server on every download (same files, different bytes), so the
// git tree id identifies the content; the bundle's SHA-256 identifies the exact file to publish.
const record = { electron: electronVersion, chromium: chromeVersion, binaryVersionString: info.binaryVersionString, revision: rev, tree: commit.tree, revisionDate: info.revisionDate,
  archive: info.archive, electronPatches: patches, buildArgsSha256: info.buildArgs.sha256, bundle: { file: bundle.split('/').pop(), bytes: statSync(bundle).size, sha256: bundleSha } };
// Kept in the repository: what each release must carry next to its packages (checked by codec-audit --release).
writeFileSync(join(ROOT, 'docs', 'licenses', 'ffmpeg-source.json'), `${JSON.stringify(record, null, 1)}\n`);
console.log(JSON.stringify(record, null, 1));
if (!existsSync(bundle)) process.exit(1);
