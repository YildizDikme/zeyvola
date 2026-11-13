/**
 * MP4 export through Windows' own Media Foundation encoders (H.264 + AAC, software), run by the
 * Windows helper (native/helper-windows, `--encode-mp4`). Used only when the renderer has no
 * hardware H.264 encoder (WebCodecs), so an MP4 export still works without a GPU encoder; the
 * software H.264 encoder bundled in Electron (OpenH264) is never used.
 *
 * The renderer sends NV12 frames and 16-bit stereo PCM; this module passes them to the helper's
 * stdin as packets (24-byte header, then the data) and waits for the pipe to drain, so a slow
 * encoder slows the export instead of filling memory. The file is written next to its target
 * as "<name>.mp4.<random>.zeyvola-part.mp4" (the Sink Writer picks the container from the
 * extension) and gets its real name only when complete; cancel, failure, a closed window or
 * quitting deletes it, like ExportWriter's partial files.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, rename, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { exists, removeQuiet } from './fsutil';
import { uniquePath, writeErrorMessage } from './export-writer';
import { tm } from './settings';

export const PACKET_VIDEO = 1;
export const PACKET_AUDIO = 2;
export const PACKET_END = 3;
const HEADER = 24;

/** The 24-byte little-endian packet header: kind, length, time and duration (100 ns units). */
export function packetHeader(kind: number, length: number, time: number, duration: number): Buffer {
  const b = Buffer.alloc(HEADER);
  b.writeUInt32LE(kind, 0);
  b.writeUInt32LE(length, 4);
  b.writeBigInt64LE(BigInt(Math.round(time)), 8);
  b.writeBigInt64LE(BigInt(Math.round(duration)), 16);
  return b;
}

export interface MfEncodeOptions { width: number; height: number; fps: number; bitrate: number; audio: boolean }

/** How to start the helper; tests pass a stand-in. */
export type HelperCommand = () => { command: string; args: string[] } | null;

export interface HelperAnswer { type: string; stage?: string; hr?: string; frames?: number; profile?: string }

/** A helper failure in the user's language, with the step and Windows' error code for support. */
export class MfError extends Error {
  constructor(readonly stage: string, readonly hr: string | undefined, message: string) {
    super(message);
    this.name = 'MfError';
  }
}

export function helperError(a: HelperAnswer | null, exitCode: number | null): MfError {
  const stage = a?.stage ?? 'exit';
  const detail = a?.hr ? `${stage} ${a.hr}` : `${stage}${exitCode !== null ? ` ${exitCode}` : ''}`;
  return new MfError(stage, a?.hr, tm("Windows'un H.264 kodlayıcısı çalışmadı ({detail}).", { detail }));
}

interface Job {
  path: string;
  part: string;
  overwrite: boolean;
  child: ChildProcessWithoutNullStreams;
  /** Settles when the helper exits: its last answer and exit code. */
  exited: Promise<{ answer: HelperAnswer | null; code: number | null }>;
  last: HelperAnswer | null;
  failed: MfError | null;
}

/** Reads the helper's stdout JSON lines; resolves `ready` on {"type":"ready"}. */
function listen(child: ChildProcessWithoutNullStreams, onAnswer: (a: HelperAnswer) => void): void {
  let rest = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    rest += chunk;
    let i: number;
    while ((i = rest.indexOf('\n')) >= 0) {
      const line = rest.slice(0, i).trim();
      rest = rest.slice(i + 1);
      if (!line) continue;
      try { onAnswer(JSON.parse(line) as HelperAnswer); } catch { /* not ours */ }
    }
  });
}

export class MfExports {
  private jobs = new Map<string, Job>();
  private ending = new Set<Promise<unknown>>();
  private probed: Promise<{ available: boolean; reason?: string; profile?: string }> | null = null;

  constructor(private readonly helper: HelperCommand, private readonly startTimeoutMs = 30_000) {}

  get pending(): number {
    return this.jobs.size + this.ending.size;
  }

  /**
   * Can this computer write MP4 this way? One tiny encode (320×180, two frames, 0.1 s of sound)
   * through the helper, done once per app run.
   */
  probe(): Promise<{ available: boolean; reason?: string; profile?: string }> {
    this.probed ??= (async () => {
      const cmd = this.helper();
      if (!cmd) return { available: false, reason: 'no-helper' };
      const file = join(tmpdir(), `zeyvola-mf-probe-${randomBytes(4).toString('hex')}.mp4`);
      const child = spawn(cmd.command, [...cmd.args, '--encode-probe', file], { stdio: ['pipe', 'pipe', 'pipe'] });
      let last: HelperAnswer | null = null;
      listen(child, (a) => { last = a; });
      child.stdin.end();
      const code = await new Promise<number | null>((resolve) => {
        const timer = setTimeout(() => { child.kill(); resolve(null); }, this.startTimeoutMs);
        child.on('error', () => { clearTimeout(timer); resolve(-1); });
        child.on('exit', (c) => { clearTimeout(timer); resolve(c); });
      });
      await removeQuiet(file);
      const answer = last as HelperAnswer | null;
      if (code === 0 && answer?.type === 'done') return { available: true, ...(answer.profile ? { profile: answer.profile } : {}) };
      return { available: false, reason: answer?.stage ? `${answer.stage} ${answer.hr ?? ''}`.trim() : code === -1 ? 'no-helper' : code === null ? 'timeout' : `exit ${code}` };
    })();
    return this.probed;
  }

  /** Starts the helper on a partial file next to `path`; resolves once its encoders are set up. */
  async begin(path: string, { overwrite = false }: { overwrite?: boolean }, o: MfEncodeOptions): Promise<{ exportId: string; path: string }> {
    const cmd = this.helper();
    if (!cmd) throw new MfError('no-helper', undefined, tm("Windows yardımcısı bulunamadı."));
    const dir = dirname(path);
    const part = join(dir, `${basename(path)}.${randomBytes(3).toString('hex')}.zeyvola-part.mp4`);
    try {
      await mkdir(dir, { recursive: true });
    } catch (e) {
      throw new Error(writeErrorMessage(e, dir));
    }
    const child = spawn(cmd.command, [...cmd.args, '--encode-mp4', part, String(o.width), String(o.height), String(o.fps), String(Math.round(o.bitrate)), o.audio ? '1' : '0'], { stdio: ['pipe', 'pipe', 'pipe'] });
    const exportId = `mf_${randomUUID()}`;
    let markReady: () => void = () => undefined;
    const ready = new Promise<void>((r) => { markReady = r; });
    const job: Job = {
      path, part, overwrite, child, last: null, failed: null,
      exited: new Promise((resolve) => {
        child.on('error', () => resolve({ answer: job.last, code: -1 }));
        child.on('exit', (code) => resolve({ answer: job.last, code }));
      }),
    };
    listen(child, (a) => {
      job.last = a;
      if (a.type === 'ready') markReady();
      if (a.type === 'error') job.failed = helperError(a, null);
    });
    child.stdin.on('error', () => undefined); // a dead helper is reported through `exited`
    const started = await Promise.race([
      ready.then(() => 'ready' as const),
      job.exited.then(() => 'exited' as const),
      new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), this.startTimeoutMs)),
    ]);
    if (started !== 'ready') {
      child.kill();
      const { answer, code } = await job.exited;
      await removeQuiet(part);
      throw started === 'timeout' ? new MfError('timeout', undefined, tm("Windows'un H.264 kodlayıcısı yanıt vermedi.")) : helperError(answer, code);
    }
    this.jobs.set(exportId, job);
    return { exportId, path };
  }

  /** One packet; resolves when the helper's pipe has taken it. */
  async write(exportId: string, kind: 'video' | 'audio', time: number, duration: number, data: Uint8Array): Promise<void> {
    const job = this.jobs.get(exportId);
    if (!job) throw new Error(tm("Dışa aktarma bulunamadı"));
    if (job.failed) throw job.failed;
    const header = packetHeader(kind === 'video' ? PACKET_VIDEO : PACKET_AUDIO, data.byteLength, time, duration);
    await this.send(job, Buffer.concat([header, Buffer.from(data.buffer, data.byteOffset, data.byteLength)]));
  }

  private async send(job: Job, chunk: Buffer): Promise<void> {
    const gone = job.exited.then(({ answer, code }) => { throw job.failed ?? helperError(answer, code); });
    gone.catch(() => undefined);
    await Promise.race([
      new Promise<void>((resolve, reject) => {
        job.child.stdin.write(chunk, (e) => (e ? reject(job.failed ?? new MfError('pipe', undefined, e.message)) : resolve()));
      }),
      gone,
    ]);
    if (job.failed) throw job.failed;
  }

  /** Finishes (or with `cancel` abandons) the file; see ExportWriter.end for the naming rules. */
  end(exportId: string, cancel: boolean): Promise<{ path: string; bytes: number } | null> {
    const job = this.jobs.get(exportId);
    if (!job) return Promise.resolve(null);
    this.jobs.delete(exportId);
    const done = this.close(job, cancel);
    this.ending.add(done);
    void done.finally(() => this.ending.delete(done)).catch(() => undefined);
    return done;
  }

  async cancelAll(): Promise<void> {
    const ids = [...this.jobs.keys()];
    await Promise.allSettled([...ids.map((id) => this.end(id, true)), ...this.ending]);
  }

  private async close(job: Job, cancel: boolean): Promise<{ path: string; bytes: number } | null> {
    if (cancel || job.failed) {
      job.child.stdin.destroy();
      job.child.kill();
      await job.exited;
      await removeQuiet(job.part);
      if (cancel) return null;
      throw job.failed;
    }
    let failure: Error | null = null;
    try {
      await this.send(job, packetHeader(PACKET_END, 0, 0, 0));
      job.child.stdin.end();
    } catch (e) {
      failure = e as Error;
    }
    const { answer, code } = await job.exited;
    if (!failure && (code !== 0 || answer?.type !== 'done')) failure = job.failed ?? helperError(answer, code);
    if (failure) {
      await removeQuiet(job.part);
      throw failure;
    }
    const dir = dirname(job.path);
    const name = basename(job.path);
    const dot = name.lastIndexOf('.');
    const final = job.overwrite || !(await exists(job.path)) ? job.path : await uniquePath(dir, name.slice(0, dot), name.slice(dot + 1));
    try {
      await rename(job.part, final);
    } catch (e) {
      await removeQuiet(job.part);
      throw new Error(writeErrorMessage(e, dir));
    }
    return { path: final, bytes: (await stat(final)).size };
  }
}
