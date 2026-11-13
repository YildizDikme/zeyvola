import { randomBytes, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access, mkdir, open, rename, stat, type FileHandle } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, sep } from 'node:path';
import { exists, removeQuiet } from './fsutil';
import { tm } from './settings';

interface Job {
  /** Where the finished file goes. */
  path: string;
  /** The file being written; renamed to `path` only when the export finished. */
  part: string;
  /** The user confirmed replacing an existing file in the system save dialog. */
  overwrite: boolean;
  fh: FileHandle;
  queue: Promise<void>;
  bytes: number;
}

export interface Target {
  path: string;
  overwrite: boolean;
  chosen: boolean;
}

/** Characters kept in a file name the app makes up (letters, digits, space, . _ ( ) -). */
export function safeBaseName(name: string): string {
  return name.replace(/[^\p{L}\p{N} ._()-]+/gu, '').replace(/^[.\s]+/, '').trim().slice(0, 100) || 'video';
}

/** `dir/base.ext`, or `dir/base (2).ext`, `(3)`… when taken: an export never replaces a file unasked. */
export async function uniquePath(dir: string, base: string, ext: string): Promise<string> {
  let path = join(dir, `${base}.${ext}`);
  for (let n = 2; await exists(path); n++) path = join(dir, `${base} (${n}).${ext}`);
  return path;
}

/** A folder for display: the home folder as "~". */
export function displayFolder(dir: string, home = homedir()): string {
  return dir === home ? '~' : dir.startsWith(home + sep) ? `~${dir.slice(home.length)}` : dir;
}

/** A sentence for a failed file operation, naming the folder when it is the folder's fault. */
export function writeErrorMessage(e: unknown, folder: string): string {
  const code = (e as NodeJS.ErrnoException | null)?.code;
  const where = displayFolder(folder);
  if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') return tm("Bu klasöre yazma izni yok: {folder}. Başka bir klasör seçin.", { folder: where });
  if (code === 'ENOSPC' || code === 'EDQUOT') return tm("Diskte yer kalmadı. Yer açın ya da başka bir klasör seçin.");
  if (code === 'ENOENT' || code === 'ENOTDIR') return tm("Klasör bulunamadı: {folder}. Başka bir klasör seçin.", { folder: where });
  return tm("Dosya yazılamadı: {msg}", { msg: (e as Error)?.message ?? String(e) });
}

/** Resolves when `dir` is an existing folder this process may write into. */
export async function writableFolder(dir: string): Promise<boolean> {
  try {
    if (!(await stat(dir)).isDirectory()) return false;
    await access(dir, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * One-time tokens for export targets. The renderer never names a path: main picks one (its
 * default folder or the system save dialog) and hands out a token that starts one export.
 */
export class ExportTargets {
  private map = new Map<string, Target>();

  issue(target: Target): string {
    const token = `exp_${randomBytes(12).toString('hex')}`;
    this.map.set(token, target);
    // Tokens nobody used are forgotten after a while; a dialog open for hours asks again.
    if (this.map.size > 64) this.map.delete(this.map.keys().next().value!);
    return token;
  }

  /** The target for `token`, once: a second call returns null. */
  take(token: string): Target | null {
    const t = this.map.get(token) ?? null;
    this.map.delete(token);
    return t;
  }
}

/**
 * Streams export output from the renderer to disk. Supports appends and positioned writes
 * (muxers patch headers at the end). The video is written to a ".zeyvola-part" file next to
 * the target and gets its real name only when it is complete, so a cancelled or failed export
 * leaves nothing behind and never damages a file it was going to replace.
 */
export class ExportWriter {
  private jobs = new Map<string, Job>();
  /** Jobs being closed right now; `cancelAll` waits for them too. */
  private ending = new Set<Promise<unknown>>();

  /** Exports still writing or still being closed. */
  get pending(): number {
    return this.jobs.size + this.ending.size;
  }

  async begin(path: string, { overwrite = false }: { overwrite?: boolean } = {}): Promise<{ exportId: string; path: string }> {
    const dir = dirname(path);
    const part = join(dir, `${basename(path)}.${randomBytes(3).toString('hex')}.zeyvola-part`);
    let fh: FileHandle;
    try {
      await mkdir(dir, { recursive: true });
      fh = await open(part, 'wx');
    } catch (e) {
      throw new Error(writeErrorMessage(e, dir));
    }
    const exportId = randomUUID();
    this.jobs.set(exportId, { path, part, overwrite, fh, queue: Promise.resolve(), bytes: 0 });
    return { exportId, path };
  }

  write(exportId: string, position: number | null, data: Uint8Array): Promise<void> {
    const job = this.jobs.get(exportId);
    if (!job) return Promise.reject(new Error(tm("Dışa aktarma bulunamadı")));
    job.queue = job.queue.then(async () => {
      try {
        if (position === null) {
          await job.fh.write(data, 0, data.byteLength, job.bytes);
          job.bytes += data.byteLength;
        } else {
          await job.fh.write(data, 0, data.byteLength, position);
          job.bytes = Math.max(job.bytes, position + data.byteLength);
        }
      } catch (e) {
        throw new Error(writeErrorMessage(e, dirname(job.path)));
      }
    });
    return job.queue;
  }

  /**
   * Closes the file. With `cancel` (or when the file cannot be completed) the partial file is
   * deleted. Otherwise it gets its name; if another file took that name meanwhile and the user
   * did not agree to replace it, the export is named "name (2)" instead.
   */
  end(exportId: string, cancel: boolean): Promise<{ path: string; bytes: number } | null> {
    const job = this.jobs.get(exportId);
    if (!job) return Promise.resolve(null);
    this.jobs.delete(exportId);
    const done = this.close(job, cancel);
    this.ending.add(done);
    void done.finally(() => this.ending.delete(done)).catch(() => undefined);
    return done;
  }

  /** Cancels every running export and deletes its partial file (window closed, app quitting). */
  async cancelAll(): Promise<void> {
    const ids = [...this.jobs.keys()];
    await Promise.allSettled([...ids.map((id) => this.end(id, true)), ...this.ending]);
  }

  private async close(job: Job, cancel: boolean): Promise<{ path: string; bytes: number } | null> {
    let ok = !cancel;
    let failure: unknown = null;
    try {
      await job.queue.catch((e: unknown) => { ok = false; failure = e; });
      if (ok) await job.fh.sync();
    } catch (e) {
      ok = false;
      failure = e;
    } finally {
      await job.fh.close().catch(() => { ok = false; });
    }
    if (ok) {
      const dir = dirname(job.path);
      const name = basename(job.path);
      const dot = name.lastIndexOf('.');
      const final = job.overwrite || !(await exists(job.path)) ? job.path : await uniquePath(dir, name.slice(0, dot), name.slice(dot + 1));
      try {
        await rename(job.part, final);
        return { path: final, bytes: job.bytes };
      } catch (e) {
        failure = new Error(writeErrorMessage(e, dir));
      }
    }
    await removeQuiet(job.part);
    if (cancel) return null;
    throw failure instanceof Error ? failure : new Error(tm("Dışa aktarılan dosya diske yazılamadı."));
  }
}
