import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Schemas } from '@zeyvola/protocol';

vi.mock('./settings', () => ({ tm: (s: string, p?: Record<string, string>) => (p ? s.replace(/\{(\w+)\}/g, (_, k: string) => p[k] ?? '') : s) }));
const { MfExports, packetHeader, PACKET_END, PACKET_VIDEO } = await import('./mf-export');

const FAKE = resolve(import.meta.dirname, '__fixtures__', 'fake-mf-helper.mjs');
const fake = (mode = 'ok') => () => {
  process.env.FAKE_MF = mode;
  return { command: process.execPath, args: [FAKE] };
};
const OPTS = { width: 4, height: 2, fps: 30, bitrate: 1e6, audio: true };
const frame = (v: number) => new Uint8Array(4 * 2 * 3 / 2).fill(v);

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'zeyvola-mf-')); });
afterEach(async () => { delete process.env.FAKE_MF; await rm(dir, { recursive: true, force: true }); });

describe('Media Foundation export bridge', () => {
  it('writes the packet header the helper reads (little endian, 100 ns units)', () => {
    const h = packetHeader(PACKET_VIDEO, 3110400, 333_333, 333_334);
    expect(h.length).toBe(24);
    expect(h.readUInt32LE(0)).toBe(1);
    expect(h.readUInt32LE(4)).toBe(3110400);
    expect(h.readBigInt64LE(8)).toBe(333_333n);
    expect(h.readBigInt64LE(16)).toBe(333_334n);
    expect(packetHeader(PACKET_END, 0, 0, 0).readUInt32LE(0)).toBe(3);
  });

  it('streams frames and sound to the helper and names the file only when it is complete', async () => {
    const mf = new MfExports(fake());
    const target = join(dir, 'Demo.mp4');
    const { exportId } = await mf.begin(target, {}, OPTS);
    await mf.write(exportId, 'video', 0, 333_333, frame(1));
    await mf.write(exportId, 'audio', 0, 213_333, new Uint8Array([9, 9, 9, 9]));
    expect((await readdir(dir)).every((f) => f.endsWith('.zeyvola-part.mp4'))).toBe(true);
    expect(await mf.end(exportId, false)).toEqual({ path: target, bytes: 16 });
    expect([...await readFile(target)]).toEqual([...frame(1), 9, 9, 9, 9]);
    expect(await readdir(dir)).toEqual(['Demo.mp4']);
    expect(mf.pending).toBe(0);
  });

  it('never replaces a file unasked', async () => {
    const mf = new MfExports(fake());
    const target = join(dir, 'Demo.mp4');
    const { exportId } = await mf.begin(target, {}, OPTS);
    await writeFile(target, 'earlier');
    await mf.write(exportId, 'video', 0, 1, frame(2));
    expect((await mf.end(exportId, false))!.path).toBe(join(dir, 'Demo (2).mp4'));
    expect(await readFile(target, 'utf8')).toBe('earlier');
  });

  it('cancel stops the helper and deletes the partial file', async () => {
    const mf = new MfExports(fake());
    const { exportId } = await mf.begin(join(dir, 'Demo.mp4'), {}, OPTS);
    await mf.write(exportId, 'video', 0, 1, frame(3));
    expect(await mf.end(exportId, true)).toBeNull();
    expect(await readdir(dir)).toEqual([]);
    await expect(mf.write(exportId, 'video', 0, 1, frame(3))).rejects.toThrow('Dışa aktarma bulunamadı');
  });

  it('cancelAll removes every running export (window closed, app quitting)', async () => {
    const mf = new MfExports(fake());
    await mf.begin(join(dir, 'One.mp4'), {}, OPTS);
    await mf.begin(join(dir, 'Two.mp4'), {}, OPTS);
    expect(mf.pending).toBe(2);
    await mf.cancelAll();
    expect(mf.pending).toBe(0);
    expect(await readdir(dir)).toEqual([]);
  });

  it('a helper that refuses to set up its encoders fails at begin, before any frame (the app then writes WebM)', async () => {
    const mf = new MfExports(fake('refuse'));
    await expect(mf.begin(join(dir, 'Demo.mp4'), {}, OPTS)).rejects.toMatchObject({ name: 'MfError', stage: 'video-encoder', hr: '0xc00d36b4' });
    expect(await readdir(dir)).toEqual([]);
  });

  it('a helper that dies mid-way fails the export with its reason and leaves no file', async () => {
    const mf = new MfExports(fake('die'));
    const { exportId } = await mf.begin(join(dir, 'Demo.mp4'), {}, OPTS);
    await mf.write(exportId, 'video', 0, 1, frame(4)).catch(() => undefined);
    // The pipe may still take a packet or two before the helper is gone; then writes fail with its reason.
    let error: Error | null = null;
    for (let i = 0; i < 50 && !error; i++) {
      await new Promise((r) => setTimeout(r, 20));
      error = await mf.write(exportId, 'video', i, 1, frame(4)).then(() => null, (e: Error) => e);
    }
    expect(error?.message).toContain('video-write 0x8007000e');
    await expect(mf.end(exportId, false)).rejects.toThrow('video-write');
    expect(await readdir(dir)).toEqual([]);
  });

  it('a failed finish is an error and leaves no file', async () => {
    const mf = new MfExports(fake('finalize'));
    const { exportId } = await mf.begin(join(dir, 'Demo.mp4'), {}, OPTS);
    await mf.write(exportId, 'video', 0, 1, frame(5));
    await expect(mf.end(exportId, false)).rejects.toThrow('finalize 0x80004005');
    expect(await readdir(dir)).toEqual([]);
  });

  it('probes once per run: available, refused, or no helper', async () => {
    expect(await new MfExports(fake()).probe()).toEqual({ available: true, profile: 'high' });
    expect(await new MfExports(fake('refuse')).probe()).toEqual({ available: false, reason: 'video-encoder 0xc00d36b4' });
    expect(await new MfExports(() => null).probe()).toEqual({ available: false, reason: 'no-helper' });
    const missing = new MfExports(() => ({ command: join(dir, 'missing.exe'), args: [] }));
    expect(await missing.probe()).toEqual({ available: false, reason: 'no-helper' });
    let calls = 0;
    const counted = new MfExports(() => { calls++; return fake()(); });
    await counted.probe();
    await counted.probe();
    expect(calls).toBe(1);
  });
});

describe('Media Foundation export IPC', () => {
  const token = 'exp_' + 'ab'.repeat(12);
  it('begins with a target token and even sizes only, never a path', () => {
    const ok = { token, width: 1920, height: 1080, fps: 30, bitrate: 12_000_000, audio: true };
    expect(Schemas['export:mfBegin'].safeParse(ok).success).toBe(true);
    expect(Schemas['export:mfBegin'].safeParse({ ...ok, token: 'C:\\Users\\x\\a.mp4' }).success).toBe(false);
    expect(Schemas['export:mfBegin'].safeParse({ ...ok, width: 1921 }).success).toBe(false);
    expect(Schemas['export:mfBegin'].safeParse({ ...ok, fps: 0 }).success).toBe(false);
    expect(Schemas['export:mfBegin'].safeParse({ ...ok, path: '/tmp/x.mp4' }).data).not.toHaveProperty('path');
  });

  it('writes only to an export it started, with whole 100 ns times', () => {
    const ok = { exportId: 'mf_0123abcd-0123-4567-89ab-0123456789ab', kind: 'video', time: 0, duration: 333_333, data: new Uint8Array(6) };
    expect(Schemas['export:mfWrite'].safeParse(ok).success).toBe(true);
    expect(Schemas['export:mfWrite'].safeParse({ ...ok, exportId: '0123abcd-0123-4567-89ab-0123456789ab' }).success).toBe(false);
    expect(Schemas['export:mfWrite'].safeParse({ ...ok, kind: 'subtitle' }).success).toBe(false);
    expect(Schemas['export:mfWrite'].safeParse({ ...ok, time: -1 }).success).toBe(false);
    expect(Schemas['export:mfWrite'].safeParse({ ...ok, time: 0.5 }).success).toBe(false);
  });
});
