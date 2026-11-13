#!/usr/bin/env node
// Real-use check (macOS): click positions in a window recording while the window moves and resizes.
//
//   node tests/real-capture-web/window-clicks/run.mjs [--out <result.json>] [--timeout <s>]
//
// Builds the app's window-following code (entry.ts), opens the test window and waits for six
// clicks on its yellow targets (four left, two right); after each click the window moves and/or
// resizes. Then every click the window saw is looked up in the app's cursor log: same button, same
// place relative to the window at that moment (±2 pt), same time (±50 ms). No video is recorded,
// so no screen recording permission is needed; the pointer helper needs none either.
import { execFileSync, spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..', '..');
const argv = process.argv.slice(2);
const opt = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null; };
const TICKS = 705_600_000;

const helper = join(root, 'native', 'input-macos', 'bin', 'zeyvola-input');
if (!existsSync(helper)) { console.error('Önce: pnpm native:input'); process.exit(1); }
const esbuild = [join(root, 'apps', 'desktop', 'node_modules', '.bin', 'esbuild'), join(root, 'node_modules', '.bin', 'esbuild')].find((p) => existsSync(p));
const electron = createRequire(join(root, 'apps', 'desktop', 'package.json'))('electron');

const work = mkdtempSync(join(tmpdir(), 'zeyvola-pencere-tiklama-'));
const alias = ['project-model', 'timing', 'zoom-engine', 'protocol'].map((n) => `--alias:@zeyvola/${n}=${join(root, 'packages', n, 'src', 'index.ts')}`);
execFileSync(esbuild, [join(here, 'entry.ts'), '--bundle', '--platform=node', '--format=cjs', '--target=node22', '--external:electron',
  `--outfile=${join(work, 'entry.cjs')}`, '--log-level=warning', ...alias], { stdio: 'inherit' });
for (const f of ['main.cjs', 'index.html']) copyFileSync(join(here, f), join(work, f));
writeFileSync(join(work, 'package.json'), JSON.stringify({ name: 'zeyvola-pencere-testi', private: true, main: 'main.cjs' }));

console.log(`Test penceresi açılıyor. Sarı karelere sırayla tıklayın (klasör: ${work}).`);
const child = spawn(electron, [work], { env: { ...process.env, ZEYVOLA_WC_OUT: work, ZEYVOLA_WC_HELPER: helper }, stdio: 'inherit' });
const timeout = setTimeout(() => child.kill(), Number(opt('--timeout') ?? 900) * 1000);
await new Promise((r) => child.on('exit', r));
clearTimeout(timeout);

const lines = (f) => (existsSync(join(work, f)) ? readFileSync(join(work, f), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const pattern = lines('pattern.jsonl');
const start = pattern.find((e) => e.type === 'start');
// Every click inside the window counts as a measurement, also one on the wrong target.
const clicks = pattern.filter((e) => e.type === 'click');
const done = pattern.find((e) => e.type === 'done');
const downs = lines('cursor.jsonl').filter((e) => e.e === 'd');
const reports = existsSync(join(work, 'window-reports.json')) ? JSON.parse(readFileSync(join(work, 'window-reports.json'), 'utf8')) : [];
const checks = [];
const check = (name, ok, detail) => checks.push({ name, ok, detail });

const layouts = new Set(clicks.map((c) => JSON.stringify(c.bounds)));
const moves = pattern.filter((e) => e.type === 'moved').length;
check('Altı adım tamamlandı', done?.steps === 6, `${done?.steps ?? 0} adım, ${clicks.length} tıklama, ${layouts.size} pencere konumu/boyutu`);
check('Pencere her taşınıp boyutlandığında yardımcı yeni sınırları bildirdi', reports.length >= moves + 1, `${reports.length} sınır bildirimi, ${moves} taşıma`);
check('Sağ tıklama da ölçüldü', clicks.some((c) => c.button === 2), `${clicks.filter((c) => c.button === 2).length} sağ tıklama`);
const rows = clicks.map((c) => {
  // The cursor-log entry for this click: the button-down closest in time.
  const d = downs.reduce((best, x) => {
    const err = Math.abs(start.startedAt + (x.t / TICKS) * 1000 - c.epochMs);
    return !best || err < best.err ? { x, err } : best;
  }, null);
  const b = c.bounds;
  const ex = (c.screenX - b.x) / b.width;
  const ey = (c.screenY - b.y) / b.height;
  return {
    step: c.step + 1, button: c.button === 2 ? 'r' : 'l', bounds: b,
    found: d?.x ?? null, timeErrMs: d ? Math.round(d.err) : null,
    posErrPt: d ? Math.hypot((d.x.x - ex) * b.width, (d.x.y - ey) * b.height) : null,
  };
});
const any = rows.length > 0;
check('Her tıklama imleç günlüğünde, doğru tuşla', any && rows.every((r) => r.found && r.found.b === r.button), `${rows.filter((r) => r.found && r.found.b === r.button).length}/${rows.length}`);
check('Konum pencereye göre doğru (±2 pt)', any && rows.every((r) => r.posErrPt !== null && r.posErrPt <= 2),
  `en büyük sapma ${Math.max(...rows.map((r) => r.posErrPt ?? Infinity)).toFixed(2)} pt`);
check('Zaman doğru (±50 ms)', any && rows.every((r) => r.timeErrMs !== null && r.timeErrMs <= 50),
  `en büyük fark ${Math.max(...rows.map((r) => r.timeErrMs ?? Infinity))} ms`);

const result = { ok: checks.every((c) => c.ok), checks, clicks: rows.map((r) => ({ step: r.step, button: r.button, window: r.bounds, posErrPt: r.posErrPt === null ? null : Math.round(r.posErrPt * 100) / 100, timeErrMs: r.timeErrMs })) };
for (const c of checks) console.log(`${c.ok ? '✓' : '✗'} ${c.name} — ${c.detail}`);
if (opt('--out')) writeFileSync(opt('--out'), `${JSON.stringify(result, null, 1)}\n`);
process.exit(result.ok ? 0 : 1);
