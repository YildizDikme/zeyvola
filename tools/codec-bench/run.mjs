#!/usr/bin/env node
// VP8 vs VP9 (+ Opus) on this machine, with the runtime the packages use: the installed
// official Electron with libffmpeg replaced by Electron's build without proprietary codecs.
// Encodes 1080p30/60 and 4K30/60 with the exporter's settings, measures time, CPU, size and
// luma quality, writes real WebM/MP4 files and plays each one back in Chromium.
//
//   node tools/codec-bench/run.mjs <result.json> [--files <dir>] [--seconds 6] [--only 1080p30,4K60]
import { execFileSync, spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..');
const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def; };
const out = args[0] && !args[0].startsWith('--') ? resolve(args[0]) : null;
if (!out) { console.error('Kullanım: run.mjs <sonuç.json> [--files <klasör>] [--seconds 6] [--only 1080p30,4K60]'); process.exit(2); }
const seconds = Number(opt('--seconds', '6'));
const filesDir = resolve(opt('--files', join(root, 'apps', 'desktop', 'out', 'codec-bench')));

// VP8 in MP4 ('vp08') is written only to check it: Chromium does not report support for it.
// The exporter's "high" quality bitrate for VP codecs (exporter.ts bitrateFor, vp = true).
const appBitrate = (w, h, fps) => {
  const px = w * h;
  const base = px >= 3840 * 2160 * 0.9 ? 40e6 : px >= 2560 * 1440 * 0.9 ? 22e6 : 12e6;
  return Math.round(base * (fps >= 50 ? 1.45 : 1) * 0.85);
};
const all = [[1920, 1080, 30], [1920, 1080, 60], [3840, 2160, 30], [3840, 2160, 60]];
const only = opt('--only', null)?.split(',');
const targets = all
  .map(([W, H, fps]) => ({ W, H, fps, bitrate: appBitrate(W, H, fps), name: `${H >= 2000 ? '4K' : `${H}p`}${fps}` }))
  .filter((t) => !only || only.includes(t.name));
const runs = [
  { codec: 'vp9', factor: 1, containers: ['webm', 'mp4'] },
  { codec: 'vp8', factor: 1, containers: ['webm', 'mp4'] },
  { codec: 'vp8', factor: 1.5, containers: ['webm'] },
  { codec: 'vp8', factor: 2, containers: ['webm'] },
];

const req = createRequire(join(root, 'apps', 'desktop', 'package.json'));
const { build } = req('esbuild');
const work = mkdtempSync(join(tmpdir(), 'zeyvola-codec-bench-'));
try {
  const appDir = join(work, 'app');
  await build({ entryPoints: [join(here, 'page.mjs')], bundle: true, format: 'iife', platform: 'browser', target: 'chrome140', outfile: join(appDir, 'page.js'), logLevel: 'warning' });
  copyFileSync(join(here, 'app', 'main.cjs'), join(appDir, 'main.cjs'));
  writeFileSync(join(appDir, 'package.json'), JSON.stringify({ name: 'zeyvola-codec-bench', private: true, main: 'main.cjs' }));
  writeFileSync(join(appDir, 'index.html'), '<!doctype html><meta charset="utf-8"><body style="margin:0"><script src="page.js"></script>');

  const electronApp = join(dirname(req.resolve('electron/package.json')), 'dist', 'Electron.app');
  const { cached } = await import(join(root, 'tools', 'electron-artifacts.mjs'));
  const zip = cached(`ffmpeg:darwin:${process.arch}`);
  if (!zip) { console.error(`Önce: node tools/electron-artifacts.mjs ffmpeg:darwin:${process.arch}`); process.exit(1); }
  execFileSync('cp', ['-cR', electronApp, join(work, 'Electron.app')]); // APFS clone
  execFileSync('ditto', ['-x', '-k', zip, join(work, 'ffmpeg')]);
  execFileSync('cp', [join(work, 'ffmpeg', 'libffmpeg.dylib'), join(work, 'Electron.app', 'Contents', 'Frameworks', 'Electron Framework.framework', 'Versions', 'A', 'Libraries', 'libffmpeg.dylib')]);
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', join(work, 'Electron.app')], { stdio: 'ignore' });
  const exe = join(work, 'Electron.app', 'Contents', 'MacOS', 'Electron');

  const config = { out, filesDir, root, seconds, targets, runs, repeat: 2 };
  const code = await new Promise((res) => {
    const p = spawn(exe, [appDir, '--bench', JSON.stringify(config)], { stdio: ['ignore', 'pipe', 'pipe'] });
    p.stdout.on('data', (d) => process.stdout.write(d));
    p.stderr.on('data', (d) => { const s = String(d); if (/error|fail/i.test(s) && !/GPU process|gles2|ContextResult/i.test(s)) process.stderr.write(s); });
    const timer = setTimeout(() => p.kill('SIGKILL'), 60 * 60_000);
    p.on('exit', (c) => { clearTimeout(timer); res(c); });
  });
  if (code !== 0 || !existsSync(out)) { console.error(`codec-bench başarısız (çıkış ${code})`); process.exit(1); }
  console.log(`Sonuç: ${out}\nDosyalar: ${filesDir}`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
