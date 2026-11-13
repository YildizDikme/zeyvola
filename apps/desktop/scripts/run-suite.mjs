// Runs one of the in-app test suites (src/shared/test-suite.ts) and prints its report.
//
//   node scripts/run-suite.mjs smoke [--no-build]
//   node scripts/run-suite.mjs perf [--label <name>] [--baseline <file|label>] [--no-build]
//   node scripts/run-suite.mjs ui   [--no-build] [--single]   (--single: without the forced-WebM second run)
//   node scripts/run-suite.mjs docs [--no-build]
//
// Common options:
//   --app <path>      run a packaged app instead of the development Electron (no build): the .app
//                     bundle (macOS), the folder with Zeyvola.exe (Windows) or the executable itself
//   --out <folder>    keep the report, the app's log and the screenshots there (CI artifacts)
//   --timeout <min>   stop the app after this many minutes (default 15)
//
// The app starts with a temporary projects folder and synthetic camera and microphone; the
// user's own projects and settings are never read. ZEYVOLA_DIST picks the distribution, as in
// every other build (with --app it only labels the output: the package decides).
// Exported MP4 files are checked with the operating system's own decoders (tests/media-check),
// which live outside the package: the probe's path is given to the app (ZEYVOLA_MEDIA_CHECK).
// The app's log is searched for OpenH264, which no Zeyvola code path may start.
import { execFileSync, spawn } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const appDir = resolve(here, '..');
const repo = resolve(appDir, '..', '..');
const require = createRequire(import.meta.url);

const SUITES = {
  smoke: { flag: '--smoke', title: 'Duman testi' },
  perf: { flag: '--perftest', title: 'Performans testi' },
  ui: { flag: '--uitest', title: 'Arayüz testi' },
  docs: { flag: '--docshots', title: 'Belge görüntüleri' },
};

const args = process.argv.slice(2).filter((a) => a !== '--');
const suite = args[0];
if (!suite || !(suite in SUITES)) {
  console.error(`Kullanım: node scripts/run-suite.mjs <${Object.keys(SUITES).join('|')}> [--app paket] [--out klasör] [--timeout dk] [--label ad] [--baseline dosya] [--no-build]`);
  process.exit(2);
}
const after = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] ?? null : null; };
const perfDir = join(appDir, 'out', 'perf');
const shotsOut = join(repo, 'docs', 'screenshots');

// The README pictures show the published distribution (A, the default build) unless asked otherwise.
if (suite === 'docs' && !process.env.ZEYVOLA_DIST) process.env.ZEYVOLA_DIST = 'mp4';
// Paths are printed relative to the repository, so no output shows the user's home folder.
const shown = (p) => relative(repo, p) || '.';
// Route 3 stands in for MP4 only where MP4 is exported (the A and B builds; not the VP8 build).
const PROFILE_HAS_MP4 = () => (process.env.ZEYVOLA_DIST ?? 'mp4') !== 'webm-vp8';

// perf: the comparison file is read before anything runs, so a wrong name fails at once.
const label = suite === 'perf' ? (after('--label') ?? new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)).replace(/[^\w.-]+/g, '-') : null;
let baseline = null;
if (suite === 'perf' && after('--baseline')) {
  const arg = after('--baseline');
  const file = existsSync(arg) ? resolve(arg) : join(perfDir, `${arg.replace(/\.json$/, '')}.json`);
  if (!existsSync(file)) {
    console.error(`Karşılaştırma dosyası bulunamadı: ${arg} (${shown(perfDir)}/ altındakiler: ${existsSync(perfDir) ? readdirSync(perfDir).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)).join(', ') : 'yok'})`);
    process.exit(2);
  }
  if (file === join(perfDir, `${label}.json`)) {
    console.error(`--label ile --baseline aynı dosya (${label}); karşılaştırma dosyasının üzerine yazılmaz.`);
    process.exit(2);
  }
  baseline = { file, ...JSON.parse(readFileSync(file, 'utf8')) };
}

// --app: the executable inside a packaged app.
function packagedExecutable(p) {
  const full = resolve(p);
  if (!existsSync(full)) return null;
  if (full.endsWith('.app')) {
    const macos = join(full, 'Contents', 'MacOS');
    const name = existsSync(macos) ? readdirSync(macos)[0] : null;
    return name ? join(macos, name) : null;
  }
  if (statSync(full).isDirectory()) {
    const exe = readdirSync(full).find((f) => /^zeyvola\.exe$/i.test(f)) ?? readdirSync(full).find((f) => f.toLowerCase().endsWith('.exe'));
    return exe ? join(full, exe) : null;
  }
  return full;
}
const appArg = after('--app');
const packaged = appArg ? packagedExecutable(appArg) : null;
if (appArg && !packaged) {
  console.error(`Paketlenmiş uygulama bulunamadı: ${appArg}`);
  process.exit(2);
}
const outArg = after('--out');
const outDir = outArg ? resolve(outArg) : null;
const timeoutMin = Number(after('--timeout') ?? 15);

if (!packaged && !args.includes('--no-build')) {
  execFileSync('pnpm', ['run', 'build'], { cwd: appDir, stdio: ['ignore', 'ignore', 'inherit'], shell: process.platform === 'win32' });
}

const work = mkdtempSync(join(tmpdir(), `zeyvola-${suite}-`));
const reportFile = join(work, 'report.json');
const shotsDir = join(work, 'shots');
const logFile = join(work, 'app.log');
const mediaCheck = join(repo, 'tests', 'media-check', 'av-check.mjs');
// Chromium's own log goes to stderr (on Windows it would otherwise go to a file next to the app).
async function runApp(file, extraEnv = {}) {
  const suiteArgs = [SUITES[suite].flag, '--smoke-report', file, '--enable-logging=stderr'];
  const [cmd, cmdArgs] = packaged ? [packaged, suiteArgs] : [require('electron'), [appDir, ...suiteArgs]];
  const child = spawn(cmd, cmdArgs, {
    cwd: packaged ? dirname(packaged) : appDir,
    env: { ...process.env, ZEYVOLA_SHOTS_DIR: shotsDir, ZEYVOLA_MEDIA_CHECK: mediaCheck, ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (d) => { out += d; }); // the report itself is read from the file
  child.stderr.on('data', (d) => { out += d; });
  let stopped = false;
  const killer = setTimeout(() => { stopped = true; child.kill(); }, timeoutMin * 60_000);
  const exit = await new Promise((res) => child.on('exit', (c) => res(c ?? 1)));
  clearTimeout(killer);
  return { code: exit, log: out, timedOut: stopped };
}
const t0 = Date.now();
const first = await runApp(reportFile);
const { code, timedOut } = first;
let log = first.log;
writeFileSync(logFile, log);
// OpenH264 prints "[OpenH264] this = 0x…" lines when it is started; Zeyvola never asks for it.
let openH264Lines = log.split('\n').filter((l) => l.includes('[OpenH264]')).length;
const errors = log;
/** Copies what this run produced to --out (report, log, screenshots) for CI artifacts. */
function keep(extra = {}) {
  if (!outDir) return;
  mkdirSync(outDir, { recursive: true });
  copyFileSync(logFile, join(outDir, `${suite}-app.log`));
  if (existsSync(reportFile)) copyFileSync(reportFile, join(outDir, `${suite}-report.json`));
  if (existsSync(shotsDir)) cpSync(shotsDir, join(outDir, `${suite}-shots`), { recursive: true });
  writeFileSync(join(outDir, `${suite}-run.json`), `${JSON.stringify({ suite, app: packaged ? 'packaged' : 'development', platform: process.platform, arch: process.arch, exitCode: code, timedOut, seconds: Math.round((Date.now() - t0) / 1000), openH264Lines, ...extra }, null, 1)}\n`);
}

if (!existsSync(reportFile)) {
  console.error(`${SUITES[suite].title}: rapor yazılmadı (çıkış kodu ${code}${timedOut ? `, ${timeoutMin} dk sonra durduruldu` : ''}).`);
  if (errors.trim()) console.error(errors.trim().split('\n').slice(-25).join('\n'));
  keep({ ok: false });
  process.exit(1);
}
const report = JSON.parse(readFileSync(reportFile, 'utf8'));

// ui: a second, short run of the export steps with route 3 forced (ZEYVOLA_TEST_EXPORT_ROUTE=webm,
// test runs only): WebM instead of MP4, said before and after the export. Every system can run it.
// --single skips it (CI runs that pass their own route settings).
if (suite === 'ui' && !args.includes('--single') && !process.env.ZEYVOLA_UITEST_ONLY && PROFILE_HAS_MP4()) {
  const second = join(work, 'report-webm.json');
  const r = await runApp(second, { ZEYVOLA_UITEST_ONLY: 'export', ZEYVOLA_TEST_EXPORT_ROUTE: 'webm', ZEYVOLA_TEST_EXPECT_ROUTE: 'webm-fallback' });
  log += `\n--- WebM'e düşüş (zorlanmış) ---\n${r.log}`;
  writeFileSync(logFile, log);
  openH264Lines += r.log.split('\n').filter((l) => l.includes('[OpenH264]')).length;
  const extra = existsSync(second) ? JSON.parse(readFileSync(second, 'utf8')) : { ok: false, checks: [{ name: 'rapor yazılmadı', ok: false, detail: `çıkış kodu ${r.code}` }] };
  report.checks = [...(report.checks ?? []), ...(extra.checks ?? []).map((c) => ({ ...c, name: `WebM'e düşüş (zorlanmış): ${c.name}` }))];
  report.ok = report.ok && extra.ok;
  report.fallbackPass = { ok: extra.ok, exportFacts: extra.exportFacts ?? null, mp4Unavailable: extra.mp4Unavailable ?? null };
  writeFileSync(reportFile, `${JSON.stringify(report, null, 1)}\n`);
}

const pad = (s, n) => String(s) + ' '.repeat(Math.max(0, n - [...String(s)].length));
const padL = (s, n) => ' '.repeat(Math.max(0, n - [...String(s)].length)) + String(s);
const num = (v) => (Number.isInteger(v) ? String(v) : v.toFixed(Math.abs(v) < 10 ? 2 : 1));

console.log(`\n${SUITES[suite].title} · ${packaged ? 'paketlenmiş uygulama' : 'geliştirme Electron’u'} · dağıtım ${report.dist ?? process.env.ZEYVOLA_DIST ?? 'mp4'}${report.gpu ? ` · ${report.gpu}` : ''}`);

if (suite === 'perf') {
  if (baseline) {
    console.log(`Karşılaştırma: ${baseline.label ?? basename(baseline.file, '.json')} (${baseline.at?.slice(0, 16).replace('T', ' ') ?? '?'}, dağıtım ${baseline.dist ?? '?'})`);
    if (baseline.dist && baseline.dist !== (process.env.ZEYVOLA_DIST ?? 'mp4')) console.log('  Uyarı: karşılaştırma dosyası başka bir dağıtımla ölçülmüş.');
  }
  const before = new Map();
  for (const sc of baseline?.scenarios ?? []) for (const x of sc.metrics) before.set(`${sc.name}|${x.name}`, x.value);
  let better = 0;
  let worse = 0;
  for (const sc of report.scenarios ?? []) {
    console.log(`\n${sc.name}${sc.note ? `  [${sc.note}]` : ''}`);
    for (const x of sc.metrics) {
      let line = `  ${pad(x.name, 36)} ${padL(num(x.value), 10)} ${pad(x.unit, 11)}`;
      const b = before.get(`${sc.name}|${x.name}`);
      if (b !== undefined) {
        const d = x.value - b;
        const pct = b !== 0 ? ` (${d >= 0 ? '+' : ''}${((d / b) * 100).toFixed(0)}%)` : '';
        // Changes under 5 %, or under 1 ms, are measurement noise on a desktop machine and are not judged.
        const judged = x.better && d !== 0 && (b === 0 || Math.abs(d / b) >= 0.05) && !(x.unit === 'ms' && Math.abs(d) < 1);
        const good = judged ? ((x.better === 'lower') === (d < 0)) : null;
        if (good === true) better++;
        if (good === false) worse++;
        line += ` önce ${padL(num(b), 10)}${pad(pct, 9)}${good === null ? '' : good ? '  ✓ daha iyi' : '  ✗ daha kötü'}`;
      } else if (baseline) {
        line += ' (yeni ölçüm)';
      }
      console.log(line);
    }
  }
  if (baseline) {
    const now = new Set((report.scenarios ?? []).map((sc) => sc.name));
    const gone = (baseline.scenarios ?? []).map((sc) => sc.name).filter((n) => !now.has(n));
    if (gone.length) console.log(`\nBu çalıştırmada olmayan senaryolar: ${gone.join('; ')}`);
    console.log(`\nKarşılaştırma: ${better} ölçüm daha iyi, ${worse} ölçüm daha kötü (%5'ten ya da 1 ms'den küçük farklar sayılmadı).`);
  }
  mkdirSync(perfDir, { recursive: true });
  const out = join(perfDir, `${label}.json`);
  writeFileSync(out, `${JSON.stringify({ label, at: new Date().toISOString(), dist: process.env.ZEYVOLA_DIST ?? 'mp4', ...report }, null, 1)}\n`);
  console.log(`\nToplam ${report.totalSeconds} sn · sonuç dosyası: ${shown(out)}`);
  if (!baseline) console.log(`Karşılaştırmak için: pnpm perftest -- --baseline ${label}`);
}

if (suite === 'docs' && report.ok) {
  // Replace the published set as a whole, so a renamed picture leaves no stale file behind.
  mkdirSync(shotsOut, { recursive: true });
  for (const f of readdirSync(shotsOut)) if (f.endsWith('.png')) rmSync(join(shotsOut, f));
  for (const f of report.shots ?? []) copyFileSync(f, join(shotsOut, basename(f)));
  console.log(`${(report.shots ?? []).length} görüntü → ${shown(shotsOut)}/`);
}

if (suite === 'smoke' && report.capabilities) {
  console.log('\nYetenekler (WebCodecs, MediaRecorder):');
  for (const [k, v] of Object.entries(report.capabilities)) console.log(`  ${pad(k, 34)} ${v}`);
}
// The capture window's shape report (renderer/capture.ts, "[zeyvola:capture-shape] {…}"): what the
// browser offered and delivered for the screen track, and which correction helped. Sizes only.
report.captureShape = log.split('\n').flatMap((l) => {
  const m = /\[zeyvola:capture-shape\] (\{.*\})/.exec(l);
  if (!m) return [];
  let j = m[1];
  // Chromium's console line ends with `", source: …`; keep the JSON object only.
  for (let end = j.length; end > 0; end = j.lastIndexOf('}', end - 1)) {
    try { return [JSON.parse(j.slice(0, end + 1))]; } catch { /* shorter */ }
  }
  return [];
});
// Chromium's own lines about WebGL contexts and the GPU process (a lost context's cause: the
// per-page context limit, a GPU process crash or reset). At most 30, for the report.
report.gpuLog = log.split('\n').filter((l) => /Too many active WebGL contexts|WebGL.*(lost|CONTEXT_LOST)|GPU process (exited|crashed|isn't usable)|GpuProcessHost|DXGI_ERROR|device (removed|reset)|lost context/i.test(l)).slice(0, 30).map((l) => l.slice(0, 300));
// Part of every suite's verdict: a run that started OpenH264 fails, whatever the app reported.
report.checks = [...(report.checks ?? []), { name: 'OpenH264 hiç başlatılmadı (uygulama günlüğünde [OpenH264] satırı yok)', ok: openH264Lines === 0, detail: `${openH264Lines} satır` }];
report.ok = report.ok && openH264Lines === 0;
// The report kept with --out is this one, with the OpenH264 check and the capture-shape lines.
writeFileSync(reportFile, `${JSON.stringify(report, null, 1)}\n`);
if (report.checks?.length) console.log('');
for (const c of report.checks ?? []) {
  console.log(`${c.ok ? '  ✓' : c.known ? '  ⚠' : '  ✗'} ${c.name}${c.detail ? `  — ${c.detail}` : ''}${c.ms ? `  (${Math.round(c.ms)} ms)` : ''}${!c.ok && c.known ? `  [bilinen sorun: ${c.known}]` : ''}`);
}
if (report.error) console.error(`Hata: ${report.error}`);
const failed = (report.checks ?? []).filter((c) => !c.ok && !c.known).length;
const known = (report.checks ?? []).filter((c) => !c.ok && c.known).length;
if (known) console.log(`\n${known} bilinen sorun (işi durdurmaz; ayrıntı yukarıda ⚠ satırlarında).`);
console.log(report.ok ? `\n${SUITES[suite].title}: tamam.` : `\n${SUITES[suite].title}: ${failed || 1} sorun.`);
keep({ ok: report.ok, checks: (report.checks ?? []).length, failed });
if (outDir) console.log(`Rapor, günlük ve görüntüler: ${shown(outDir)}`);
rmSync(work, { recursive: true, force: true });
process.exit(report.ok ? 0 : 1);
