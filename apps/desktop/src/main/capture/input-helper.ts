import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { app } from 'electron';
import type { Rect } from '@zeyvola/project-model';
import { nowMs } from './session-clock';

/**
 * Mouse buttons and scrolling for the Chromium recording path, which cannot see clicks outside
 * the app. A small helper reports them; it records no video, no audio and no keyboard:
 *   macOS:   native/input-macos  → zeyvola-input            (AppKit global monitor; points)
 *   Windows: native/helper-windows → zeyvola-win.exe --input (WH_MOUSE_LL hook; physical pixels)
 * For a window recording it is also given the window's id (--window <id>) and reports the
 * window's bounds whenever they change, so positions can be made relative to the window.
 * Without the helper the recording simply has no click data.
 */
export function inputHelperPath(): string {
  const name = process.platform === 'win32' ? 'zeyvola-win.exe' : 'zeyvola-input';
  if (app.isPackaged) return join(process.resourcesPath, 'bin', name);
  return resolve(app.getAppPath(), '..', '..', 'native', process.platform === 'win32' ? 'helper-windows' : 'input-macos', 'bin', name);
}

/** Arguments for the helper; windowId (CGWindowID on macOS, HWND on Windows) adds the window's bounds. */
export function inputHelperArgs(windowId?: number | null, platform: NodeJS.Platform = process.platform): string[] {
  const window = windowId != null ? ['--window', String(windowId)] : [];
  return platform === 'win32' ? ['--input', ...window] : window;
}

/**
 * The native window id in a desktopCapturer window source id ("window:<id>:<n>"): the
 * CGWindowID on macOS, the HWND on Windows. Null for screens and unexpected forms.
 */
export function windowIdOf(sourceId: string): number | null {
  const m = /^window:(\d+):\d+$/.exec(sourceId);
  if (!m) return null;
  const id = Number(m[1]);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

export function inputHelperAvailable(): boolean {
  return (process.platform === 'darwin' || process.platform === 'win32') && existsSync(inputHelperPath());
}

/** One pointer event, timed in epoch milliseconds (the recording clock's base). */
export interface PointerEvent {
  e: 'd' | 'u' | 's';
  /** Button for d/u: left, right, other. */
  b?: 'l' | 'r' | 'o';
  /** Scroll amount for s. */
  dy?: number;
  atMs: number;
  /** Global top-left points (Electron screen coordinates). */
  gx: number;
  gy: number;
}

/** Bounds of the recorded window from atMs on (epoch ms), in the helper's coordinates (like gx/gy). */
export interface WindowBoundsEvent {
  atMs: number;
  bounds: Rect;
}

type Line =
  | { type: 'ready'; now: number }
  | { type: 'error'; code: string }
  | { type: 'window'; at: number; now: number; gx: number; gy: number; w: number; h: number }
  | { e: 'd' | 'u' | 's'; b?: string; dy?: number; at: number; now: number; gx: number; gy: number };

const finite = (...vs: unknown[]) => vs.every((v) => typeof v === 'number' && Number.isFinite(v));

export function parseInputLine(line: string): Line | null {
  let o: Record<string, unknown>;
  try { o = JSON.parse(line) as Record<string, unknown>; } catch { return null; }
  if (o.type === 'ready' && typeof o.now === 'number') return { type: 'ready', now: o.now };
  if (o.type === 'error') return { type: 'error', code: String(o.code) };
  if (o.type === 'window') {
    if (!finite(o.at, o.now, o.gx, o.gy, o.w, o.h) || !((o.w as number) > 0 && (o.h as number) > 0)) return null;
    return { type: 'window', at: o.at as number, now: o.now as number, gx: o.gx as number, gy: o.gy as number, w: o.w as number, h: o.h as number };
  }
  if ((o.e === 'd' || o.e === 'u' || o.e === 's') && finite(o.at, o.now, o.gx, o.gy)) {
    return { e: o.e, b: typeof o.b === 'string' ? o.b : undefined, dy: typeof o.dy === 'number' ? o.dy : undefined, at: o.at as number, now: o.now as number, gx: o.gx as number, gy: o.gy as number };
  }
  return null;
}

/**
 * Maps the helper's clock (seconds since the Mac started) to epoch milliseconds. Every line says
 * when it was written ("now"); arrival time minus that is the offset plus the pipe delay, so the
 * smallest value seen is the best estimate of the offset.
 */
export class UptimeMap {
  private offset = Number.POSITIVE_INFINITY;

  observe(nowS: number, arrivalMs: number): void {
    this.offset = Math.min(this.offset, arrivalMs - nowS * 1000);
  }

  get known(): boolean {
    return Number.isFinite(this.offset);
  }

  toEpochMs(uptimeS: number): number {
    return uptimeS * 1000 + this.offset;
  }
}

/** Runs the helper for one recording and emits 'event' (PointerEvent) and 'window' (WindowBoundsEvent). */
export class InputHelper extends EventEmitter {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private readonly map = new UptimeMap();
  private buffer = '';

  constructor(private readonly path = inputHelperPath(), private readonly now = nowMs, private readonly args: string[] = inputHelperArgs()) {
    super();
  }

  /** Resolves true once the helper is listening, false if it cannot start (recording goes on without clicks). */
  start(timeoutMs = 5000): Promise<boolean> {
    return new Promise((resolveStart) => {
      let settled = false;
      const done = (ok: boolean) => { if (!settled) { settled = true; clearTimeout(timer); resolveStart(ok); } };
      const timer = setTimeout(() => { done(false); this.kill(); }, timeoutMs);
      let proc: ChildProcessWithoutNullStreams;
      try { proc = spawn(this.path, this.args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }); } catch { done(false); return; }
      this.proc = proc;
      proc.on('error', () => done(false));
      proc.on('exit', () => { this.proc = null; done(false); });
      proc.stderr.resume();
      proc.stdout.setEncoding('utf8');
      proc.stdout.on('data', (chunk: string) => {
        const arrival = this.now();
        this.buffer += chunk;
        let nl: number;
        while ((nl = this.buffer.indexOf('\n')) >= 0) {
          const raw = this.buffer.slice(0, nl);
          this.buffer = this.buffer.slice(nl + 1);
          const line = parseInputLine(raw);
          if (!line) continue;
          if ('type' in line) {
            if (line.type === 'window') {
              this.map.observe(line.now, arrival);
              const ev: WindowBoundsEvent = { atMs: this.map.toEpochMs(line.at), bounds: { x: line.gx, y: line.gy, w: line.w, h: line.h } };
              this.emit('window', ev);
            } else if (line.type === 'ready') { this.map.observe(line.now, arrival); done(true); } else done(false);
            continue;
          }
          this.map.observe(line.now, arrival);
          const ev: PointerEvent = { e: line.e, atMs: this.map.toEpochMs(line.at), gx: line.gx, gy: line.gy };
          if (line.e === 's') ev.dy = line.dy ?? 0;
          else ev.b = line.b === 'r' ? 'r' : line.b === 'o' ? 'o' : 'l';
          this.emit('event', ev);
        }
      });
    });
  }

  /** Asks the helper to stop; it is killed if it has not exited after a second. */
  async stop(): Promise<void> {
    const proc = this.proc;
    if (!proc || proc.exitCode !== null || proc.signalCode !== null) return;
    const exited = new Promise<void>((res) => proc.once('exit', () => res()));
    try { proc.stdin.end('stop\n'); } catch { /* already closed */ }
    const timer = setTimeout(() => this.kill(), 1000);
    await Promise.race([exited, new Promise<void>((res) => setTimeout(res, 2000))]);
    clearTimeout(timer);
    this.proc = null;
  }

  private kill(): void {
    try { this.proc?.kill('SIGKILL'); } catch { /* gone */ }
  }
}
