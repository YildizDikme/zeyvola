#!/usr/bin/env node
// Puts Zig (MIT; build tool only, never part of a package) into tools/.cache/zig, the place
// apps/desktop/scripts/package.mjs and native/helper-windows/build.sh look first. Used to build
// zeyvola-win.exe (docs/licenses/inventory.md: "Zig 0.17.0 ... ziglang.org resmi arşivi, SHA-256").
//
//   node tools/zig-fetch.mjs            download (if not cached), verify, unpack; prints the zig path
//   node tools/zig-fetch.mjs --check    verify the cached archive only, no download
//
// The archive comes from ziglang.org's official download for one fixed version and must match the
// SHA-256 written below; otherwise nothing is unpacked and the script fails. Those hashes are the
// "shasum" fields of https://ziglang.org/download/index.json for 0.17.0 (read 2026-11-13; the
// aarch64-macos one also matches the archive this project used before, tools/.cache/zig-dl).
// Archives are kept in ZEYVOLA_ZIG_CACHE (default tools/.cache/zig-dl), so CI can cache them.
// Nothing but Node's own modules and the system's tar is used.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const ZIG_VERSION = '0.17.0';
/** From https://ziglang.org/download/index.json, "0.17.0" (date 2026-10-01). */
const RELEASES = {
  'win32-x64': { file: 'zig-x86_64-windows-0.17.0.zip', sha256: 'b5663f69581dcf391293fbf16c06cb80d81d806545ce618b4d0bab7f0eb8c428', size: 100268137 },
  'darwin-arm64': { file: 'zig-aarch64-macos-0.17.0.tar.xz', sha256: 'b607e9b9234790a008116ae5bdb71c6243b84b9fb42a53a9e70fde41c06c536a', size: 53985220 },
  'darwin-x64': { file: 'zig-x86_64-macos-0.17.0.tar.xz', sha256: '4f9a1c5269aa17ebda5e6d3c2b89d6cbf36f7d2b22a0306e9ab98f25f95529c6', size: 59317572 },
};

const key = `${process.platform}-${process.arch}`;
const rel = RELEASES[key];
if (!rel) { console.error(`Zig ${ZIG_VERSION}: bu sistem için sabitlenmiş arşiv yok (${key})`); process.exit(2); }
const cacheDir = resolve(process.env.ZEYVOLA_ZIG_CACHE ?? join(ROOT, 'tools', '.cache', 'zig-dl'));
const archive = join(cacheDir, rel.file);
const dest = join(ROOT, 'tools', '.cache', 'zig');
const exe = join(dest, process.platform === 'win32' ? 'zig.exe' : 'zig');
const sha = (f) => createHash('sha256').update(readFileSync(f)).digest('hex');

function verified() {
  if (!existsSync(archive)) return false;
  const got = sha(archive);
  if (got !== rel.sha256) throw new Error(`${rel.file}: SHA-256 tutmuyor (${got}, beklenen ${rel.sha256})`);
  return true;
}

if (process.argv.includes('--check')) {
  console.log(verified() ? `${rel.file}: SHA-256 doğru` : `${rel.file}: önbellekte yok`);
  process.exit(0);
}

if (!verified()) {
  const url = `https://ziglang.org/download/${ZIG_VERSION}/${rel.file}`;
  console.error(`İndiriliyor: ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const data = Buffer.from(await res.arrayBuffer());
  if (data.length !== rel.size) throw new Error(`${rel.file}: ${data.length} bayt, beklenen ${rel.size}`);
  const got = createHash('sha256').update(data).digest('hex');
  if (got !== rel.sha256) throw new Error(`${rel.file}: SHA-256 tutmuyor (${got}, beklenen ${rel.sha256}); dosya kaydedilmedi`);
  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(archive, data);
}

// Unpacked again only when the version there differs (the stamp is written last).
const stamp = join(dest, '.zeyvola-zig');
if (!(existsSync(exe) && existsSync(stamp) && readFileSync(stamp, 'utf8').trim() === rel.sha256)) {
  mkdirSync(dirname(dest), { recursive: true });
  const work = mkdtempSync(join(dirname(dest), 'zig-unpack-'));
  // Windows' own bsdtar (System32) reads zip; on macOS /usr/bin/tar reads .tar.xz.
  const tar = process.platform === 'win32' ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : process.platform === 'darwin' ? '/usr/bin/tar' : 'tar';
  execFileSync(tar, ['-x', '-f', archive, '-C', work], { stdio: 'inherit' });
  const top = readdirSync(work).find((n) => n.startsWith('zig-'));
  if (!top) throw new Error(`${rel.file}: beklenen klasör yok`);
  rmSync(dest, { recursive: true, force: true });
  renameSync(join(work, top), dest);
  rmSync(work, { recursive: true, force: true });
  writeFileSync(stamp, `${rel.sha256}\n`);
}
const version = execFileSync(exe, ['version'], { encoding: 'utf8' }).trim();
if (version !== ZIG_VERSION) throw new Error(`zig version: ${version}, beklenen ${ZIG_VERSION}`);
console.log(exe);
