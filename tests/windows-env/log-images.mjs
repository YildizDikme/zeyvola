#!/usr/bin/env node
// Small pictures through the CI log (the artifact quota can be full): ci-summary.mjs writes each JPEG
// as numbered base64 lines, this script gets the files back from the saved log.
//
//   gh run view <id> --log > run.log
//   node tests/windows-env/log-images.mjs run.log <folder>      (or "-" to read standard input)
//
// Line format: ZEYVOLA_IMG <name> <part>/<parts> <base64>. The log's own prefix (job, step, time)
// before it is ignored. Writes <folder>/<name>.jpg; a picture with a missing part is reported, not written.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const MARK = 'ZEYVOLA_IMG';
const PART = 4000;

/** The log lines for one picture (a data: URL or bare base64). */
export function imageLines(name, jpeg, part = PART) {
  if (!/^[\w.-]{1,60}$/.test(name)) throw new Error(`bad picture name: ${name}`);
  const b64 = String(jpeg).replace(/^data:[^,]*,/, '');
  const parts = Math.max(1, Math.ceil(b64.length / part));
  const out = [];
  for (let i = 0; i < parts; i++) out.push(`${MARK} ${name} ${i + 1}/${parts} ${b64.slice(i * part, (i + 1) * part)}`);
  return out;
}

/** Pictures found in a log: name → { bytes } or { error } (missing parts). First complete copy wins. */
export function parseImages(text) {
  const seen = new Map();
  const re = new RegExp(`${MARK} ([\\w.-]{1,60}) (\\d+)/(\\d+) ([A-Za-z0-9+/=]*)`);
  for (const line of String(text).split(/\r?\n/)) {
    const m = re.exec(line);
    if (!m) continue;
    const [, name, i, n, data] = m;
    if (!seen.has(name)) seen.set(name, { n: Number(n), parts: new Map() });
    const e = seen.get(name);
    if (e.n === Number(n) && !e.parts.has(Number(i))) e.parts.set(Number(i), data);
  }
  const out = new Map();
  for (const [name, e] of seen) {
    const missing = [];
    for (let i = 1; i <= e.n; i++) if (!e.parts.has(i)) missing.push(i);
    if (missing.length) { out.set(name, { error: `eksik parçalar: ${missing.join(', ')} / ${e.n}` }); continue; }
    out.set(name, { bytes: Buffer.from([...Array(e.n)].map((_, i) => e.parts.get(i + 1)).join(''), 'base64') });
  }
  return out;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [src, dir] = process.argv.slice(2);
  if (!src || !dir) { console.error('kullanım: node tests/windows-env/log-images.mjs <run.log|-> <klasör>'); process.exit(2); }
  const text = readFileSync(src === '-' ? 0 : src, 'utf8');
  const pics = parseImages(text);
  if (!pics.size) { console.log('günlükte resim yok'); process.exit(1); }
  mkdirSync(dir, { recursive: true });
  let bad = 0;
  for (const [name, p] of pics) {
    if (p.error) { bad++; console.log(`✗ ${name}: ${p.error}`); continue; }
    const ok = p.bytes[0] === 0xff && p.bytes[1] === 0xd8;
    const file = join(dir, `${name}.jpg`);
    writeFileSync(file, p.bytes);
    console.log(`${ok ? '✓' : '? (JPEG başı değil)'} ${file} (${p.bytes.length} bayt)`);
  }
  process.exit(bad ? 1 : 0);
}
