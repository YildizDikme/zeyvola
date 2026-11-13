#!/usr/bin/env node
// Prints what a Windows CI run found, from the files the test steps left in <out>: every suite's
// result (failed checks with their details, GPU, WebCodecs capabilities, the real recording, MP4
// availability), the terms flow and the environment dump. Also appended to the job summary
// (GITHUB_STEP_SUMMARY), so the results stay readable when the artifact cannot be uploaded.
//
//   node tests/windows-env/ci-summary.mjs <out>
import { appendFileSync, existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const out = process.argv[2];
if (!out || !existsSync(out)) { console.log(`ci-summary: klasör yok (${out})`); process.exit(0); }
const files = [];
const walk = (d) => { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) walk(p); else files.push(p); } };
walk(out);
const read = (f) => { try { return JSON.parse(readFileSync(f, 'utf8').replace(/^﻿/, '')); } catch { return null; } };
const lines = [];
const say = (s = '') => lines.push(s);

for (const f of files.filter((x) => x.endsWith('-report.json'))) {
  const r = read(f);
  const run = read(f.replace(/-report\.json$/, '-run.json'));
  if (!r) continue;
  const checks = r.checks ?? [];
  say(`## ${relative(out, f)}: ${r.ok ? 'tamam' : 'SORUNLU'} · ${checks.filter((c) => c.ok).length}/${checks.length} · ${r.gpu ?? ''}`);
  if (run) say(`süre ${run.seconds} sn, çıkış ${run.exitCode}${run.timedOut ? ' (zaman aşımı)' : ''}, OpenH264 satırı ${run.openH264Lines}`);
  if (r.error) say(`hata: ${r.error}`);
  if (r.mp4Missing) say(`MP4 yazılamıyor: ${r.mp4Missing}`);
  if (r.mp4Unavailable) say(`MP4 yazılamıyor (arayüz): ${r.mp4Unavailable}`);
  for (const c of checks) say(`${c.ok ? '✓' : '✗'} ${c.name}${c.detail ? ` — ${String(c.detail).slice(0, 600)}` : ''}`);
  if (r.capabilities) { say('Yetenekler:'); for (const [k, v] of Object.entries(r.capabilities)) say(`  ${k}: ${v}`); }
  if (r.realCapture) say(`Gerçek kayıt: ${JSON.stringify(r.realCapture)}`);
  if (r.exportFacts) say(`Dışa aktarma ölçüleri: ${JSON.stringify(r.exportFacts)}`);
  if (r.mp4Route || r.webCodecsH264 !== undefined) say(`MP4 yolu: ${r.mp4Route ?? '?'}, WebCodecs donanım H.264: ${r.webCodecsH264}`);
  if (r.userAgent) say(`userAgent: ${r.userAgent}`);
  say();
}
for (const f of files.filter((x) => x.endsWith('terms-flow.json'))) {
  const t = read(f);
  if (!t) continue;
  say(`## ${relative(out, f)}`);
  say(`DLL pakette ${JSON.stringify(t.dllInPackage)}, System32'de ${t.systemHasD3dcompiler47}, koşul metni ${t.termsFileInPackage}`);
  for (const s of [].concat(t.scenarios ?? [])) say(`${s.ok ? '✓' : '✗'} ${s.scenario}: ${JSON.stringify(s)}`);
  say();
}
for (const f of files.filter((x) => /platform-packages-.*\.json$/.test(x))) say(`## ${relative(out, f)} (docs/licenses/platform-packages.json için)\n${readFileSync(f, 'utf8')}\n`);
for (const f of files.filter((x) => /dll-watch-.*\.json$|removed-dll\.json$/.test(x))) say(`## ${relative(out, f)}\n${readFileSync(f, 'utf8')}\n`);
// The package with and without its d3dcompiler_47.dll: which smoke checks differ.
{
  const a = files.find((x) => /packaged[\\/]smoke-report\.json$/.test(x));
  const b = files.find((x) => /packaged-nodll[\\/]smoke-report\.json$/.test(x));
  const ra = a && read(a);
  const rb = b && read(b);
  if (ra && rb) {
    const ok = (r) => new Map((r.checks ?? []).map((c) => [c.name, c.ok]));
    const ma = ok(ra);
    const mb = ok(rb);
    const names = [...new Set([...ma.keys(), ...mb.keys()])];
    const diff = names.filter((n) => ma.get(n) !== mb.get(n));
    say(`## DLL'li ve DLL'siz paket: ${[...ma.values()].filter(Boolean).length}/${ma.size} ve ${[...mb.values()].filter(Boolean).length}/${mb.size} denetim geçti`);
    say(`oluşturucu: "${ra.gpu}" / "${rb.gpu}"`);
    for (const n of diff) say(`  fark: ${n} — DLL'li ${ma.get(n) ?? 'yok'}, DLL'siz ${mb.get(n) ?? 'yok'}`);
    if (!diff.length) say('  fark yok');
    say();
  }
}
for (const f of files.filter((x) => x.endsWith('helper-encode-probe.json'))) say(`## ${relative(out, f)}\n${readFileSync(f, 'utf8')}\n`);
for (const f of files.filter((x) => x.endsWith('uitest-clicks.json'))) say(`## ${relative(out, f)}\n${readFileSync(f, 'utf8')}\n`);

const text = lines.join('\n');
console.log(text || 'ci-summary: rapor bulunamadı');
if (process.env.GITHUB_STEP_SUMMARY && text) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${text}\n`);
