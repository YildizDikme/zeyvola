import { EventEmitter } from 'node:events';
import { appendFileSync } from 'node:fs';
import { open, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { desktopCapturer, screen, type BrowserWindow, type IpcMainInvokeEvent } from 'electron';
import type { MediaSource, SourceKind } from '@zeyvola/project-model';
import { msToTicks } from '@zeyvola/timing';
import { trackSpan } from '../../shared/track-start';
import type { BackendInfo } from '@zeyvola/protocol';
import { removeQuiet } from '../fsutil';
import { tm } from '../settings';
import { BoundsTimeline, CursorTracker } from './cursor-tracker';
import { InputHelper, inputHelperArgs, inputHelperAvailable, inputHelperPath, windowIdOf, type PointerEvent, type WindowBoundsEvent } from './input-helper';
import { SESSION_FILE } from './recovery';
import { nowMs, SessionClock } from './session-clock';
import type { BackendResult, BackendStartArgs, CaptureBackend } from './types';

interface OpenFile {
  kind: SourceKind;
  name: string;
  path: string;
  mime: string;
  fh: FileHandle;
  queue: Promise<void>;
  bytes: number;
  meta?: TrackMeta;
  /** Sent with the first chunk; written to the session log once the recording clock runs. */
  first?: TrackMeta;
  logged?: boolean;
}

type TrackMeta = { firstFrameMs: number | null; width?: number; height?: number; fps?: number; sampleRate?: number; channels?: number };

const EXT: Record<string, string> = { mp4: 'mp4', webm: 'webm', 'x-matroska': 'mkv' };

function extFor(mime: string, kind: SourceKind): string {
  const sub = mime.split(';')[0]!.split('/')[1] ?? 'webm';
  const e = EXT[sub] ?? 'webm';
  if (kind === 'mic' || kind === 'system') return e === 'mp4' ? 'm4a' : 'weba';
  return e;
}

/**
 * Fallback backend that records through Chromium (getDisplayMedia/getUserMedia +
 * MediaRecorder) in a hidden window. Works on every platform Electron supports, but the
 * cursor is baked into the video and system audio is only available on Windows (Electron
 * loopback limitation). Chromium cannot see clicks; the pointer helper (input-helper.ts)
 * reports them when it is present. For a window recording the helper also follows the window's
 * bounds, and the cursor log is relative to the window as it moves and resizes.
 */
export class WebCaptureBackend extends EventEmitter implements CaptureBackend {
  readonly info: BackendInfo = {
    id: 'web',
    available: true,
    capabilities: { separateCursor: false, clicks: inputHelperAvailable(), systemAudio: process.platform === 'win32', pause: true },
  };

  private win: BrowserWindow | null = null;
  private files = new Map<string, OpenFile>();
  private clock = new SessionClock();
  private tracker: CursorTracker | null = null;
  /** Pointer helper for clicks; null when absent or not started. */
  private input: InputHelper | null = null;
  private clicksRecorded = false;
  /** The recorded window's bounds (Electron screen coordinates) as the helper reports them; window recordings only. */
  private windowArea: BoundsTimeline | null = null;
  private markers: number[] = [];
  private args: BackendStartArgs | null = null;
  private startedWaiter: { resolve: (ms: number) => void; reject: (e: Error) => void } | null = null;
  private readyWaiter: { resolve: () => void; reject: (e: Error) => void } | null = null;
  private prepared: Promise<void> | null = null;
  private closedWaiter: (() => void) | null = null;
  private seq = 0;
  /**
   * session.jsonl in the recording folder, the same log the native helpers keep (recovery.ts):
   * session start, each file once it has data, markers, and the clean end or the cancel. If the
   * app dies mid-recording, the next start rebuilds the recording from it and the files.
   */
  private sessionLog: string | null = null;

  constructor(private readonly createWindow: () => BrowserWindow) {
    super();
  }

  /** True if the IPC event comes from this backend's capture window. */
  owns(e: IpcMainInvokeEvent): boolean {
    return !!this.win && !this.win.isDestroyed() && e.sender === this.win.webContents;
  }

  prepare(args: BackendStartArgs): Promise<void> {
    if (!this.prepared) {
      this.prepared = this.doPrepare(args).catch(async (e: unknown) => {
        await this.stopInput();
        throw e;
      });
    }
    return this.prepared;
  }

  private async doPrepare(args: BackendStartArgs): Promise<void> {
    this.args = args;
    this.markers = [];
    await this.startInput(args);
    const sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 0, height: 0 } });
    const src = sources.find((s) => s.id === args.config.target.sourceId);
    if (!src) throw new Error(tm("Seçilen kaynak artık mevcut değil."));
    const win = this.createWindow();
    this.win = win;
    const loopback = args.config.systemAudio && process.platform === 'win32';
    win.webContents.session.setDisplayMediaRequestHandler((_req, cb) => {
      cb(loopback ? { video: src, audio: 'loopback' } : { video: src });
    });
    await new Promise<void>((res) => win.webContents.once('did-finish-load', () => res()));
    const ready = new Promise<void>((resolve, reject) => { this.readyWaiter = { resolve, reject }; });
    win.webContents.send('cw:prepare', {
      config: args.config,
      pixelWidth: Math.round(args.displayBounds.w * args.scaleFactor),
      pixelHeight: Math.round(args.displayBounds.h * args.scaleFactor),
      systemAudio: loopback,
    });
    await withTimeout(ready, 20_000, tm("Kamera veya mikrofon hazırlanamadı (zaman aşımı)."));
  }

  /**
   * Starts the pointer helper before recording, so the first clicks are not missed. For a window
   * it also reports the window's bounds, starting before "ready", so they are known at the start.
   */
  private async startInput(args: BackendStartArgs): Promise<void> {
    this.clicksRecorded = false;
    this.windowArea = null;
    await this.stopInput();
    const t = args.config.target;
    const windowId = t.kind === 'window' ? windowIdOf(t.sourceId) : null;
    if ((t.kind === 'window' && windowId === null) || !inputHelperAvailable()) return;
    const win32 = process.platform === 'win32';
    const input = new InputHelper(inputHelperPath(), undefined, inputHelperArgs(windowId));
    input.on('event', (ev: PointerEvent) => {
      // Before the clock starts there is no tracker; clicks during a pause are not part of the recording.
      if (!this.tracker || this.clock.paused || ev.atMs < this.clock.startedAt) return;
      // Windows reports physical pixels; the tracker works in Electron's screen coordinates.
      const p = win32 ? screen.screenToDipPoint({ x: ev.gx, y: ev.gy }) : { x: ev.gx, y: ev.gy };
      this.tracker.writeInput({ ...ev, gx: p.x, gy: p.y });
    });
    if (windowId !== null) {
      const area = new BoundsTimeline();
      this.windowArea = area;
      input.on('window', (ev: WindowBoundsEvent) => {
        const b = ev.bounds;
        const r = win32 ? screen.screenToDipRect(null, { x: b.x, y: b.y, width: b.w, height: b.h }) : { x: b.x, y: b.y, width: b.w, height: b.h };
        area.set({ x: r.x, y: r.y, w: r.width, h: r.height }, ev.atMs);
      });
    }
    if (await input.start()) {
      this.input = input;
      this.clicksRecorded = true;
    }
  }

  private async stopInput(): Promise<void> {
    const input = this.input;
    this.input = null;
    await input?.stop();
  }

  async start(args: BackendStartArgs): Promise<void> {
    await this.prepare(args);
    const started = new Promise<number>((resolve, reject) => { this.startedWaiter = { resolve, reject }; });
    this.win?.webContents.send('cw:go');
    const startedAt = await withTimeout(started, 15_000, tm("Kayıt başlatılamadı (zaman aşımı)."));
    this.clock.start(startedAt);
    const t = args.config.target;
    // A window is followed through the helper's reports; without them its cursor log cannot be placed.
    const area = t.kind !== 'window' ? new BoundsTimeline(args.targetBounds) : this.input && this.windowArea?.known ? this.windowArea : null;
    if (area) {
      this.tracker = new CursorTracker(this.clock, area);
      this.tracker.start(join(args.outDir, 'cursor.jsonl'));
    }
    this.sessionLog = join(args.outDir, SESSION_FILE);
    const crop = cropOf(args);
    this.log({
      e: 'session', startedAtMs: startedAt, pid: process.pid, cursor: area ? 'cursor.jsonl' : null, clicks: this.clicksRecorded && !!area,
      meta: { recordingId: args.recordingId, backend: 'web', target: { kind: t.kind, label: t.label, bounds: args.targetBounds, scaleFactor: args.scaleFactor }, ...(crop ? { crop } : {}) },
    });
    for (const f of this.files.values()) this.logTrack(f);
  }

  private log(line: Record<string, unknown>): void {
    if (!this.sessionLog) return;
    // Synchronous on purpose: each line reaches the system before the next step, even if the app dies.
    try { appendFileSync(this.sessionLog, `${JSON.stringify(line)}\n`); } catch { /* the recording itself goes on */ }
  }

  private logTrack(f: OpenFile): void {
    if (!this.sessionLog || f.logged || !f.first) return;
    f.logged = true;
    const m = f.first;
    this.log({
      e: 'track', kind: f.kind, name: f.name, mime: f.mime.split(';')[0]!,
      startOffsetMs: trackSpan(m.firstFrameMs, this.clock.startedAt, 0).startOffsetMs,
      width: m.width, height: m.height, fps: m.fps, sampleRate: m.sampleRate, channels: m.channels,
    });
  }

  // ─── Messages from the capture window ─────────────────────────────────────

  async onOpen(kind: SourceKind, mime: string): Promise<string> {
    if (!this.args) throw new Error('Oturum yok');
    const name = `${kind}.${extFor(mime, kind)}`;
    const path = join(this.args.outDir, name);
    const fh = await open(path, 'w');
    const handle = `h${++this.seq}`;
    this.files.set(handle, { kind, name, path, mime, fh, queue: Promise.resolve(), bytes: 0 });
    return handle;
  }

  onChunk(handle: string, data: Uint8Array, first?: TrackMeta): Promise<void> {
    const f = this.files.get(handle);
    if (!f) return Promise.reject(new Error('Bilinmeyen dosya'));
    if (first && !f.first) f.first = first;
    f.queue = f.queue.then(async () => {
      await f.fh.write(data);
      f.bytes += data.byteLength;
      this.logTrack(f); // after the data, so the log never names an empty file
    });
    return f.queue;
  }

  async onClose(handle: string, meta: NonNullable<OpenFile['meta']>): Promise<void> {
    const f = this.files.get(handle);
    if (!f) return;
    f.meta = meta;
    await f.queue;
    await f.fh.sync().catch(() => undefined);
    await f.fh.close().catch(() => undefined);
    if ([...this.files.values()].every((x) => x.meta)) this.closedWaiter?.();
  }

  onReady(): void {
    this.readyWaiter?.resolve();
    this.readyWaiter = null;
  }

  /** The capture window could not open a device that another view (the preview) holds. */
  onBusy(): void {
    this.emit('releaseDevices');
  }

  onStarted(startedAtMs: number): void {
    this.startedWaiter?.resolve(startedAtMs);
    this.startedWaiter = null;
  }

  onFailed(message: string): void {
    const err = new Error(message);
    if (this.readyWaiter) {
      this.readyWaiter.reject(err);
      this.readyWaiter = null;
    } else if (this.startedWaiter) {
      this.startedWaiter.reject(err);
      this.startedWaiter = null;
    } else this.emit('error', err);
  }

  onLevel(mic: number): void {
    this.emit('level', mic);
  }

  // ─── Control ──────────────────────────────────────────────────────────────

  async pause(): Promise<void> {
    const at = nowMs();
    this.clock.pause(at);
    this.win?.webContents.send('cw:pause');
    this.log({ e: 'pause', t: this.clock.ticks(at), atMs: at });
  }

  async resume(): Promise<void> {
    const at = nowMs();
    this.clock.resume(at);
    this.win?.webContents.send('cw:resume');
    this.log({ e: 'resume', t: this.clock.ticks(at), atMs: at });
  }

  mark(): void {
    const t = this.clock.ticks();
    this.markers.push(t);
    this.tracker?.writeMarker(t);
    this.log({ e: 'mark', t });
  }

  async stop(): Promise<BackendResult> {
    const args = this.args;
    if (!args) throw new Error('Oturum yok');
    const durationMs = this.clock.elapsedMs();
    const allClosed = new Promise<void>((res) => {
      this.closedWaiter = res;
      if (this.files.size > 0 && [...this.files.values()].every((x) => x.meta)) res();
    });
    this.win?.webContents.send('cw:stop');
    await withTimeout(allClosed, 20_000, tm("Kayıt dosyaları kapatılamadı.")).catch((e) => this.emit('error', e));
    await this.stopInput();
    const cursorLogged = !!this.tracker;
    await this.tracker?.stop();
    this.tracker = null;
    this.windowArea = null;
    this.destroyWindow();

    const sources: Partial<Record<SourceKind, MediaSource>> = {};
    const rel = (name: string) => `media/${args.recordingId}/${name}`;
    for (const f of this.files.values()) {
      if (f.bytes === 0) continue;
      const m = f.meta ?? f.first ?? { firstFrameMs: null };
      const span = trackSpan(m.firstFrameMs, this.clock.startedAt, durationMs);
      sources[f.kind] = {
        kind: f.kind, file: rel(f.name), mime: f.mime.split(';')[0]!,
        width: m.width, height: m.height, fps: m.fps, sampleRate: m.sampleRate, channels: m.channels,
        startOffset: msToTicks(span.startOffsetMs),
        duration: msToTicks(span.durationMs),
      };
    }
    this.files.clear();
    const t = args.config.target;
    const crop = cropOf(args);
    this.log({ e: 'end', durationMs });
    this.sessionLog = null;
    return {
      sources,
      cursorFile: cursorLogged ? rel('cursor.jsonl') : undefined,
      durationTicks: msToTicks(durationMs),
      capture: {
        backend: 'web',
        target: { kind: t.kind, label: t.label, bounds: args.targetBounds, scaleFactor: args.scaleFactor },
        cursorInFrames: true,
        hasClicks: this.clicksRecorded && cursorLogged,
        ...(crop ? { crop } : {}),
      },
      markers: this.markers,
    };
  }

  async cancel(): Promise<void> {
    this.log({ e: 'cancelled' });
    this.sessionLog = null;
    this.win?.webContents.send('cw:stop');
    await new Promise((r) => setTimeout(r, 300));
    await this.stopInput();
    await this.tracker?.stop();
    this.tracker = null;
    this.windowArea = null;
    for (const f of this.files.values()) {
      await f.fh.close().catch(() => undefined);
      await removeQuiet(f.path);
    }
    this.files.clear();
    this.destroyWindow();
  }

  private destroyWindow(): void {
    if (this.win && !this.win.isDestroyed()) this.win.destroy();
    this.win = null;
    this.prepared = null;
  }
}

/** Region recordings record the whole display; the region is a crop of it (normalized). */
function cropOf(args: BackendStartArgs): { x: number; y: number; w: number; h: number } | undefined {
  const t = args.config.target;
  return t.kind === 'region' && t.region
    ? { x: t.region.x / args.displayBounds.w, y: t.region.y / args.displayBounds.h, w: t.region.w / args.displayBounds.w, h: t.region.h / args.displayBounds.h }
    : undefined;
}

function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(message)), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}
