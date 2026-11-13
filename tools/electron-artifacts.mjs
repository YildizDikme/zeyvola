#!/usr/bin/env node
// Downloads official Electron release artifacts for packaging, with SHA-256 verification
// against the release's SHASUMS256.txt (done by @electron/get, Electron's own downloader).
// Files land in Electron's cache (~/Library/Caches/electron on macOS); nothing else is fetched.
//
//   node tools/electron-artifacts.mjs electron:win32:x64 ffmpeg:darwin:arm64 ...
//   node tools/electron-artifacts.mjs --print ffmpeg:darwin:arm64      (path only if cached; no download)
//
// Printed as JSON: { "<spec>": "<zip path>" }.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const req = createRequire(join(ROOT, 'apps', 'desktop', 'package.json'));
const electronDir = dirname(req.resolve('electron/package.json'));
export const ELECTRON_VERSION = JSON.parse(readFileSync(join(electronDir, 'package.json'), 'utf8')).version;

async function getter() {
  const r = createRequire(join(electronDir, 'package.json'));
  return import(pathToFileURL(r.resolve('@electron/get')).href);
}

function details(spec) {
  if (spec === 'SHASUMS256.txt') return { version: ELECTRON_VERSION, artifactName: 'SHASUMS256.txt', isGeneric: true, file: 'SHASUMS256.txt' };
  const [artifactName, platform, arch] = spec.split(':');
  if (!['electron', 'ffmpeg'].includes(artifactName) || !platform || !arch) throw new Error(`Geçersiz tanım: ${spec}`);
  return { version: ELECTRON_VERSION, artifactName, platform, arch, file: `${artifactName}-v${ELECTRON_VERSION}-${platform}-${arch}.zip` };
}

/** Already downloaded copy in Electron's cache, or null (never touches the network). */
export function cached(spec) {
  const { file } = details(spec);
  const base = process.env.electron_config_cache
    ?? (process.platform === 'darwin' ? join(homedir(), 'Library', 'Caches', 'electron')
      : process.platform === 'win32' ? join(process.env.LOCALAPPDATA ?? homedir(), 'electron', 'Cache')
        : join(process.env.XDG_CACHE_HOME ?? join(homedir(), '.cache'), 'electron'));
  if (!existsSync(base)) return null;
  for (const d of readdirSync(base)) if (existsSync(join(base, d, file))) return join(base, d, file);
  return null;
}

/**
 * The host's own zip tool, so packaging needs nothing installed: macOS ditto (keeps the framework
 * symlinks and signatures of a .app), Windows' bsdtar (System32\tar.exe, part of Windows 10 1803+;
 * named by full path because Git's GNU tar, earlier on PATH on CI runners, cannot read zip files),
 * elsewhere unzip / zip.
 */
function systemTar() {
  return join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');
}

export function extractZip(zip, dest) {
  if (process.platform === 'darwin') execFileSync('ditto', ['-x', '-k', zip, dest], { stdio: 'inherit' });
  else if (process.platform === 'win32') execFileSync(systemTar(), ['-x', '-f', zip, '-C', dest], { stdio: 'inherit' });
  else execFileSync('unzip', ['-q', zip, '-d', dest], { stdio: 'inherit' });
}

/** Zips `folder` itself (the archive's top entry is the folder's name). No __MACOSX entries. */
export function createZip(folder, zip) {
  if (process.platform === 'darwin') execFileSync('ditto', ['-c', '-k', '--norsrc', '--noextattr', '--noqtn', '--keepParent', folder, zip], { stdio: 'inherit' });
  else if (process.platform === 'win32') execFileSync(systemTar(), ['-a', '-c', '-f', zip, '-C', dirname(folder), basename(folder)], { stdio: 'inherit' });
  else execFileSync('zip', ['-q', '-r', '-y', zip, basename(folder)], { cwd: dirname(folder), stdio: 'inherit' });
}

/** spec: "<artifact>:<platform>:<arch>" (artifact: electron | ffmpeg) or "SHASUMS256.txt". */
export async function artifact(spec) {
  const { downloadArtifact } = await getter();
  const { file: _file, ...d } = details(spec);
  // The same folder cached() looks in (electron_config_cache, as electron/install.js uses it).
  return downloadArtifact({ ...d, ...(process.env.electron_config_cache ? { cacheRoot: process.env.electron_config_cache } : {}) });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const print = args.includes('--print');
  const out = {};
  for (const spec of args.filter((a) => !a.startsWith('--'))) {
    try { out[spec] = print ? cached(spec) : await artifact(spec); } catch (e) { out[spec] = null; console.error(`${spec}: ${e.message}`); process.exitCode = 1; }
  }
  console.log(JSON.stringify(out, null, 1));
}
