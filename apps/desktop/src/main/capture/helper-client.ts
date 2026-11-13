import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createInterface } from 'node:readline';
import type { CaptureInfo, MediaSource, SourceKind } from '@zeyvola/project-model';
import { msToTicks } from '@zeyvola/timing';
import type { BackendResult, BackendStartArgs } from './types';

/**
 * The line protocol of the native recording helpers (JSON, one object per line).
 * Kept free of Electron so it can be tested against a stand-in helper process.
 *
 * App → helper: prepare | go | pause | resume | mark | stop | cancel | request-access
 * Helper → app: hello, ready, started, status, interrupted, stopped, cancelled, access, error
 *
 * While recording, the helper also keeps session.jsonl in the recording folder (see
 * recovery.ts); `<helper> --probe-files <dir>` reports what of each file can be played.
 */
export interface HelperFile {
  kind: SourceKind;
  name: string;
  mime: string;
  width?: number;
  height?: number;
  fps?: number;
  sampleRate?: number;
  channels?: number;
  startOffsetMs: number;
  durationMs?: number;
  samples?: number;
  dropped?: number;
  error?: string;
}

export type HelperMessage =
  | { type: 'hello'; version: string; arch?: string }
  | { type: 'ready'; screenWidth?: number; screenHeight?: number; camera?: string; mic?: string }
  | { type: 'started'; startedAtMs: number }
  | { type: 'status'; elapsedMs: number; micLevel: number; dropped: number }
  | { type: 'interrupted'; code: string; message: string }
  | {
      type: 'stopped'; durationMs: number; files: HelperFile[]; cursor: string | null; markers: number[];
      hasClicks: boolean; clicks?: number; cursorSamples?: number;
    }
  | { type: 'cancelled' }
  | { type: 'access'; screen?: string; camera?: string; mic?: string }
  | { type: 'error'; code?: string; message: string; fatal: boolean };

const TYPES = new Set(['hello', 'ready', 'started', 'status', 'interrupted', 'stopped', 'cancelled', 'access', 'error']);

/** One stdout line → message, or null for anything that is not a known message. */
export function parseHelperLine(line: string): HelperMessage | null {
  let v: unknown;
  try { v = JSON.parse(line); } catch { return null; }
  if (!v || typeof v !== 'object' || !TYPES.has((v as { type?: unknown }).type as string)) return null;
  const m = v as HelperMessage;
  if (m.type === 'stopped' && (!Array.isArray(m.files) || typeof m.durationMs !== 'number')) return null;
  if (m.type === 'error' && typeof m.message !== 'string') return null;
  return m;
}

/** An error reported by the helper, with its machine-readable code. */
export class HelperError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

type NativeBackendId = 'native-macos' | 'native-windows';

/**
 * The app's own description of a recording, sent with "prepare" and kept unchanged by the
 * helper in session.jsonl, so a recording can be rebuilt after a crash.
 */
export interface SessionMeta {
  recordingId: string;
  /** 'web': written by the app itself for the browser recording path (web-backend.ts). */
  backend: NativeBackendId | 'web';
  target: CaptureInfo['target'];
  /** Region recordings of the browser path record the whole display and keep this crop. */
  crop?: CaptureInfo['crop'];
}

function captureTarget(args: BackendStartArgs): CaptureInfo['target'] {
  const t = args.config.target;
  return { kind: t.kind, label: t.label, bounds: args.targetBounds, scaleFactor: args.scaleFactor };
}

function numericId(sourceId: string): number | null {
  const m = /^(?:screen|window):(\d+)/.exec(sourceId);
  return m ? Number(m[1]) : null;
}

/** The "prepare" command for a recording chosen in the app. */
export function prepareCommand(args: BackendStartArgs, ownPid: number, backend: NativeBackendId = 'native-macos'): Record<string, unknown> {
  const t = args.config.target;
  const isWindow = t.kind === 'window';
  // On macOS, Electron display ids and desktopCapturer window ids are the system's ids.
  const displayId = t.displayId !== undefined && /^\d+$/.test(t.displayId) ? Number(t.displayId) : numericId(t.sourceId);
  return {
    cmd: 'prepare',
    outDir: args.outDir,
    display: isWindow ? null : displayId,
    window: isWindow ? numericId(t.sourceId) : null,
    region: t.kind === 'region' ? t.region ?? null : null,
    // Area the cursor log is relative to; for windows the helper follows the window itself.
    bounds: isWindow ? null : args.targetBounds,
    fps: args.config.fps,
    quality: args.config.quality,
    camera: args.config.cameraDeviceId ? { label: args.config.cameraLabel ?? null } : null,
    mic: args.config.micDeviceId ? { label: args.config.micLabel ?? null } : null,
    systemAudio: args.config.systemAudio,
    excludePid: ownPid,
    meta: { recordingId: args.recordingId, backend, target: captureTarget(args) } satisfies SessionMeta,
  };
}

/** The helper's "stopped" report → the recording's sources, each on the shared clock. */
export function recordingResult(m: Extract<HelperMessage, { type: 'stopped' }>, args: BackendStartArgs, backend: NativeBackendId): BackendResult {
  const rel = (name: string) => `media/${args.recordingId}/${name}`;
  const sources: Partial<Record<SourceKind, MediaSource>> = {};
  for (const f of m.files) {
    if (f.error) continue;
    const startOffsetMs = Math.max(0, f.startOffsetMs);
    sources[f.kind] = {
      kind: f.kind, file: rel(f.name), mime: f.mime, width: f.width, height: f.height, fps: f.fps,
      sampleRate: f.sampleRate, channels: f.channels, startOffset: msToTicks(startOffsetMs),
      duration: msToTicks(Math.max(0, f.durationMs ?? m.durationMs - startOffsetMs)),
    };
  }
  return {
    sources,
    cursorFile: m.cursor ? rel(m.cursor) : undefined,
    durationTicks: msToTicks(m.durationMs),
    capture: {
      backend,
      target: captureTarget(args),
      cursorInFrames: false,
      hasClicks: m.hasClicks,
    },
    markers: m.markers,
  };
}

/** One file of a `--probe-files` report: how much of it can actually be played. */
export interface ProbedFile {
  name: string;
  kind?: 'video' | 'audio';
  /** First readable sample to the end of the last one. */
  durationMs?: number;
  /** First sample on the file's own timeline (the recording-clock offset is in session.jsonl). */
  firstMs?: number;
  samples?: number;
  /** What the container claims (may include a fragment cut off by a crash). */
  assetDurationMs?: number;
  width?: number;
  height?: number;
  sampleRate?: number;
  channels?: number;
  error?: string;
}

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

/** The helper's `--probe-files` output → files; throws if it reported an error or nothing usable. */
export function parseProbeOutput(stdout: string): ProbedFile[] {
  for (const line of stdout.split('\n')) {
    let v: unknown;
    try { v = JSON.parse(line); } catch { continue; }
    if (!v || typeof v !== 'object' || (v as { type?: unknown }).type !== 'probe') continue;
    const r = v as { files?: unknown; error?: unknown };
    if (typeof r.error === 'string') throw new HelperError('probe', r.error);
    if (!Array.isArray(r.files)) break;
    return r.files.flatMap((f): ProbedFile[] => {
      if (!f || typeof f !== 'object' || typeof (f as { name?: unknown }).name !== 'string') return [];
      const o = f as Record<string, unknown>;
      const kind = o.kind === 'video' || o.kind === 'audio' ? o.kind : undefined;
      return [{
        name: o.name as string, kind, durationMs: num(o.durationMs), firstMs: num(o.firstMs), samples: num(o.samples),
        assetDurationMs: num(o.assetDurationMs), width: num(o.width), height: num(o.height),
        sampleRate: num(o.sampleRate), channels: num(o.channels), error: typeof o.error === 'string' ? o.error : undefined,
      }];
    });
  }
  throw new HelperError('probe-output', 'no probe report');
}

/** Runs `<helper> [...prefix] --probe-files <dir>` (captures nothing, needs no permission). */
export function probeFiles(helper: string, dir: string, prefix: string[] = [], timeoutMs = 120_000): Promise<ProbedFile[]> {
  return new Promise((resolve, reject) => {
    execFile(helper, [...prefix, '--probe-files', dir], { timeout: timeoutMs, maxBuffer: 4 << 20 }, (err, stdout) => {
      try {
        resolve(parseProbeOutput(stdout));
      } catch (e) {
        // The helper's own reason if it gave one, otherwise why it did not run.
        reject(e instanceof HelperError && e.code === 'probe' ? e : new HelperError('probe', err?.message ?? (e as Error).message));
      }
    });
  });
}

type Waiter = { resolve: (m: HelperMessage) => void; reject: (e: Error) => void };

/**
 * A running helper process. Replies are awaited by type with waitFor(); other messages
 * are emitted as 'message'. 'exit' (code, stderrTail) fires when the process ends; waiters
 * still pending are rejected then.
 */
export class HelperClient extends EventEmitter {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private waiters = new Map<HelperMessage['type'], Waiter>();
  private stderr = '';
  exitCode: number | null | undefined = undefined;

  constructor(private readonly path: string, private readonly argv: string[] = []) {
    super();
  }

  get running(): boolean {
    return this.proc !== null;
  }

  get pid(): number | undefined {
    return this.proc?.pid;
  }

  /** Starts the process and waits for its greeting. */
  async open(timeoutMs = 5000): Promise<Extract<HelperMessage, { type: 'hello' }>> {
    const proc = spawn(this.path, this.argv, { stdio: ['pipe', 'pipe', 'pipe'] });
    this.proc = proc;
    const hello = this.waitFor('hello', timeoutMs);
    proc.on('error', (e) => this.rejectAll(e));
    proc.stdin.on('error', () => undefined);
    proc.stderr.on('data', (d: Buffer) => { this.stderr = (this.stderr + d.toString()).slice(-4000); });
    createInterface({ input: proc.stdout }).on('line', (line) => {
      const m = parseHelperLine(line);
      if (m) this.dispatch(m);
    });
    proc.on('exit', (code) => {
      this.exitCode = code;
      this.proc = null;
      const tail = this.stderrTail();
      this.rejectAll(new HelperError('exited', `exit ${code}${tail ? `: ${tail}` : ''}`));
      this.emit('exit', code, tail);
    });
    return (await hello) as Extract<HelperMessage, { type: 'hello' }>;
  }

  stderrTail(lines = 3): string {
    return this.stderr.trim().split('\n').slice(-lines).join(' ');
  }

  send(cmd: Record<string, unknown>): void {
    if (this.proc?.stdin.writable) this.proc.stdin.write(`${JSON.stringify(cmd)}\n`);
  }

  waitFor(type: HelperMessage['type'], timeoutMs: number): Promise<HelperMessage> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(type);
        reject(new HelperError('timeout', type));
      }, timeoutMs);
      this.waiters.set(type, {
        resolve: (m) => { clearTimeout(timer); resolve(m); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
    });
  }

  private rejectAll(e: Error): void {
    const pending = [...this.waiters.values()];
    this.waiters.clear();
    for (const w of pending) w.reject(e);
  }

  private dispatch(m: HelperMessage): void {
    if (m.type === 'error') {
      const err = new HelperError(m.code ?? 'internal', m.message);
      // A fatal error answers whatever the app is waiting for; others are reported.
      if (m.fatal && this.waiters.size) this.rejectAll(err);
      else this.emit('message', m);
      return;
    }
    const w = this.waiters.get(m.type);
    if (w) {
      this.waiters.delete(m.type);
      w.resolve(m);
    } else this.emit('message', m);
  }

  /** Closes stdin (the helper finishes and exits); kills it if it is still there later. */
  close(killAfterMs = 3000): void {
    const proc = this.proc;
    if (!proc) return;
    proc.stdin.end();
    setTimeout(() => { if (this.proc === proc) proc.kill(); }, killAfterMs).unref();
  }
}
