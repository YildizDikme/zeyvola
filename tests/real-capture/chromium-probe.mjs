#!/usr/bin/env node
// Runs chromium-probe/ with the runtime the distribution packages use: the installed official
// Electron with libffmpeg replaced by Electron's official build without proprietary codecs
// (from Electron's cache, SHA-256 checked when downloaded: tools/electron-artifacts.mjs).
//
//   node tests/real-capture/chromium-probe.mjs <result.json> <file>[:x,y,w,h[;x,y,w,h...]] ...
//   (--stock: run with the unmodified installed Electron instead)
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..');
const args = process.argv.slice(2);
const stock = args.includes('--stock');
const [out, ...files] = args.filter((a) => a !== '--stock');
if (!out || !files.length) { console.error('Kullanım: chromium-probe.mjs <sonuç.json> <dosya>[:x,y,w,h] ...'); process.exit(2); }
const req = createRequire(join(root, 'apps', 'desktop', 'package.json'));
const electronApp = join(dirname(req.resolve('electron/package.json')), 'dist', 'Electron.app');

let work = null;
let exe = join(electronApp, 'Contents', 'MacOS', 'Electron');
if (!stock) {
  const { cached } = await import(join(root, 'tools', 'electron-artifacts.mjs'));
  const zip = cached(`ffmpeg:darwin:${process.arch}`);
  if (!zip) { console.error(`Önce: node tools/electron-artifacts.mjs ffmpeg:darwin:${process.arch}`); process.exit(1); }
  work = mkdtempSync(join(tmpdir(), 'zeyvola-chromium-probe-'));
  execFileSync('cp', ['-cR', electronApp, join(work, 'Electron.app')]); // APFS clone
  execFileSync('ditto', ['-x', '-k', zip, join(work, 'ffmpeg')]);
  execFileSync('cp', [join(work, 'ffmpeg', 'libffmpeg.dylib'), join(work, 'Electron.app', 'Contents', 'Frameworks', 'Electron Framework.framework', 'Versions', 'A', 'Libraries', 'libffmpeg.dylib')]);
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', join(work, 'Electron.app')], { stdio: 'ignore' });
  exe = join(work, 'Electron.app', 'Contents', 'MacOS', 'Electron');
}
const r = spawnSync(exe, [join(here, 'chromium-probe'), '--out', resolve(out), ...files.flatMap((f) => ['--file', f.includes(':') ? `${resolve(f.split(':')[0])}:${f.split(':')[1]}` : resolve(f)])], { encoding: 'utf8', timeout: 15 * 60_000 });
if (work) rmSync(work, { recursive: true, force: true });
if (r.status !== 0 || !existsSync(out)) { console.error(r.stderr?.slice(-2000)); process.exit(1); }
console.log(`Chromium ölçümü${stock ? ' (değiştirilmemiş Electron)' : ' (codec\'siz FFmpeg)'}: ${out}`);
