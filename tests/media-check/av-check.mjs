#!/usr/bin/env node
// Runs av-check.swift (AVFoundation, macOS's own decoders) on an exported video.
//
//   node tests/media-check/av-check.mjs <file> [--require h264-aac] [--duration <seconds>]
//
// The test suites call avCheck() through a test-only channel (main.ts, smoke:avCheck), so
// `pnpm uitest` checks every exported MP4 this way. The probe is compiled with swiftc (the
// project's toolchain) into a temporary folder, once per version of its source.
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const SOURCE = join(here, 'av-check.swift');

export function buildAvCheck() {
  if (process.platform !== 'darwin') throw new Error('av-check yalnızca macOS’ta çalışır (AVFoundation)');
  const hash = createHash('sha256').update(readFileSync(SOURCE)).update(process.arch).digest('hex').slice(0, 16);
  const bin = join(tmpdir(), 'zeyvola-av-check', hash, 'av-check');
  if (existsSync(bin)) return bin;
  mkdirSync(dirname(bin), { recursive: true });
  const sdk = execFileSync('xcrun', ['--show-sdk-path'], { encoding: 'utf8' }).trim();
  execFileSync('swiftc', ['-O', '-swift-version', '5', '-sdk', sdk, '-target', `${process.arch === 'arm64' ? 'arm64' : 'x86_64'}-apple-macos13.0`,
    '-framework', 'AVFoundation', '-framework', 'CoreMedia', '-framework', 'CoreVideo', SOURCE, '-o', bin], { stdio: ['ignore', 'ignore', 'pipe'] });
  return bin;
}

/** @returns {{ ok: boolean, problems: string[], duration: number, video: object | null, audio: object | null }} */
export function avCheck(file, { require = 'h264-aac', duration } = {}) {
  const args = [resolve(file), ...(require ? ['--require', require] : []), ...(duration != null ? ['--duration', String(duration)] : [])];
  const r = spawnSync(buildAvCheck(), args, { encoding: 'utf8', timeout: 120_000 });
  const line = r.stdout.trim().split('\n').pop() ?? '';
  try {
    return JSON.parse(line);
  } catch {
    return { ok: false, problems: [`sonda çıktı vermedi (${r.status ?? r.signal}): ${r.stderr.slice(0, 300)}`], duration: 0, video: null, audio: null };
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const file = args.find((a, i) => !a.startsWith('--') && !['--require', '--duration'].includes(args[i - 1]));
  if (!file) { console.error('Kullanım: node tests/media-check/av-check.mjs <dosya> [--require h264-aac] [--duration sn]'); process.exit(2); }
  const opt = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
  const r = avCheck(file, { require: opt('--require') ?? 'h264-aac', duration: opt('--duration') != null ? Number(opt('--duration')) : undefined });
  console.log(JSON.stringify(r, null, 1));
  console.log(r.ok ? '✓ AVFoundation: oynatılabilir (H.264 görüntü + AAC ses)' : `✗ AVFoundation: ${r.problems.join('; ')}`);
  process.exit(r.ok ? 0 : 1);
}
