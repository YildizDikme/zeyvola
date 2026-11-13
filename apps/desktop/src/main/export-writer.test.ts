import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ExportBegin, ExportTargetRequest, Schemas } from '@zeyvola/protocol';

vi.mock('./settings', () => ({ tm: (s: string, p?: Record<string, string>) => (p ? s.replace(/\{(\w+)\}/g, (_, k: string) => p[k] ?? '') : s) }));
const { ExportTargets, ExportWriter, displayFolder, safeBaseName, uniquePath, writableFolder, writeErrorMessage } = await import('./export-writer');

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'zeyvola-export-writer-')); });
afterEach(async () => {
  await chmod(dir, 0o755).catch(() => undefined);
  await rm(dir, { recursive: true, force: true });
});

const bytes = (...v: number[]) => new Uint8Array(v);

describe('ExportWriter', () => {
  it('appends, patches positions and names the file only when it is complete', async () => {
    const w = new ExportWriter();
    const target = join(dir, 'Demo 16x9.webm');
    const { exportId } = await w.begin(target);
    await w.write(exportId, null, bytes(1, 2, 3, 4));
    await w.write(exportId, null, bytes(5, 6));
    await w.write(exportId, 1, bytes(9, 9));
    // While writing only the partial file exists.
    expect((await readdir(dir)).every((f) => f.endsWith('.zeyvola-part'))).toBe(true);
    expect(await w.end(exportId, false)).toEqual({ path: target, bytes: 6 });
    expect([...await readFile(target)]).toEqual([1, 9, 9, 4, 5, 6]);
    expect(await readdir(dir)).toEqual(['Demo 16x9.webm']);
    expect(w.pending).toBe(0);
  });

  it('never replaces a file unasked: a name taken meanwhile becomes "name (2)"', async () => {
    const w = new ExportWriter();
    const target = join(dir, 'Demo.mp4');
    const { exportId } = await w.begin(target);
    await writeFile(target, 'earlier export');
    await w.write(exportId, null, bytes(7));
    expect((await w.end(exportId, false))!.path).toBe(join(dir, 'Demo (2).mp4'));
    expect(await readFile(target, 'utf8')).toBe('earlier export');
  });

  it('replaces a file the user agreed to replace, and only once the new one is complete', async () => {
    const w = new ExportWriter();
    const target = join(dir, 'Demo.mp4');
    await writeFile(target, 'old');
    const { exportId } = await w.begin(target, { overwrite: true });
    await w.write(exportId, null, bytes(1, 2));
    expect(await readFile(target, 'utf8')).toBe('old');
    expect((await w.end(exportId, false))!.path).toBe(target);
    expect([...await readFile(target)]).toEqual([1, 2]);
  });

  it('cancel deletes the partial file, keeps a file it would have replaced, and refuses later writes', async () => {
    const w = new ExportWriter();
    const target = join(dir, 'Demo.webm');
    await writeFile(target, 'keep me');
    const { exportId } = await w.begin(target, { overwrite: true });
    void w.write(exportId, null, bytes(1, 2, 3));
    expect(await w.end(exportId, true)).toBeNull();
    expect(await readdir(dir)).toEqual(['Demo.webm']);
    expect(await readFile(target, 'utf8')).toBe('keep me');
    await expect(w.write(exportId, null, bytes(4))).rejects.toThrow('Dışa aktarma bulunamadı');
    expect(await w.end(exportId, true)).toBeNull();
  });

  it('cancelAll removes every running export (window closed, app quitting)', async () => {
    const w = new ExportWriter();
    const a = await w.begin(join(dir, 'One.webm'));
    const b = await w.begin(join(dir, 'Two.webm'));
    void w.write(a.exportId, null, bytes(1));
    void w.write(b.exportId, null, bytes(2));
    expect(w.pending).toBe(2);
    await w.cancelAll();
    expect(w.pending).toBe(0);
    expect(await readdir(dir)).toEqual([]);
  });

  it('cancelAll also waits for an export that is already being closed', async () => {
    const w = new ExportWriter();
    const a = await w.begin(join(dir, 'One.webm'));
    void w.write(a.exportId, null, bytes(1, 2));
    const closing = w.end(a.exportId, true);
    expect(w.pending).toBe(1);
    await w.cancelAll();
    expect(await readdir(dir)).toEqual([]);
    await expect(closing).resolves.toBeNull();
  });

  it('a failed write turns a finished export into an error and deletes the partial file', async () => {
    const w = new ExportWriter();
    const { exportId } = await w.begin(join(dir, 'Demo.webm'));
    // Simulate a full disk on the open file.
    const job = (w as unknown as { jobs: Map<string, { fh: { write: () => Promise<never> } }> }).jobs.get(exportId)!;
    job.fh.write = () => Promise.reject(Object.assign(new Error('no space'), { code: 'ENOSPC' }));
    await expect(w.write(exportId, null, bytes(1))).rejects.toThrow('Diskte yer kalmadı');
    await expect(w.end(exportId, false)).rejects.toThrow('Diskte yer kalmadı');
    expect(await readdir(dir)).toEqual([]);
  });

  it('a folder it may not write into gives a clear error, not a stack trace', async () => {
    const locked = join(dir, 'locked');
    await mkdir(locked);
    await chmod(locked, 0o555);
    expect(await writableFolder(locked)).toBe(false);
    expect(await writableFolder(dir)).toBe(true);
    expect(await writableFolder(join(dir, 'missing'))).toBe(false);
    await expect(new ExportWriter().begin(join(locked, 'Demo.mp4'))).rejects.toThrow('Bu klasöre yazma izni yok');
    await chmod(locked, 0o755);
  });
});

describe('export targets', () => {
  it('a token starts one export only', () => {
    const targets = new ExportTargets();
    const token = targets.issue({ path: '/x/Demo.mp4', overwrite: false, chosen: true });
    expect(token).toMatch(/^exp_[a-f0-9]{24}$/);
    expect(ExportBegin.safeParse({ token }).success).toBe(true);
    expect(targets.take(token)).toEqual({ path: '/x/Demo.mp4', overwrite: false, chosen: true });
    expect(targets.take(token)).toBeNull();
    expect(targets.take('exp_000000000000000000000000')).toBeNull();
  });

  it('the begin request carries a token, never a path', () => {
    expect(ExportBegin.safeParse({ token: '/Users/someone/Movies/x.mp4' }).success).toBe(false);
    expect(ExportBegin.safeParse({ token: 'pick_0123456789abcdef' }).success).toBe(false);
    expect(Schemas['export:begin'].safeParse({ projectId: 'p', suggestedName: 'x', extension: 'mp4' }).success).toBe(false);
    expect(ExportTargetRequest.safeParse({ projectId: 'prj_abcd1234', suggestedName: 'Demo', extension: 'mp4' }).success).toBe(true);
    expect(ExportTargetRequest.safeParse({ projectId: 'prj_abcd1234', suggestedName: 'Demo', extension: 'exe' }).success).toBe(false);
    expect(Schemas['export:chooseTarget']).toBe(ExportTargetRequest);
  });

  it('makes safe, unique names and readable folders', async () => {
    expect(safeBaseName('../../etc/Demo: 16/9')).toBe('etcDemo 169');
    expect(safeBaseName('...')).toBe('video');
    await writeFile(join(dir, 'Demo.mp4'), '');
    await writeFile(join(dir, 'Demo (2).mp4'), '');
    expect(await uniquePath(dir, 'Demo', 'mp4')).toBe(join(dir, 'Demo (3).mp4'));
    expect(await uniquePath(dir, 'Demo', 'webm')).toBe(join(dir, 'Demo.webm'));
    expect(displayFolder('/Users/a/Movies', '/Users/a')).toBe('~/Movies');
    expect(displayFolder('/Users/a', '/Users/a')).toBe('~');
    expect(displayFolder('/Volumes/Disk', '/Users/a')).toBe('/Volumes/Disk');
    expect(writeErrorMessage(Object.assign(new Error('x'), { code: 'ENOENT' }), '/Volumes/Gone')).toContain('Klasör bulunamadı: /Volumes/Gone');
  });
});
