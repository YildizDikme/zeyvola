import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  app, BrowserWindow, dialog, globalShortcut, ipcMain, Menu, nativeImage, powerSaveBlocker, shell, Tray, type IpcMainInvokeEvent, type OpenDialogOptions, type SaveDialogOptions,
} from 'electron';
import type { ZodType } from 'zod';
import { CaptureWorker, IMPORT_VIDEO_TYPES, Schemas, type AppInfo, type Channel, type CpuSample, type EncoderInfo, type ExportTarget, type OpenedProject, type PickedFile, type ThirdPartyInfo } from '@zeyvola/protocol';
import { newId, type Recording } from '@zeyvola/project-model';
import { APP_NAME, PROJECTS_FOLDER } from '../shared/brand';
import { migrateLegacyData } from './legacy-name';
import { CaptureManager } from './capture/manager';
import { runCodecProbe } from './codec-probe';
import { extractImportAudio } from './import-audio';
import { exists } from './fsutil';
import { MfExports } from './mf-export';
import { displayFolder, ExportTargets, ExportWriter, safeBaseName, uniquePath, writableFolder, writeErrorMessage } from './export-writer';
import { handleMediaProtocol, mediaBase, registerMediaScheme } from './media-protocol';
import { getPermissions, openPermissionSettings, requestPermission } from './permissions';
import { appIcon, circleIcon } from './png';
import { shortcutLabel } from '../shared/shortcut-label';
import { suiteFromArgv } from '../shared/test-suite';
import { getLastExportFolder, loadSettings, onSettingsChanged, setLastExportFolder, settingsInfo, tm, updateSettings } from './settings';
import { ProjectStore } from './projects';
import { createCaptureWindow, createMainWindow, hideHud, hudWindow, showHud } from './windows';
import { activateDll, askForTerms, dllFiles, recordAcceptance, startupAction, tellActivationFailed, termsAccepted } from './windows-terms';

// Test suites (shared/test-suite.ts) all run like the smoke test: temporary projects folder,
// synthetic devices, test-only channels. SUITE says which one the renderer runs.
const SUITE = suiteFromArgv(process.argv);
const SMOKE = SUITE !== null;
const argAfter = (flag: string): string | null => { const i = process.argv.indexOf(flag); return i >= 0 ? process.argv[i + 1] ?? null : null; };
// Distribution check: reports the codecs this build offers, then exits (tools/codec-audit.mjs).
const CODEC_PROBE = argAfter('--codec-probe');
app.setName(APP_NAME);
// Real-use tests (tests/real-capture-web): settings and projects in a throwaway folder, so a test
// run never touches the user's own projects or settings. Unset in normal use.
const TEST_HOME = SMOKE || CODEC_PROBE ? null : process.env.ZEYVOLA_TEST_HOME ?? null;
if (TEST_HOME) app.setPath('userData', join(TEST_HOME, 'userData'));
registerMediaScheme();
if (SMOKE) {
  // Synthetic camera/microphone for tests: no real device, no permission prompt. The fake-device
  // switch also replaces the *screen* with Chromium's test pattern, so the real screen recording test
  // (ZEYVOLA_TEST_REAL_CAPTURE=1, Windows CI) goes without it and records the real display; it then
  // uses whatever microphone the machine has, or none (no camera is asked for in that test).
  if (process.env.ZEYVOLA_TEST_REAL_CAPTURE !== '1') app.commandLine.appendSwitch('use-fake-device-for-media-stream');
  app.commandLine.appendSwitch('use-fake-ui-for-media-stream');
}

if (!SMOKE && !CODEC_PROBE && !app.requestSingleInstanceLock()) app.quit();
// Windows: Microsoft's d3dcompiler_47.dll ships as "d3dcompiler_47.dll.terms-pending" and gets its
// real name only after its terms are accepted (windows-terms.ts), so no process can load the
// shipped copy before. Accepted earlier (an update brought the pending name again): rename it now,
// before the app is ready, and restart once. If that fails the app starts as it is and says so.
const TERMS_ACTION = SMOKE || CODEC_PROBE ? 'none' : startupAction(process.platform, dllFiles(), termsAccepted(app.getPath('userData')));
const TERMS_PENDING = TERMS_ACTION === 'ask';
const ACTIVATION = TERMS_ACTION === 'activate' ? activateDll() : null;
const RESTART_FOR_DLL = ACTIVATION?.ok === true;
if (TERMS_PENDING || RESTART_FOR_DLL) app.disableHardwareAcceleration();

let mainWindow: BrowserWindow | null = null;
let store: ProjectStore;
let capture: CaptureManager;
let tray: Tray | null = null;
let icon: Electron.NativeImage | undefined; // created once the app is ready

// ─── Main window lifecycle ───────────────────────────────────────────────────
// During a display or region recording our window is minimized at the start of the
// countdown (so the animation is never recorded) and restored when the session ends.
let minimizedForCapture = false;
let minimizedAt = 0;
let pendingFinished: unknown = null;

function openMainWindow(): BrowserWindow {
  const win = createMainWindow(!SMOKE, SMOKE, icon);
  // Timing and interface tests need a window that is really drawn; it is shown without taking focus.
  if (SUITE === 'perf' || SUITE === 'ui') win.once('ready-to-show', () => win.showInactive());
  win.on('closed', () => { if (mainWindow === win) mainWindow = null; });
  win.webContents.on('did-finish-load', () => {
    if (pendingFinished) {
      win.webContents.send('capture:finished', pendingFinished);
      pendingFinished = null;
    }
  });
  mainWindow = win;
  return win;
}

function restoreMain(): void {
  minimizedForCapture = false;
  if (!mainWindow || mainWindow.isDestroyed()) {
    if (app.isReady() && !SMOKE) openMainWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
  if (process.platform === 'darwin') app.focus({ steal: true });
}

function minimizeForCapture(kind: string): void {
  if (kind === 'window' || !mainWindow || mainWindow.isDestroyed()) return;
  if (!mainWindow.isVisible() || mainWindow.isMinimized()) return;
  mainWindow.minimize();
  minimizedForCapture = true;
  minimizedAt = Date.now();
}

async function waitForWindowsSettled(): Promise<void> {
  if (!minimizedForCapture) return;
  const remaining = 750 - (Date.now() - minimizedAt);
  if (remaining > 0) await new Promise((r) => setTimeout(r, remaining));
}
const exportsWriter = new ExportWriter();
/**
 * MP4 export through Windows' own Media Foundation encoders, for a Windows computer whose renderer
 * has no hardware H.264 encoder (renderer/export/route.ts). Windows only: the helper is
 * native/helper-windows (zeyvola-win.exe --encode-mp4).
 */
const mfExports = new MfExports(() => {
  if (process.platform !== 'win32') return null;
  const exe = app.isPackaged ? join(process.resourcesPath, 'bin', 'zeyvola-win.exe') : resolve(app.getAppPath(), '..', '..', 'native', 'helper-windows', 'bin', 'zeyvola-win.exe');
  return existsSync(exe) ? { command: exe, args: [] } : null;
});
const endExport = (exportId: string, cancel: boolean) => (exportId.startsWith('mf_') ? mfExports.end(exportId, cancel) : exportsWriter.end(exportId, cancel));

function broadcast(channel: string, data: unknown): void {
  for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send(channel, data);
}

/** Registers a validated handler. Payloads that fail the schema never reach `fn`. */
function handle<C extends Channel>(channel: C, fn: (payload: ReturnType<(typeof Schemas)[C]['parse']>, e: IpcMainInvokeEvent) => unknown): void {
  const schema = Schemas[channel] as ZodType;
  ipcMain.handle(channel, async (e, payload) => {
    const parsed = schema.safeParse(payload);
    if (!parsed.success) throw new Error(`Geçersiz istek (${channel})`);
    return fn(parsed.data as never, e);
  });
}

function handleNoArgs(channel: string, fn: (e: IpcMainInvokeEvent) => unknown): void {
  ipcMain.handle(channel, (e) => fn(e));
}

function registerIpc(): void {
  // macOS applies a new screen recording permission only to a freshly started app.
  handleNoArgs('app:relaunch', () => { app.relaunch(); app.exit(0); });
  handleNoArgs('app:info', (): AppInfo => ({
    platform: process.platform, arch: process.arch, version: app.getVersion(),
    electron: process.versions.electron ?? '', chrome: process.versions.chrome ?? '',
    osVersion: process.getSystemVersion(), projectsRoot: store.root, smoke: SMOKE,
    ...(SUITE ? { suite: SUITE } : {}),
    ...(SMOKE && process.env.ZEYVOLA_SMOKE_EXPORT_MATRIX === '1' ? { smokeExportMatrix: true } : {}),
  }));

  // Projects
  handleNoArgs('projects:list', () => store.list());
  handle('projects:create', async ({ name }) => {
    const r = await store.create(name);
    return { id: r.id };
  });
  handle('projects:open', async ({ id }): Promise<OpenedProject> => {
    const project = await store.read(id);
    return { id, json: project, mediaBase: mediaBase(id), dir: store.dirOf(id) };
  });
  handle('projects:save', ({ id, json }) => store.save(id, json));
  handle('projects:rename', ({ id, name }) => store.rename(id, name));
  handle('projects:trash', async ({ id }) => {
    await shell.trashItem(store.dirOf(id));
    store.forget(id);
  });
  handle('projects:reveal', ({ id }) => shell.showItemInFolder(join(store.dirOf(id), 'project.json')));
  handle('projects:readText', async ({ id, path }) => readFile(store.resolve(id, path), 'utf8'));
  handle('projects:setThumbnail', async ({ id, dataUrl }) => {
    await store.setThumbnail(id, Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64'));
  });

  // Permissions
  handleNoArgs('permissions:get', () => getPermissions());
  handle('permissions:request', ({ kind }) => requestPermission(kind));
  handle('permissions:openSettings', ({ kind }) => openPermissionSettings(kind));

  // Capture
  handleNoArgs('capture:backends', () => capture.backends());
  handleNoArgs('capture:sources', () => capture.listSources());
  handleNoArgs('capture:state', () => capture.state);
  handle('capture:start', async (config) => {
    await capture.start(config);
  });
  handleNoArgs('capture:pause', () => capture.pause());
  handleNoArgs('capture:resume', () => capture.resume());
  handleNoArgs('capture:mark', () => capture.mark());
  handleNoArgs('capture:stop', () => capture.stop());
  handleNoArgs('capture:cancel', () => capture.cancel());
  handleNoArgs('capture:dismissError', () => capture.resetError());
  handleNoArgs('capture:recoveries', () => capture.recoveryNotices());
  handle('capture:dismissRecovery', ({ recordingId }) => capture.dismissRecovery(recordingId));

  // Messages from the hidden capture window (only that window may send them).
  const fromWorker = <T>(channel: string, schema: ZodType<T>, fn: (p: T) => unknown) => {
    ipcMain.handle(channel, (e, payload) => {
      if (!capture.web.owns(e)) throw new Error('Yetkisiz gönderici');
      const parsed = schema.safeParse(payload);
      if (!parsed.success) throw new Error(`Geçersiz istek (${channel})`);
      return fn(parsed.data);
    });
  };
  fromWorker('cw:open', CaptureWorker.open, (p) => capture.web.onOpen(p.kind, p.mime));
  fromWorker('cw:chunk', CaptureWorker.chunk, (p) => capture.web.onChunk(p.handle, p.data, p.first));
  fromWorker('cw:close', CaptureWorker.close, (p) => capture.web.onClose(p.handle, p));
  fromWorker('cw:started', CaptureWorker.started, (p) => capture.web.onStarted(p.startedAtMs));
  fromWorker('cw:ready', CaptureWorker.ready, () => capture.web.onReady());
  fromWorker('cw:busy', CaptureWorker.busy, () => capture.web.onBusy());
  fromWorker('cw:level', CaptureWorker.level, (p) => capture.web.onLevel(p.mic));
  fromWorker('cw:failed', CaptureWorker.failed, (p) => capture.web.onFailed(p.message));

  // Export. While an export runs its window keeps decoding and drawing at full speed even in the
  // background (another app or Space in front); otherwise Chromium slows its video seeks and timers
  // there and the export all but stops.
  // The computer must not sleep in the middle of an export either: one power save blocker is
  // held while any export runs. An export whose window closes or whose renderer dies is
  // cancelled at once and its partial file deleted.
  const exporting = new Map<string, Electron.WebContents>();
  const watched = new WeakSet<Electron.WebContents>();
  let sleepBlocker: number | null = null;
  const releaseExport = (exportId: string) => {
    const wc = exporting.get(exportId);
    exporting.delete(exportId);
    // The smoke test's window never throttles (windows.ts); a real one does again once idle.
    if (wc && !wc.isDestroyed() && ![...exporting.values()].includes(wc)) wc.setBackgroundThrottling(!SMOKE);
    if (exporting.size === 0 && sleepBlocker !== null) {
      if (powerSaveBlocker.isStarted(sleepBlocker)) powerSaveBlocker.stop(sleepBlocker);
      sleepBlocker = null;
    }
  };
  const cancelExportsOf = (wc: Electron.WebContents) => {
    for (const [id, owner] of [...exporting]) {
      if (owner !== wc) continue;
      releaseExport(id);
      void endExport(id, true).catch(() => undefined);
    }
  };
  // Where exports go. The save dialog runs here; the renderer only gets a one-time token for the
  // chosen place (like media:pickVideo). Default folder: the one last chosen in the dialog, else
  // the user's Movies (Videos) folder. Test runs use a temporary folder and never open the dialog.
  const exportTargets = new ExportTargets();
  /** Test runs only: this run's own stand-in for a folder picked in the save dialog. */
  let chosenTestDir: string | null = null;
  const issueTarget = (path: string, overwrite: boolean, chosen: boolean): ExportTarget => ({
    token: exportTargets.issue({ path, overwrite, chosen }), name: basename(path), folder: displayFolder(dirname(path)), chosen,
  });
  const defaultExportFolder = async (projectId: string): Promise<string> => {
    const last = getLastExportFolder();
    if (last && await writableFolder(last)) return last;
    if (SMOKE) return join(store.dirOf(projectId), 'exports');
    for (const kind of ['videos', 'documents', 'home'] as const) {
      const dir = app.getPath(kind);
      if (await writableFolder(dir)) return dir;
    }
    return app.getPath('home');
  };
  handle('export:defaultTarget', async ({ projectId, suggestedName, extension }) =>
    issueTarget(await uniquePath(await defaultExportFolder(projectId), safeBaseName(suggestedName), extension), false, false));
  handle('export:chooseTarget', async ({ projectId, suggestedName, extension }, e): Promise<ExportTarget | null> => {
    const base = safeBaseName(suggestedName);
    if (SMOKE) {
      // Stands in for the user's pick: a folder outside the project, inside the test's temporary folder.
      chosenTestDir ??= await mkdtemp(join(tmpdir(), 'zeyvola-smoke-secilen-'));
      const dir = join(chosenTestDir, 'Seçilen klasör');
      await mkdir(dir, { recursive: true });
      await setLastExportFolder(dir);
      return issueTarget(await uniquePath(dir, base, extension), false, true);
    }
    const opts: SaveDialogOptions = {
      title: tm("Dışa aktarılacak yer"), buttonLabel: tm("Seç"),
      defaultPath: join(await defaultExportFolder(projectId), `${base}.${extension}`),
      filters: [{ name: extension === 'mp4' ? tm("MP4 video") : tm("WebM video"), extensions: [extension] }],
      properties: ['createDirectory', 'showOverwriteConfirmation'],
    };
    const win = BrowserWindow.fromWebContents(e.sender);
    const r = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts);
    if (r.canceled || !r.filePath) return null;
    let path = r.filePath;
    const typed = path.toLowerCase().endsWith(`.${extension}`);
    if (!typed) path = `${path}.${extension}`;
    const dir = dirname(path);
    if (!(await writableFolder(dir))) throw new Error(writeErrorMessage(Object.assign(new Error('EACCES'), { code: 'EACCES' }), dir));
    await setLastExportFolder(dir);
    // The dialog itself asked before replacing an existing file. A name we had to add the
    // extension to was not asked about, so it is never replaced (it becomes "name (2)").
    return issueTarget(path, typed && await exists(path), true);
  });
  const watchExport = async (exportId: string, wc: Electron.WebContents) => {
    if (wc.isDestroyed()) {
      await endExport(exportId, true);
      throw new Error(tm("Dışa aktarma bulunamadı"));
    }
    exporting.set(exportId, wc);
    if (!watched.has(wc)) {
      watched.add(wc);
      wc.once('destroyed', () => cancelExportsOf(wc));
      wc.on('render-process-gone', () => cancelExportsOf(wc));
    }
    wc.setBackgroundThrottling(false);
    sleepBlocker ??= powerSaveBlocker.start('prevent-app-suspension');
  };
  handle('export:encoderInfo', async ({ probe }): Promise<EncoderInfo> => {
    const forced = SMOKE ? process.env.ZEYVOLA_TEST_EXPORT_ROUTE : undefined;
    const route = forced === 'mf' || forced === 'webm' ? forced : undefined;
    const mf = process.platform !== 'win32' ? { available: false, reason: 'platform' } : probe ? await mfExports.probe() : { available: false, reason: 'not-probed' };
    return { mf, ...(route ? { route } : {}) };
  });
  handle('export:mfBegin', async ({ token, width, height, fps, bitrate, audio }, e) => {
    const target = exportTargets.take(token);
    if (!target) throw new Error(tm("Kayıt yeri artık geçerli değil. Yeri yeniden seçin."));
    if (!target.path.toLowerCase().endsWith('.mp4')) throw new Error(tm("Kayıt yeri artık geçerli değil. Yeri yeniden seçin."));
    const r = await mfExports.begin(target.path, { overwrite: target.overwrite }, { width, height, fps, bitrate, audio });
    await watchExport(r.exportId, e.sender);
    return r;
  });
  handle('export:mfWrite', ({ exportId, kind, time, duration, data }) => mfExports.write(exportId, kind, time, duration, data));
  handle('export:begin', async ({ token }, e) => {
    const target = exportTargets.take(token);
    if (!target) throw new Error(tm("Kayıt yeri artık geçerli değil. Yeri yeniden seçin."));
    const r = await exportsWriter.begin(target.path, { overwrite: target.overwrite });
    const wc = e.sender;
    if (wc.isDestroyed()) {
      await exportsWriter.end(r.exportId, true);
      throw new Error(tm("Dışa aktarma bulunamadı"));
    }
    exporting.set(r.exportId, wc);
    if (!watched.has(wc)) {
      watched.add(wc);
      wc.once('destroyed', () => cancelExportsOf(wc));
      wc.on('render-process-gone', () => cancelExportsOf(wc));
    }
    wc.setBackgroundThrottling(false);
    sleepBlocker ??= powerSaveBlocker.start('prevent-app-suspension');
    return r;
  });
  handle('export:write', ({ exportId, position, data }) => exportsWriter.write(exportId, position, data));
  handle('export:end', async ({ exportId, cancel }) => {
    try {
      return await endExport(exportId, cancel);
    } finally {
      releaseExport(exportId);
    }
  });
  handle('shell:showItem', ({ path }) => shell.showItemInFolder(path));
  handleNoArgs('settings:get', () => settingsInfo());

  // Third-party licenses, written into dist/licenses by the build (scripts/build-licenses.mjs).
  const LICENSES = join(__dirname, '..', 'licenses');
  handleNoArgs('licenses:get', async (): Promise<ThirdPartyInfo> => JSON.parse(await readFile(join(LICENSES, 'third-party.json'), 'utf8')) as ThirdPartyInfo);
  handleNoArgs('licenses:openChromium', async () => {
    const error = await shell.openPath(join(LICENSES, 'LICENSES.chromium.html'));
    if (error) throw new Error(tm("Chromium lisans bildirimleri açılamadı: {msg}", { msg: error }));
  });
  handleNoArgs('licenses:openNotices', async () => {
    const error = await shell.openPath(join(LICENSES, 'THIRD_PARTY_NOTICES.md'));
    if (error) throw new Error(tm("Lisans dosyası açılamadı: {msg}", { msg: error }));
  });
  handle('settings:set', ({ language }) => updateSettings({ language }));

  // Videos added from the computer. The system file dialog runs here; the renderer only gets
  // a one-time token for the picked file, never a path it could choose itself.
  const picked = new Map<string, string>();
  const pickToken = async (path: string): Promise<PickedFile> => {
    const token = `pick_${randomBytes(8).toString('hex')}`;
    picked.set(token, path);
    return { token, name: basename(path), bytes: (await stat(path)).size };
  };
  handleNoArgs('media:pickVideo', async (e): Promise<PickedFile | null> => {
    const opts: OpenDialogOptions = {
      title: tm("Video ekle"), buttonLabel: tm("Ekle"), properties: ['openFile'],
      filters: [{ name: tm("Video"), extensions: Object.keys(IMPORT_VIDEO_TYPES).map((x) => x.slice(1)) }],
    };
    const win = BrowserWindow.fromWebContents(e.sender);
    const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
    const path = r.filePaths[0];
    return r.canceled || !path ? null : pickToken(path);
  });
  handle('media:importVideo', async ({ id, token }) => {
    const path = picked.get(token);
    picked.delete(token);
    if (!path) throw new Error(tm("Seçilen dosya bulunamadı."));
    const imp = await store.importVideo(id, path);
    const r = await extractImportAudio(store.resolve(id, imp.file), imp.file).catch(() => null);
    if (r && 'audio' in r) return { ...imp, audio: r.audio };
    if (r && 'issue' in r) return { ...imp, audioIssue: r.issue };
    return imp;
  });
  handle('media:discardImport', ({ id, recordingId }) => store.discardImport(id, recordingId));

  // Test-only channels: registered exclusively in --smoke mode (temporary projects folder).
  if (SMOKE) {
    const shotsDir = process.env.ZEYVOLA_SHOTS_DIR ?? join(store.root, 'shots');
    // Exported files are checked with the operating system's own decoders (tests/media-check:
    // AVFoundation on macOS, Media Foundation on Windows), not Chromium's. The probe is outside the
    // package; run-suite.mjs passes its path (ZEYVOLA_MEDIA_CHECK). Paths are limited to the test's
    // temporary folders.
    const testPath = (p: { projectId?: string; path: string }): string => {
      const full = p.projectId ? store.resolve(p.projectId, p.path) : resolve(p.path);
      const roots = [store.root, ...(chosenTestDir ? [chosenTestDir] : [])];
      // relative(), not a '/' prefix: Windows paths use backslashes.
      const inside = (r: string) => { const rel = relative(r, full); return !!rel && !rel.startsWith('..') && !isAbsolute(rel); };
      if (!roots.some(inside)) throw new Error('test path outside the test folders');
      return full;
    };
    ipcMain.handle('smoke:avCheck', async (_e, p: { projectId?: string; path: string; require?: string; duration?: number }) => {
      const probe = process.env.ZEYVOLA_MEDIA_CHECK ?? resolve(app.getAppPath(), '..', '..', 'tests', 'media-check', 'av-check.mjs');
      if (!(await exists(probe))) return { ok: false, skipped: true, problems: ['sistem sondası bulunamadı (ZEYVOLA_MEDIA_CHECK)'] };
      const mod = (await import(pathToFileURL(probe).href)) as {
        avCheck: (file: string, o: { require?: string; duration?: number }) => unknown;
      };
      return mod.avCheck(testPath(p), { require: p.require ?? 'h264-aac', duration: p.duration });
    });
    ipcMain.handle('smoke:listDir', async (_e, p: { path: string }) => readdir(testPath(p)).catch(() => []));
    ipcMain.handle('smoke:writeFile', async (_e, p: { projectId: string; path: string; data: Uint8Array }) => {
      const file = store.resolve(p.projectId, p.path);
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, p.data);
    });
    // Stands in for the file dialog: a file already inside the (temporary) project folder.
    ipcMain.handle('smoke:pickFile', (_e, p: { projectId: string; path: string }) => pickToken(store.resolve(p.projectId, p.path)));
    ipcMain.handle('smoke:appendRecording', (_e, p: { projectId: string; recording: never }) => store.appendRecording(p.projectId, p.recording));
    // An H.264 + AAC video with flashes and tones at known times (tests/real-capture/make-fixture.swift,
    // fixture-av.mp4), copied into the temporary project: ZEYVOLA_SMOKE_AAC_FIXTURE=<file>.
    ipcMain.handle('smoke:aacFixture', async (_e, p: { projectId: string }) => {
      const src = process.env.ZEYVOLA_SMOKE_AAC_FIXTURE;
      if (!src) return null;
      const rel = 'incoming/telefon.mp4';
      const dest = store.resolve(p.projectId, rel);
      await mkdir(dirname(dest), { recursive: true });
      await copyFile(src, dest);
      return rel;
    });
    // A real recording (native helper: tests/real-capture; browser path: tests/real-capture-web), copied
    // into the temporary project: ZEYVOLA_REAL_RECORDING_DIR holds its files and recording.json.
    ipcMain.handle('smoke:realRecording', async (_e, p: { projectId: string } | RealCaptureOp) => {
      if ('op' in p) return realCaptureOp(p);
      const dir = process.env.ZEYVOLA_REAL_RECORDING_DIR;
      if (!dir) return null;
      const meta = JSON.parse(await readFile(join(dir, 'recording.json'), 'utf8')) as Omit<Recording, 'id' | 'createdAt' | 'duration' | 'syncOffsets'> & { durationTicks: number };
      const recordingId = newId('rec');
      const media = await store.mediaDir(p.projectId, recordingId);
      const moved = (file: string) => `media/${recordingId}/${basename(file)}`;
      const sources: Recording['sources'] = {};
      for (const [kind, src] of Object.entries(meta.sources)) {
        if (!src) continue;
        await copyFile(join(dir, basename(src.file)), join(media, basename(src.file)));
        sources[kind as keyof Recording['sources']] = { ...src, file: moved(src.file) };
      }
      if (meta.cursorFile) await copyFile(join(dir, basename(meta.cursorFile)), join(media, basename(meta.cursorFile)));
      const recording: Recording = {
        id: recordingId, createdAt: new Date().toISOString(), duration: meta.durationTicks, sources,
        cursorFile: meta.cursorFile ? moved(meta.cursorFile) : undefined,
        capture: { ...meta.capture, platform: `${process.platform}-${process.arch}` }, syncOffsets: {}, markers: meta.markers,
      };
      await store.appendRecording(p.projectId, recording);
      return { recordingId, duration: meta.durationTicks };
    });
    // Real screen recording inside a test run (CI on Windows: tests/real-capture-web/windows-clicks.ps1).
    // ZEYVOLA_TEST_REAL_CAPTURE=1 asks the interface test to record the screen for a few seconds;
    // ZEYVOLA_TEST_SIGNAL_DIR is a folder shared with the outside click driver: the test leaves
    // small marker files there ("recording", "stopped") and reads the driver's click log back.
    // These go through smoke:realRecording (op), the preload's existing channel for real recordings.
    const signalDir = process.env.ZEYVOLA_TEST_SIGNAL_DIR ?? null;
    const signalName = (n: unknown): string => {
      if (typeof n !== 'string' || !/^[a-z0-9-]{1,40}(\.json)?$/.test(n)) throw new Error('bad signal name');
      return n;
    };
    type RealCaptureOp =
      | { op: 'env' }
      | { op: 'signal' | 'readSignal'; name: string }
      | { op: 'keep'; projectId: string; path: string; as: string }
      | { op: 'readExport'; path: string };
    const realCaptureOp = async (p: RealCaptureOp): Promise<unknown> => {
      // ZEYVOLA_UITEST_ONLY=export: the interface test runs only the export steps (CI's extra runs).
      // ZEYVOLA_TEST_EXPECT_ROUTE: the export route this machine must pick (webcodecs | mf | webm-fallback).
      if (p.op === 'env') {
        return {
          realCapture: process.env.ZEYVOLA_TEST_REAL_CAPTURE === '1', signals: !!signalDir,
          only: process.env.ZEYVOLA_UITEST_ONLY ?? null, expectRoute: process.env.ZEYVOLA_TEST_EXPECT_ROUTE ?? null,
        };
      }
      if (p.op === 'signal') {
        if (!signalDir) return false;
        await writeFile(join(signalDir, signalName(p.name)), `${Date.now()}\n`);
        return true;
      }
      // readExport: the bytes of an exported file the media protocol does not serve (one written to the
      // folder picked with "Değiştir…", outside the project), so the test can decode a frame of it.
      // Limited to the test's temporary folders, like the other test file access (testPath).
      if (p.op === 'readExport') return new Uint8Array(await readFile(testPath(p)));
      if (p.op === 'readSignal') return signalDir ? readFile(join(signalDir, signalName(p.name)), 'utf8').catch(() => null) : null;
      if (p.op !== 'keep') throw new Error('unknown op');
      // keep: copies a file of a (temporary) project next to the screenshots, for CI artifacts.
      await mkdir(shotsDir, { recursive: true });
      const dest = join(shotsDir, basename(p.as.replace(/[^\w.-]/g, '')));
      await copyFile(store.resolve(p.projectId, p.path), dest);
      return dest;
    };
    // CPU seconds used so far by every process of the app (main, GPU, renderers, utilities).
    ipcMain.handle('smoke:cpu', (): CpuSample => {
      const byType: Record<string, number> = {};
      for (const m of app.getAppMetrics()) byType[m.type] = (byType[m.type] ?? 0) + (m.cpu.cumulativeCPUUsage ?? 0);
      return { atMs: performance.now(), seconds: Object.values(byType).reduce((a, b) => a + b, 0), byType };
    });
    // A picture of the window: a name, or { name, width } to scale it down (README screenshots).
    ipcMain.handle('smoke:shot', async (_e, p: string | { name: string; width?: number }) => {
      if (!mainWindow) return null;
      const name = typeof p === 'string' ? p : p.name;
      const width = typeof p === 'string' ? undefined : p.width;
      let img = await mainWindow.webContents.capturePage();
      if (width && img.getSize().width > width) img = img.resize({ width, quality: 'best' });
      await mkdir(shotsDir, { recursive: true });
      const file = join(shotsDir, `${name.replace(/[^a-z0-9-]/gi, '')}.png`);
      await writeFile(file, img.toPNG());
      return { file, width: img.getSize().width, height: img.getSize().height };
    });
  }

  // Smoke test report from the renderer. --smoke-report <file> also writes it to a file, for
  // systems where the app's standard output is hard to read (a Windows GUI executable).
  ipcMain.handle('smoke:report', async (_e, report: unknown) => {
    if (!SMOKE) return;
    process.stdout.write(`SMOKE_REPORT ${JSON.stringify(report)}\n`);
    const reportFile = argAfter('--smoke-report');
    if (reportFile) await writeFile(reportFile, `${JSON.stringify(report, null, 1)}\n`).catch((e: Error) => process.stderr.write(`Smoke raporu yazılamadı: ${e.message}\n`));
    const ok = typeof report === 'object' && report !== null && (report as { ok?: unknown }).ok === true;
    setTimeout(() => app.exit(ok ? 0 : 1), 100);
  });
}

// ─── Tray and shortcuts while recording ───────────────────────────────────────

const SHORTCUTS: [string, () => void][] = [
  ['Alt+Shift+S', () => void capture.stop()],
  ['Alt+Shift+P', () => void (capture.state.phase === 'paused' ? capture.resume() : capture.pause())],
  ['Alt+Shift+M', () => capture.mark()],
];

function updateRecordingChrome(): void {
  const phase = capture.state.phase;
  const active = phase === 'recording' || phase === 'paused' || phase === 'countdown';
  if (active && !tray) {
    tray = new Tray(nativeImage.createFromBuffer(circleIcon(32, [255, 60, 51]), { scaleFactor: 2 }));
    tray.setToolTip(`${APP_NAME} — ${tm('kayıt')}`);
    for (const [acc, fn] of SHORTCUTS) globalShortcut.register(acc, fn);
  }
  if (!active && tray) {
    tray.destroy();
    tray = null;
    for (const [acc] of SHORTCUTS) globalShortcut.unregister(acc);
  }
  if (tray) {
    const s = Math.floor(capture.state.elapsedMs / 1000);
    if (process.platform === 'darwin') tray.setTitle(` ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`);
    tray.setContextMenu(Menu.buildFromTemplate([
      phase === 'paused'
        ? { label: `${tm('Devam et')} (${shortcutLabel('alt+shift+P', process.platform)})`, click: () => void capture.resume() }
        : { label: `${tm('Duraklat')} (${shortcutLabel('alt+shift+P', process.platform)})`, click: () => void capture.pause(), enabled: phase === 'recording' },
      { label: `${tm('İşaret koy')} (${shortcutLabel('alt+shift+M', process.platform)})`, click: () => capture.mark(), enabled: phase === 'recording' },
      { type: 'separator' },
      { label: `${tm('Kaydı bitir')} (${shortcutLabel('alt+shift+S', process.platform)})`, click: () => void capture.stop() },
      { label: tm('Kaydı iptal et'), click: () => void capture.cancel() },
    ]));
  }
}

// ─── App lifecycle ────────────────────────────────────────────────────────────

async function boot(): Promise<void> {
  if (!SMOKE && !CODEC_PROBE && !TEST_HOME) {
    const moved = await migrateLegacyData({ videos: app.getPath('videos'), userData: app.getPath('userData'), projectsFolder: PROJECTS_FOLDER }).catch((e: unknown) => [`taşınamadı: ${String(e)}`]);
    for (const m of moved) console.log(`[zeyvola] eski adla kalan veri: ${m}`);
  }
  await loadSettings(SMOKE ? { ephemeral: true, language: 'tr' } : {});
  if (TERMS_PENDING) {
    // Accept: remember it, give the DLL its real name and start again with hardware acceleration
    // (a failed rename is reported by that next start). Decline: quit; the DLL keeps its pending name.
    if (await askForTerms()) {
      recordAcceptance(app.getPath('userData'));
      activateDll();
      app.relaunch();
    }
    app.exit(0);
    return;
  }
  if (RESTART_FOR_DLL) {
    app.relaunch();
    app.exit(0);
    return;
  }
  if (ACTIVATION && !ACTIVATION.ok) await tellActivationFailed(ACTIVATION.dir);
  onSettingsChanged((info) => {
    broadcast('settings:changed', info);
    updateRecordingChrome();
    if (capture) broadcast('capture:recovered', capture.recoveryNotices());
  });
  const root = SMOKE ? await mkdtemp(join(tmpdir(), 'zeyvola-smoke-')) : TEST_HOME ? join(TEST_HOME, 'projects') : join(app.getPath('videos'), PROJECTS_FOLDER);
  store = new ProjectStore(root);
  await store.init();
  handleMediaProtocol(store);
  icon = nativeImage.createFromBuffer(appIcon(512));
  if (process.platform === 'darwin') app.dock?.setIcon(icon);
  capture = new CaptureManager({
    store, createCaptureWindow, showHud, hideHud,
    onSessionStart: minimizeForCapture,
    beforeRecording: waitForWindowsSettled,
  });
  let lastTrayUpdate = 0;
  capture.on('state', (s) => {
    broadcast('capture:state', s);
    const now = Date.now();
    if (now - lastTrayUpdate > 500 || s.phase !== 'recording') {
      lastTrayUpdate = now;
      updateRecordingChrome();
    }
  });
  capture.on('releaseDevices', () => broadcast('capture:releaseDevices', null));
  capture.on('recoveries', (list) => broadcast('capture:recovered', list));
  capture.on('finished', (r) => {
    if (!mainWindow || mainWindow.isDestroyed()) pendingFinished = r; // delivered when the window reopens
    broadcast('capture:finished', r);
    restoreMain();
  });
  // Cancelled or failed sessions bring the window back too.
  capture.on('state', (s) => { if ((s.phase === 'error' || s.phase === 'idle') && minimizedForCapture) restoreMain(); });
  registerIpc();
  openMainWindow();
  // Recordings left behind by a recorder or app that stopped mid-recording.
  if (!SMOKE) void capture.recoverAbandoned().catch((e) => process.stderr.write(`Kurtarma taraması başarısız: ${String(e)}\n`));
  if (SMOKE) {
    // ZEYVOLA_TEST_TIMEOUT_MIN: slower machines (a CI runner without a graphics card exports at a few
    // frames per second) get more time; the default fits a desktop.
    const minutes = Number(process.env.ZEYVOLA_TEST_TIMEOUT_MIN);
    setTimeout(() => {
      process.stdout.write('SMOKE_REPORT {"ok":false,"error":"timeout"}\n');
      app.exit(2);
    }, minutes > 0 ? minutes * 60_000 : SUITE === 'smoke' ? 240_000 : 420_000);
  }
}

app.on('second-instance', () => restoreMain());

app.whenReady().then(() => (CODEC_PROBE ? runCodecProbe(CODEC_PROBE, argAfter('--codec-fixtures')).then((code) => app.exit(code)) : boot())).catch((e) => {
  process.stderr.write(`Başlatma hatası: ${String(e)}\n`);
  app.exit(1);
});

app.on('window-all-closed', () => {
  if (SMOKE) { app.quit(); return; }
  if (CODEC_PROBE) return; // runCodecProbe exits by itself
  // Never quit in the middle of a recording; the tray and shortcuts still control it.
  const p = capture?.state.phase;
  if (p && p !== 'idle' && p !== 'error') return;
  if (process.platform !== 'darwin') app.quit();
});

// Dock click (macOS): bring back a minimized or hidden window, or open a new one.
app.on('activate', () => {
  if (!app.isReady()) return;
  restoreMain();
});

// Quitting in the middle of an export cancels it; the partial file is deleted before the app exits.
let exportsCancelled = false;
app.on('will-quit', (e) => {
  globalShortcut.unregisterAll();
  if (exportsCancelled || exportsWriter.pending + mfExports.pending === 0) return;
  e.preventDefault();
  exportsCancelled = true;
  void Promise.allSettled([exportsWriter.cancelAll(), mfExports.cancelAll()]).finally(() => app.quit());
});

export { hudWindow };
