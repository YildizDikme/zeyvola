import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { probeWebmBytes, probeWebmFile, probeWebmFolder } from './webm-probe';

// Minimal EBML writer for test files shaped like MediaRecorder output (live stream:
// unknown-size Segment and Clusters, no duration, no index).
const idBytes = (id: number) => { const out: number[] = []; for (let v = id; v > 0; v = Math.floor(v / 256)) out.unshift(v % 256); return out; };
const sizeBytes = (n: number) => [0x10, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff]; // 4-byte vint
const UNKNOWN = [0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff];
const el = (id: number, data: number[]) => [...idBytes(id), ...sizeBytes(data.length), ...data];
const open = (id: number) => [...idBytes(id), ...UNKNOWN];
const uint = (v: number, n: number) => Array.from({ length: n }, (_, i) => (v / 256 ** (n - 1 - i)) & 0xff);
const block = (rel: number, payload = 200, fill = 0x55) => el(0xa3, [0x81, (rel >> 8) & 0xff, rel & 0xff, 0x80, ...new Array(payload).fill(fill)]);

function stream(clusters: Array<{ at: number; blocks: number[] }>, opts: { width?: number; audio?: boolean } = {}): number[] {
  const track = opts.audio
    ? el(0xae, [...el(0xd7, [1]), ...el(0x83, [2]), ...el(0xe1, [...el(0xb5, [0x47, 0x3b, 0x80, 0x00]), ...el(0x9f, [1])])]) // 48000 Hz float32
    : el(0xae, [...el(0xd7, [1]), ...el(0x83, [1]), ...el(0xe0, [...el(0xb0, uint(opts.width ?? 1280, 2)), ...el(0xba, uint(720, 2))])]);
  const out = [...el(0x1a45dfa3, [...el(0x4282, [...'webm'].map((c) => c.charCodeAt(0)))]), ...open(0x18538067),
    ...el(0x1549a966, el(0x2ad7b1, uint(1_000_000, 3))), ...el(0x1654ae6b, track)];
  for (const c of clusters) {
    out.push(...open(0x1f43b675), ...el(0xe7, uint(c.at, 4)));
    for (const b of c.blocks) out.push(...block(b));
  }
  return out;
}

describe('WebM probe (MediaRecorder files, also cut off by a crash)', () => {
  const frames = (n: number, step: number) => Array.from({ length: n }, (_, i) => Math.round(i * step));

  it('measures unknown-size clusters: first to last block plus one frame', () => {
    const b = new Uint8Array(stream([{ at: 0, blocks: frames(30, 33.333) }, { at: 1000, blocks: frames(30, 33.333) }]));
    const p = probeWebmBytes(b)!;
    expect(p.kind).toBe('video');
    expect(p.width).toBe(1280);
    expect(p.height).toBe(720);
    expect(p.blocks).toBe(60);
    expect(p.firstMs).toBe(0);
    expect(p.durationMs).toBeCloseTo(1967 + 33, 0);
  });

  it('ignores a block cut off at the end of the file', () => {
    const whole = stream([{ at: 0, blocks: frames(30, 33.333) }, { at: 1000, blocks: frames(10, 33.333) }]);
    const cut = new Uint8Array(whole.slice(0, whole.length - 50)); // inside the last block
    const p = probeWebmBytes(cut)!;
    expect(p.blocks).toBe(39);
    expect(p.durationMs).toBeCloseTo(1267 + 33, 0);
  });

  it('reads audio track details', () => {
    const p = probeWebmBytes(new Uint8Array(stream([{ at: 0, blocks: frames(50, 20) }], { audio: true })))!;
    expect(p.kind).toBe('audio');
    expect(p.sampleRate).toBe(48000);
    expect(p.channels).toBe(1);
    expect(p.durationMs).toBeCloseTo(1000, 0);
  });

  it('returns null when no complete block exists', () => {
    const b = stream([{ at: 0, blocks: [0] }]);
    expect(probeWebmBytes(new Uint8Array(b.slice(0, b.length - 100)))).toBeNull();
  });

  const dir = mkdtempSync(join(tmpdir(), 'zeyvola-webm-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('large files: reads only the head and the tail, skips the cluster pattern inside media data', async () => {
    const clusters = Array.from({ length: 60 }, (_, k) => ({ at: k * 1000, blocks: frames(30, 33.333) }));
    const bytes = stream(clusters);
    // A block whose data contains the Cluster ID, near the end (must not be taken for a Cluster).
    const fake = el(0xa3, [0x81, 0x00, 0x05, 0x80, 0x1f, 0x43, 0xb6, 0x75, 0x10, 0, 0, 4, 1, 2, 3, 4]);
    const cut = [...bytes, ...open(0x1f43b675), ...el(0xe7, uint(60_000, 4)), ...block(0), ...fake, ...block(33).slice(0, 20)];
    const file = join(dir, 'screen.webm');
    writeFileSync(file, new Uint8Array(cut));
    const p = (await probeWebmFile(file, { head: 4096, tail: 8192 }))!;
    expect(p.firstMs).toBe(0);
    expect(p.durationMs).toBeCloseTo(60_005 + 33, 0); // last complete block: the one at 60.005 s
    const full = probeWebmBytes(new Uint8Array(cut))!;
    expect(full.durationMs).toBeCloseTo(p.durationMs, 0);
  });

  it('folder probe reports unreadable files instead of failing', async () => {
    writeFileSync(join(dir, 'mic.weba'), new Uint8Array(stream([{ at: 0, blocks: frames(50, 20) }], { audio: true })));
    const r = await probeWebmFolder(dir, ['mic.weba', 'missing.webm']);
    expect(r[0]).toMatchObject({ name: 'mic.weba', kind: 'audio' });
    expect(r[1]).toMatchObject({ name: 'missing.webm', error: 'ENOENT' });
  });
});
