import { EventEmitter } from 'node:events';
import { readFile, statfs } from 'node:fs/promises';
import { join } from 'node:path';
import { desktopCapturer, screen, type BrowserWindow } from 'electron';
import { newId, type Rect, type Recording } from '@zeyvola/project-model';
import type { BackendInfo, CaptureConfig, CaptureResult, CaptureState, RecoveryNotice, SourceInfo } from '@zeyvola/protocol';
import { localeOf } from '../../shared/i18n';
import type { ProjectStore } from '../projects';
import { currentLang, tm } from '../settings';
import type { ProbedFile } from './helper-client';
import { NativeMacBackend } from './native-macos';
import { parseSessionLog, recoverAbandoned, recoverFolder, SESSION_FILE, type FolderResult, type ProjectEntry, type RecoveryDeps } from './recovery';
import { RecorderCrash, type CaptureBackend } from './types';
import { WebCaptureBackend } from './web-backend';
import { probeWebmFolder } from './webm-probe';

export interface ManagerDeps {
  store: ProjectStore;
  createCaptureWindow: () => BrowserWindow;
  showHud: (displayBounds: Rect) => void;
  hideHud: (temporarily?: boolean) => void;
  /** A session begins (countdown starts): get our own windows out of the way. */
  onSessionStart?: (targetKind: 'display' | 'window' | 'region') => void;
  /** Resolves once it is safe to record (e.g. minimize animations have finished). */
  beforeRecording?: () => Promise<void>;
}

type Session = { projectId: string; recordingId: string; outDir: string; startedAt: number };
type Recovered = Extract<FolderResult, { status: 'recovered' }>;

const IDLE: CaptureState = { phase: 'idle', backend: null, elapsedMs: 0, countdown: 0, micLevel: 0, droppedFrames: 0, diskFreeBytes: null, devicesReady: false };

/**
 * Orchestrates one recording session: backend choice, countdown, status, saving into a project.
 * If the recorder dies, the recording is rebuilt from its files (recovery.ts), both right away
 * and, for sessions lost with the app itself, on the next start (recoverAbandoned).
 * Events: 'state', 'finished', 'recoveries' (RecoveryNotice[]), 'releaseDevices', 'recordingStarted'.
 */
export class CaptureManager extends EventEmitter {
  state: CaptureState = { ...IDLE };
  readonly web: WebCaptureBackend;
  readonly native: NativeMacBackend;
  private active: CaptureBackend | null = null;
  private session: Session | null = null;
  /** Recordings rebuilt after a crash that the user has not dismissed yet. */
  private recovered: (Recovered & { projectName: string })[] = [];
  private statusTimer: NodeJS.Timeout | null = null;
  private elapsedBase = 0;
  private runningSince = 0;
  /** Shown after the session ends (for example why it stopped early). */
  private notice: string | undefined;

  constructor(private readonly deps: ManagerDeps) {
    super();
    this.web = new WebCaptureBackend(deps.createCaptureWindow);
    this.native = new NativeMacBackend();
    for (const b of [this.web, this.native] as CaptureBackend[]) {
      b.on('level', (v: number) => { this.state.micLevel = v; });
      b.on('status', (s: { droppedFrames: number }) => { this.state.droppedFrames = s.droppedFrames; });
      b.on('error', (e: Error) => this.fail(e));
      b.on('crashed', (e: Error) => void this.crashed(e));
      b.on('interrupted', (e: Error) => this.interrupted(e));
      b.on('releaseDevices', () => this.emit('releaseDevices'));
    }
  }

  backends(): BackendInfo[] {
    return [this.native.info, this.web.info];
  }

  private set(patch: Partial<CaptureState>): void {
    this.state = { ...this.state, ...patch };
    this.emit('state', this.state);
  }

  async listSources(): Promise<SourceInfo[]> {
    const displays = screen.getAllDisplays();
    const primaryId = String(screen.getPrimaryDisplay().id);
    const isPrimary = (s: SourceInfo) => s.kind === 'display' && s.displayId === primaryId;
    const sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 480, height: 300 }, fetchWindowIcons: true });
    return sources.map((s): SourceInfo => {
      const isScreen = s.id.startsWith('screen:');
      const d = isScreen ? displays.find((x) => String(x.id) === s.display_id) ?? displays[0] : undefined;
      return {
        id: s.id,
        kind: isScreen ? 'display' : 'window',
        name: s.name,
        displayId: s.display_id || undefined,
        thumbnail: s.thumbnail.isEmpty() ? null : s.thumbnail.toDataURL(),
        appIcon: s.appIcon && !s.appIcon.isEmpty() ? s.appIcon.toDataURL() : null,
        bounds: d ? { x: d.bounds.x, y: d.bounds.y, w: d.bounds.width, h: d.bounds.height } : undefined,
        scaleFactor: d?.scaleFactor,
      };
    }).filter((s) => s.kind === 'display' || !/^(Zeyvola|Electron)$/.test(s.name))
      // The main display first: the recording screen preselects the first entry, and the
      // pointer is usually on the main display (recording another screen leaves no zooms).
      .sort((a, b) => Number(isPrimary(b)) - Number(isPrimary(a)));
  }

  private pickBackend(config: CaptureConfig): CaptureBackend {
    if (config.backend === 'web') return this.web;
    if (config.backend === 'native') {
      if (!this.native.info.available) throw new Error(this.native.info.reason ?? tm("Yerel kayıt kullanılamıyor"));
      return this.native;
    }
    return this.native.info.available ? this.native : this.web;
  }

  async start(config: CaptureConfig): Promise<void> {
    if (this.state.phase !== 'idle' && this.state.phase !== 'error') throw new Error(tm("Zaten bir kayıt sürüyor"));
    const backend = this.pickBackend(config);
    this.set({ ...IDLE, phase: 'preparing', backend: backend.info.id });
    try {
      const store = this.deps.store;
      const projectId = config.projectId ?? (await store.create(config.projectName?.trim() || defaultProjectName())).id;
      const recordingId = newId('rec');
      const outDir = await store.mediaDir(projectId, recordingId);
      const displays = screen.getAllDisplays();
      const t = config.target;
      const display = displays.find((d) => String(d.id) === t.displayId) ?? screen.getPrimaryDisplay();
      const displayBounds = { x: display.bounds.x, y: display.bounds.y, w: display.bounds.width, h: display.bounds.height };
      const targetBounds = t.kind === 'region' && t.region
        ? { x: displayBounds.x + t.region.x, y: displayBounds.y + t.region.y, w: t.region.w, h: t.region.h }
        : displayBounds;
      this.session = { projectId, recordingId, outDir, startedAt: Date.now() };

      const args = { config, outDir, recordingId, targetBounds, displayBounds, scaleFactor: display.scaleFactor };
      this.deps.showHud(displayBounds);
      this.deps.onSessionStart?.(t.kind);
      this.active = backend;
      // Devices open and warm up while the countdown runs, so recording starts on good frames.
      let prepError: Error | null = null;
      let prepDone = false;
      const prep = (backend.prepare ? backend.prepare(args) : Promise.resolve())
        .then(() => { prepDone = true; this.set({ devicesReady: true }); })
        .catch((e: Error) => { prepError = e; prepDone = true; });
      for (let n = config.countdown; n > 0; n--) {
        this.set({ phase: 'countdown', countdown: n });
        await new Promise((r) => setTimeout(r, 1000));
        if (!this.session) return; // cancelled during countdown
        if (prepError) throw prepError;
      }
      if (!prepDone) this.set({ phase: 'preparing', countdown: 0, message: tm("Kamera hazırlanıyor…") });
      await prep;
      if (prepError) throw prepError;
      if (!this.session) return;
      await this.deps.beforeRecording?.();
      // Chromium capture on macOS would record our own HUD; hide it and rely on tray + shortcuts.
      if (backend === this.web && process.platform === 'darwin') this.deps.hideHud(true);
      await backend.start(args);
      this.elapsedBase = 0;
      this.runningSince = Date.now();
      this.set({ phase: 'recording', countdown: 0, message: undefined });
      this.emit('recordingStarted', config.target.kind);
      this.statusTimer = setInterval(() => void this.tick(), 250);
    } catch (e) {
      await this.active?.cancel().catch(() => undefined);
      this.active = null;
      this.session = null;
      this.deps.hideHud();
      this.fail(e as Error);
      throw e;
    }
  }

  private async tick(): Promise<void> {
    const running = this.state.phase === 'recording' ? Date.now() - this.runningSince : 0;
    let diskFreeBytes: number | null = this.state.diskFreeBytes;
    if (this.session) {
      try { const s = await statfs(this.session.outDir); diskFreeBytes = s.bavail * s.bsize; } catch { /* keep last */ }
    }
    this.set({ elapsedMs: this.elapsedBase + running, diskFreeBytes });
    // Stop cleanly before the disk fills up.
    if (diskFreeBytes !== null && diskFreeBytes < 1.5 * 1024 ** 3 && this.state.phase === 'recording') {
      this.set({ message: tm("Disk alanı azaldı; kayıt güvenli şekilde durduruluyor.") });
      void this.stop();
    }
  }

  async pause(): Promise<void> {
    if (!this.active || this.state.phase !== 'recording') return;
    await this.active.pause();
    this.elapsedBase += Date.now() - this.runningSince;
    this.set({ phase: 'paused' });
  }

  async resume(): Promise<void> {
    if (!this.active || this.state.phase !== 'paused') return;
    await this.active.resume();
    this.runningSince = Date.now();
    this.set({ phase: 'recording' });
  }

  mark(): void {
    if (this.state.phase === 'recording') this.active?.mark();
  }

  async stop(): Promise<CaptureResult | null> {
    const backend = this.active;
    const session = this.session;
    if (!session || this.state.phase === 'finishing') return null;
    if (!backend || this.state.phase === 'countdown' || this.state.phase === 'preparing') {
      // Stopped before recording began: nothing to keep.
      if (backend) {
        await this.cancel();
        return null;
      }
      this.session = null;
      this.deps.hideHud();
      this.set({ ...IDLE });
      return null;
    }
    if (this.statusTimer) clearInterval(this.statusTimer);
    this.statusTimer = null;
    this.set({ phase: 'finishing' });
    try {
      const r = await backend.stop();
      const recording: Recording = {
        id: session.recordingId,
        createdAt: new Date(session.startedAt).toISOString(),
        duration: r.durationTicks,
        sources: r.sources,
        cursorFile: r.cursorFile,
        capture: { ...r.capture, platform: `${process.platform}-${process.arch}` },
        syncOffsets: {},
        markers: r.markers,
      };
      if (!recording.sources.screen) throw new Error(tm("Ekran kaydı oluşmadı."));
      await this.deps.store.appendRecording(session.projectId, recording);
      const result = { projectId: session.projectId, recordingId: session.recordingId };
      this.emit('finished', result);
      return result;
    } catch (e) {
      if (e instanceof RecorderCrash) {
        try { return await this.recoverSession(session, backend, e); } catch (err) { this.fail(err as Error); return null; }
      }
      this.fail(e as Error);
      return null;
    } finally {
      this.active = null;
      this.session = null;
      this.deps.hideHud();
      if (this.state.phase !== 'error') this.set({ ...IDLE, message: this.notice });
      this.notice = undefined;
    }
  }

  async cancel(): Promise<void> {
    if (this.statusTimer) clearInterval(this.statusTimer);
    this.statusTimer = null;
    await this.active?.cancel().catch(() => undefined);
    this.active = null;
    this.session = null;
    this.deps.hideHud();
    this.set({ ...IDLE });
  }

  /** The recorder died while recording: rebuild the recording from what reached the disk. */
  private async crashed(e: Error): Promise<void> {
    const session = this.session;
    const backend = this.active;
    const phase = this.state.phase;
    if (!session || !backend || (phase !== 'recording' && phase !== 'paused')) return;
    if (this.statusTimer) clearInterval(this.statusTimer);
    this.statusTimer = null;
    this.set({ phase: 'finishing', message: tm("Kayıt yardımcısı kapandı; kayıt kurtarılıyor…") });
    try {
      await this.recoverSession(session, backend, e);
    } catch (err) {
      this.fail(err as Error);
    } finally {
      this.active = null;
      this.session = null;
      this.deps.hideHud();
      if (this.state.phase !== 'error') this.set({ ...IDLE });
    }
  }

  private async recoverSession(session: Session, backend: CaptureBackend, cause: Error): Promise<CaptureResult> {
    if (!backend.probe) throw cause;
    const r = await recoverFolder(session.projectId, session.outDir, session.recordingId, this.recoveryDeps(backend.probe.bind(backend), true));
    if (r.status !== 'recovered') throw new Error(tm("Kayıt yardımcısı beklenmedik şekilde kapandı; kurtarılabilecek görüntü kalmadı."));
    await this.noteRecovered(r);
    const result = { projectId: session.projectId, recordingId: session.recordingId };
    this.emit('finished', result);
    return result;
  }

  /** `ownSession`: the folder of the session that just ended, whose helper is known to be gone. */
  private recoveryDeps(probe: (dir: string) => Promise<ProbedFile[]>, ownSession = false): RecoveryDeps {
    const store = this.deps.store;
    return {
      probe,
      hasRecording: async (projectId, recordingId) => recordingId in (await store.read(projectId)).recordings,
      appendRecording: (projectId, recording) => store.appendRecording(projectId, recording),
      platform: `${process.platform}-${process.arch}`,
      fallbackLabel: tm("Kurtarılan kayıt"),
      ...(ownSession ? { isAlive: () => false } : { isBusy: (dir: string) => this.session?.outDir === dir }),
    };
  }

  /**
   * Finds recordings left on disk by a recorder (or app) that stopped unexpectedly and adds
   * them to their projects. Runs once at start. Files of the browser recording path are
   * measured here (webm-probe.ts); native ones by the native helper, when it is present.
   */
  async recoverAbandoned(): Promise<void> {
    const store = this.deps.store;
    const projects: ProjectEntry[] = [];
    for (const { id, dir } of await store.entries()) {
      try { projects.push({ id, dir, recordingIds: new Set(Object.keys((await store.read(id)).recordings)) }); } catch { /* unreadable project */ }
    }
    const probe = async (dir: string): Promise<ProbedFile[]> => {
      const log = parseSessionLog(await readFile(join(dir, SESSION_FILE), 'utf8'));
      if (log?.meta?.backend === 'web') return probeWebmFolder(dir, log.tracks.map((t) => t.name));
      // Thrown before anything is written: the folder is tried again when the helper is there.
      if (!this.native.info.available) throw new Error('native helper not available');
      return this.native.probe(dir);
    };
    const results = await recoverAbandoned(projects, this.recoveryDeps(probe), (dir, e) => {
      process.stderr.write(`Kurtarma başarısız (${dir}): ${String(e)}\n`);
    });
    for (const r of results) if (r.status === 'recovered') await this.noteRecovered(r);
  }

  private async noteRecovered(r: Recovered): Promise<void> {
    let projectName = '';
    try { projectName = (await this.deps.store.read(r.projectId)).name; } catch { /* shown without a name */ }
    this.recovered = [...this.recovered.filter((x) => x.recordingId !== r.recordingId), { ...r, projectName }];
    this.emit('recoveries', this.recoveryNotices());
  }

  /** Built on every read so the text follows the current language. */
  recoveryNotices(): RecoveryNotice[] {
    const seconds = new Intl.NumberFormat(localeOf(currentLang()), { minimumFractionDigits: 1, maximumFractionDigits: 1 });
    return this.recovered.map((r) => ({
      projectId: r.projectId, recordingId: r.recordingId, recoveredMs: r.recoveredMs,
      message: tm("Kayıt yarıda kaldı; {seconds} sn kurtarıldı ve “{project}” projesine eklendi.", { seconds: seconds.format(r.recoveredMs / 1000), project: r.projectName }),
    }));
  }

  dismissRecovery(recordingId: string): void {
    this.recovered = this.recovered.filter((r) => r.recordingId !== recordingId);
    this.emit('recoveries', this.recoveryNotices());
  }

  /** The system ended the capture: save what was recorded and say why it stopped. */
  private interrupted(e: Error): void {
    if (this.state.phase !== 'recording' && this.state.phase !== 'paused') return;
    this.notice = e.message;
    void this.stop();
  }

  private fail(e: Error): void {
    this.set({ phase: 'error', message: e.message });
  }

  resetError(): void {
    if (this.state.phase === 'error') this.set({ ...IDLE });
  }
}

function defaultProjectName(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return tm("Kayıt {date}", { date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}.${pad(d.getMinutes())}` });
}
