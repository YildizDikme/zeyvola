// Runs one of the in-app test suites (src/shared/test-suite.ts) and prints its report.
//
//   node scripts/run-suite.mjs perf [--label <name>] [--baseline <file|label>] [--no-build]
//   node scripts/run-suite.mjs ui   [--no-build]
//   node scripts/run-suite.mjs docs [--no-build]
//
// The app starts with a temporary projects folder and synthetic camera and microphone; the
// user's own projects and settings are never read. ZEYVOLA_DIST picks the distribution, as in
// every other build.
import { execFileSync, spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const appDir = resolve(here, '..');
const repo = resolve(appDir, '..', '..');
const require = createRequire(import.meta.url);

const SUITES = {
  perf: { flag: '--perftest', title: 'Performans testi' },
  ui: { flag: '--uitest', title: 'Arayüz testi' },
  docs: { flag: '--docshots', title: 'Belge görüntüleri' },
};

const args = process.argv.slice(2).filter((a) => a !== '--');
const suite = args[0];
if (!suite || !(suite in SUITES)) {
  console.error(`Kullanım: node scripts/run-suite.mjs <${Object.keys(SUITES).join('|')}> [--label ad] [--baseline dosya] [--no-build]`);
  process.exit(2);
}
const after = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] ?? null : null; };
const perfDir = join(appDir, 'out', 'perf');
const shotsOut = join(repo, 'docs', 'screenshots');

// The README pictures show the published distribution (A, the default build) unless asked otherwise.
if (suite === 'docs' && !process.env.ZEYVOLA_DIST) process.env.ZEYVOLA_DIST = 'mp4';
// Paths are printed relative to the repository, so no output shows the user's home folder.
const shown = (p) => relative(repo, p) || '.';

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

if (!args.includes('--no-build')) {
  execFileSync('pnpm', ['run', 'build'], { cwd: appDir, stdio: ['ignore', 'ignore', 'inherit'] });
}

const work = mkdtempSync(join(tmpdir(), `zeyvola-${suite}-`));
const reportFile = join(work, 'report.json');
const shotsDir = join(work, 'shots');
const electron = require('electron');
const child = spawn(electron, [appDir, SUITES[suite].flag, '--smoke-report', reportFile], {
  cwd: appDir,
  env: { ...process.env, ZEYVOLA_SHOTS_DIR: shotsDir },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let errors = '';
child.stdout.on('data', () => undefined); // the report is read from the file
child.stderr.on('data', (d) => { errors += d; });
const code = await new Promise((res) => child.on('exit', (c) => res(c ?? 1)));

if (!existsSync(reportFile)) {
  console.error(`${SUITES[suite].title}: rapor yazılmadı (çıkış kodu ${code}).`);
  if (errors.trim()) console.error(errors.trim().split('\n').slice(-15).join('\n'));
  process.exit(1);
}
const report = JSON.parse(readFileSync(reportFile, 'utf8'));

const pad = (s, n) => String(s) + ' '.repeat(Math.max(0, n - [...String(s)].length));
const padL = (s, n) => ' '.repeat(Math.max(0, n - [...String(s)].length)) + String(s);
const num = (v) => (Number.isInteger(v) ? String(v) : v.toFixed(Math.abs(v) < 10 ? 2 : 1));

console.log(`\n${SUITES[suite].title} · dağıtım ${process.env.ZEYVOLA_DIST ?? 'mp4'}${report.gpu ? ` · ${report.gpu}` : ''}`);

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

if (report.checks?.length) console.log('');
for (const c of report.checks ?? []) {
  console.log(`${c.ok ? '  ✓' : '  ✗'} ${c.name}${c.detail ? `  — ${c.detail}` : ''}${c.ms ? `  (${Math.round(c.ms)} ms)` : ''}`);
}
if (report.error) console.error(`Hata: ${report.error}`);
const failed = (report.checks ?? []).filter((c) => !c.ok).length;
console.log(report.ok ? `\n${SUITES[suite].title}: tamam.` : `\n${SUITES[suite].title}: ${failed || 1} sorun.`);
rmSync(work, { recursive: true, force: true });
process.exit(report.ok ? 0 : 1);
