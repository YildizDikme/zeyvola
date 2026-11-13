#!/usr/bin/env node
// Real capture test on this Mac, through the real Swift helper.
//
//   node tests/real-capture/run-real-capture.mjs [--only <name,…>] [--long-seconds 300] [--results <file>]
//   node tests/real-capture/run-real-capture.mjs --permissions   (only asks macOS for access)
//
// Starts the harness inside the development bundle "Zeyvola (geliştirme)" (so the permission
// dialogs name Zeyvola), shows a synthetic test pattern and records it. Recordings stay in a
// private temp folder printed at the end (they may contain camera and microphone data and
// are never copied into the repository); only measured numbers go into the results file.
import { execFileSync } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..');
const argv = process.argv.slice(2);
const opt = (name, fallback) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : fallback; };
const permissionsOnly = argv.includes('--permissions');
const longSeconds = Number(opt('--long-seconds', '180'));
const only = opt('--only', null)?.split(',');

const bundle = join(root, 'apps', 'desktop', '.dev-app', 'Zeyvola Geliştirme.app');
const helper = join(root, 'native', 'recorder-macos', 'bin', 'zeyvola-recorder');
if (!existsSync(bundle)) { console.error('Geliştirme uygulaması yok: önce `pnpm start` ile bir kez oluşturun.'); process.exit(1); }
if (!existsSync(helper)) { console.error('Kayıt yardımcısı yok: önce `pnpm native:mac`.'); process.exit(1); }

// Tools: the media probe (Swift) and the bundled TypeScript pieces.
const build = join(here, '.build');
mkdirSync(build, { recursive: true });
const sdk = execFileSync('xcrun', ['--show-sdk-path'], { encoding: 'utf8' }).trim();
const probe = join(build, 'media-probe');
execFileSync('swiftc', ['-O', '-swift-version', '5', '-sdk', sdk, '-target', `${process.arch === 'arm64' ? 'arm64' : 'x86_64'}-apple-macos13.0`,
  '-framework', 'AVFoundation', '-framework', 'CoreMedia', '-framework', 'CoreVideo', join(here, 'media-probe.swift'), '-o', probe], { stdio: 'inherit' });

const work = mkdtempSync(join(tmpdir(), 'zeyvola-gercek-kayit-'));
const out = join(work, 'kayitlar');
mkdirSync(out);
const esbuild = [join(root, 'apps', 'desktop', 'node_modules', '.bin', 'esbuild'), join(root, 'node_modules', '.bin', 'esbuild')].find((p) => existsSync(p));
if (!esbuild) { console.error('esbuild bulunamadı; önce pnpm install çalıştırın.'); process.exit(1); }
const alias = ['project-model', 'timing', 'zoom-engine', 'protocol'].map((n) => `--alias:@zeyvola/${n}=${join(root, 'packages', n, 'src', 'index.ts')}`);
execFileSync(esbuild, [join(root, 'apps', 'desktop', 'src', 'main', 'capture', 'helper-client.ts'), '--bundle', '--platform=node', '--format=cjs',
  '--target=node22', `--outfile=${join(work, 'helper-client.cjs')}`, '--log-level=warning', ...alias], { stdio: 'inherit' });
// The app's project store and crash recovery (Electron itself comes from the harness).
execFileSync(esbuild, [join(here, 'recovery-entry.ts'), '--bundle', '--platform=node', '--format=cjs', '--target=node22', '--external:electron',
  `--outfile=${join(work, 'recovery.cjs')}`, '--log-level=warning', ...alias], { stdio: 'inherit' });
execFileSync(esbuild, [join(here, 'analyze.ts'), '--bundle', '--platform=node', '--format=esm', '--target=node22',
  `--outfile=${join(work, 'analyze.mjs')}`, '--log-level=warning', ...alias], { stdio: 'inherit' });
for (const f of ['main.cjs', 'preload.cjs']) copyFileSync(join(here, 'harness', f), join(work, f));
cpSync(join(here, 'pattern'), join(work, 'pattern'), { recursive: true });
writeFileSync(join(work, 'package.json'), JSON.stringify({ name: 'zeyvola-gercek-kayit-testi', private: true, main: 'main.cjs' }));

const SCENARIOS = [
  // Region of the display (the pattern window), 60 fps, every source, pause and markers, clicks.
  // (The test tone is played by this app, so own-audio exclusion is turned off here to measure sync.)
  { name: 'bolge-60fps-tum-kaynaklar', target: 'region', fps: 60, quality: 'high', camera: true, mic: true, systemAudio: true, excludeOwnAudio: false,
    steps: [{ wait: 2 }, { do: 'mark' }, { wait: 1 }, { do: 'pause' }, { wait: 2 }, { do: 'resume' }, { wait: 1 }, { do: 'clicks', count: 6, timeout: 600 }, { wait: 2 }, { do: 'mark' }, { wait: 1 }, { do: 'stop' }] },
  // Default system audio: Zeyvola's own sound (the test tone) must not be recorded.
  { name: 'sistem-sesi-zeyvola-haric', target: 'window', fps: 30, quality: 'standard', systemAudio: true, steps: [{ wait: 6 }, { do: 'stop' }] },
  // Single window, 30 fps, screen only.
  { name: 'pencere-30fps', target: 'window', fps: 30, quality: 'standard', steps: [{ wait: 8 }, { do: 'stop' }] },
  // Long recording for timing drift, CPU and memory. Window capture: only the test
  // window is recorded, whatever else is on screen while the test runs.
  { name: 'uzun-kayit', target: 'window', fps: 60, quality: 'high', camera: true, mic: true, systemAudio: true, excludeOwnAudio: false, steps: [{ wait: longSeconds }, { do: 'stop' }] },
  // Sound/picture sync with the Opus audio files (the recorder wrote AAC before 2026-10-17).
  // Window capture (only the test window), system audio and microphone, no camera; the
  // microphone hears the test beep through the speakers.
  { name: 'esitlik-opus', target: 'window', fps: 60, quality: 'high', mic: true, systemAudio: true, excludeOwnAudio: false, steps: [{ wait: Number(opt('--sync-seconds', '90')) }, { do: 'stop' }] },
  // Helper killed mid-recording (after a marker and a pause): what survives on disk, and the
  // recording the app rebuilds from it into a real project (recover: as at the next start).
  { name: 'cokme-sigkill', target: 'window', fps: 30, quality: 'high', mic: true, recover: true,
    steps: [{ wait: 2 }, { do: 'mark' }, { wait: 1 }, { do: 'pause' }, { wait: 1 }, { do: 'resume' }, { wait: 4 }, { do: 'kill' }] },
  // App gone mid-recording (stdin closes): the helper must finish the files itself; the app
  // adds the recording to its project at the next start.
  { name: 'uygulama-kapandi', target: 'window', fps: 30, quality: 'high', mic: true, recover: true, steps: [{ wait: 5 }, { do: 'closeStdin' }] },
];
const scenarios = permissionsOnly ? [] : SCENARIOS.filter((s) => !only || only.includes(s.name));
const needsCamera = permissionsOnly || scenarios.some((s) => s.camera);
const needsMic = permissionsOnly || scenarios.some((s) => s.mic);
writeFileSync(join(work, 'config.json'), JSON.stringify({ helper, out, camera: needsCamera, mic: needsMic, scenarios }, null, 1));

console.log(`Test deseni açılıyor (${scenarios.length} senaryo). Kayıtlar: ${out}`);
// -n: separate instance, -W: wait until it quits. Arguments after --args reach Electron.
execFileSync('open', ['-n', '-W', bundle, '--args', work], { stdio: 'inherit' });

const report = JSON.parse(readFileSync(join(out, 'report.json'), 'utf8'));
console.log('İzinler:', JSON.stringify(report.permissions));
if (report.errors?.length) console.error('Hatalar:', report.errors);
if (report.needsScreenPermission) {
  console.log('Ekran kaydı izni henüz verilmedi. Sistem Ayarları › Gizlilik ve Güvenlik › Ekran ve Sistem Sesi Kaydı → "Zeyvola (geliştirme)".');
  process.exit(2);
}
if (!scenarios.length) process.exit(0);
const resultsPath = opt('--results', join(work, 'sonuclar.json'));
execFileSync(process.execPath, [join(work, 'analyze.mjs'), work, probe, resultsPath], { stdio: 'inherit' });
console.log(`\nSonuçlar: ${resultsPath}\nKayıt dosyaları (yerel, depoya eklenmez): ${out}`);
