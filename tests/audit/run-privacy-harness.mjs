#!/usr/bin/env node
// Runs the independent privacy / export / performance harness (tests/audit/privacy-harness).
//
//   node tests/audit/run-privacy-harness.mjs
//
// Bundles audit.ts against the project's own packages into a temporary folder, starts it in
// Electron, prints the results and exits non-zero if any check fails. Nothing is written into
// the project; the report goes to the temp folder printed at the end.
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..');
const harness = join(here, 'privacy-harness');
const work = mkdtempSync(join(tmpdir(), 'zeyvola-denetim-'));

const pkg = (name) => join(root, 'packages', name, 'src', 'index.ts');
// esbuild is a dev dependency of the desktop app; pnpm may or may not hoist its binary.
const esbuild = [join(root, 'apps', 'desktop', 'node_modules', '.bin', 'esbuild'), join(root, 'node_modules', '.bin', 'esbuild')].find((p) => existsSync(p));
if (!esbuild) { console.error('esbuild bulunamadı; önce pnpm install çalıştırın.'); process.exit(1); }
execFileSync(esbuild, [
  join(harness, 'audit.ts'), '--bundle', '--format=esm', '--target=es2022', `--outfile=${join(work, 'audit.js')}`, '--log-level=warning',
  ...['compositor', 'project-model', 'media-web', 'timing', 'zoom-engine'].map((n) => `--alias:@zeyvola/${n}=${pkg(n)}`),
], { stdio: 'inherit' });
copyFileSync(join(harness, 'index.html'), join(work, 'index.html'));

const electron = join(root, 'apps', 'desktop', 'node_modules', '.bin', 'electron');
const run = spawnSync(electron, [join(harness, 'main.cjs')], { env: { ...process.env, AUDIT_OUT: work, AUDIT_BUNDLE_DIR: work }, stdio: 'ignore' });
if (run.status !== 0) { console.error(`Electron çıkış kodu ${run.status}`); process.exit(1); }

const r = JSON.parse(readFileSync(join(work, 'report.json'), 'utf8'));
if (r.timeout) { console.error('Zaman aşımı'); process.exit(1); }
let group = '';
for (const c of r.checks) {
  if (c.group !== group) { group = c.group; console.log(`\n[${group}]`); }
  console.log(`  ${c.ok ? '✓' : '✗'} ${c.name}${c.detail ? ` — ${c.detail}` : ''}`);
}
for (const e of r.errors ?? []) console.error(`HATA ${e}`);
console.log(`\nGPU: ${r.gpu}`);
console.log('Performans:', JSON.stringify({ compositor: r.perf?.compositor, encode: r.perf?.encode, long: r.perf?.long }, null, 1));
const failed = r.checks.filter((c) => !c.ok).length + (r.errors?.length ?? 0);
console.log(`\n${r.checks.length - r.checks.filter((c) => !c.ok).length}/${r.checks.length} kontrol geçti · rapor: ${join(work, 'report.json')}`);
process.exit(failed ? 1 : 0);
