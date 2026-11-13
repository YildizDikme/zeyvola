import type {
  AppInfo, BackendInfo, CaptureConfig, CaptureResult, CaptureState, OpenedProject, PermissionInfo, ProjectSummary, RecoveryNotice, SourceInfo, ImportedVideo, PickedFile, ThirdPartyInfo, ExportTarget,
} from '@zeyvola/protocol';
import type { LangSetting, SettingsInfo } from '../shared/i18n';

interface Bridge {
  invoke(channel: string, payload?: unknown): Promise<unknown>;
  on(channel: string, listener: (data: unknown) => void): () => void;
  platform: string;
}

declare global {
  interface Window {
    zeyvola: Bridge;
  }
}

const bridge = (): Bridge => window.zeyvola;
/** Electron wraps errors from the main process ("Error invoking remote method 'x': Error: …"); keep only the message. */
const cleanError = (e: unknown): Error => new Error(String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']*': (?:\w*Error: )?/, ''));
const call = <T>(channel: string, payload?: unknown) => (bridge().invoke(channel, payload) as Promise<T>).catch((e: unknown) => { throw cleanError(e); });

/** Typed facade over the preload bridge. */
export const api = {
  platform: () => bridge().platform,
  appInfo: () => call<AppInfo>('app:info'),

  listProjects: () => call<ProjectSummary[]>('projects:list'),
  createProject: (name: string) => call<{ id: string }>('projects:create', { name }),
  openProject: (id: string) => call<OpenedProject>('projects:open', { id }),
  saveProject: (id: string, json: string) => call<void>('projects:save', { id, json }),
  renameProject: (id: string, name: string) => call<void>('projects:rename', { id, name }),
  trashProject: (id: string) => call<void>('projects:trash', { id }),
  revealProject: (id: string) => call<void>('projects:reveal', { id }),
  readProjectText: (id: string, path: string) => call<string>('projects:readText', { id, path }),
  setThumbnail: (id: string, dataUrl: string) => call<void>('projects:setThumbnail', { id, dataUrl }),

  permissions: () => call<PermissionInfo>('permissions:get'),
  requestPermission: (kind: 'camera' | 'microphone' | 'screen') => call<boolean>('permissions:request', { kind }),
  relaunch: () => call<void>('app:relaunch'),
  openPermissionSettings: (kind: 'camera' | 'microphone' | 'screen' | 'input') => call<void>('permissions:openSettings', { kind }),

  backends: () => call<BackendInfo[]>('capture:backends'),
  sources: () => call<SourceInfo[]>('capture:sources'),
  captureState: () => call<CaptureState>('capture:state'),
  startCapture: (config: CaptureConfig) => call<void>('capture:start', config),
  pauseCapture: () => call<void>('capture:pause'),
  resumeCapture: () => call<void>('capture:resume'),
  markCapture: () => call<void>('capture:mark'),
  stopCapture: () => call<CaptureResult | null>('capture:stop'),
  cancelCapture: () => call<void>('capture:cancel'),
  dismissCaptureError: () => call<void>('capture:dismissError'),
  onCaptureState: (fn: (s: CaptureState) => void) => bridge().on('capture:state', (d) => fn(d as CaptureState)),
  onCaptureFinished: (fn: (r: CaptureResult) => void) => bridge().on('capture:finished', (d) => fn(d as CaptureResult)),
  onReleaseDevices: (fn: () => void) => bridge().on('capture:releaseDevices', () => fn()),
  /** Recordings rebuilt after the recorder stopped unexpectedly, not yet dismissed. */
  recoveries: () => call<RecoveryNotice[]>('capture:recoveries'),
  dismissRecovery: (recordingId: string) => call<void>('capture:dismissRecovery', { recordingId }),
  onRecovered: (fn: (list: RecoveryNotice[]) => void) => bridge().on('capture:recovered', (d) => fn(d as RecoveryNotice[])),

  exportDefaultTarget: (projectId: string, suggestedName: string, extension: 'mp4' | 'webm') =>
    call<ExportTarget>('export:defaultTarget', { projectId, suggestedName, extension }),
  /** Opens the system save dialog; null when the user closed it. */
  exportChooseTarget: (projectId: string, suggestedName: string, extension: 'mp4' | 'webm') =>
    call<ExportTarget | null>('export:chooseTarget', { projectId, suggestedName, extension }),
  exportBegin: (token: string) => call<{ exportId: string; path: string }>('export:begin', { token }),
  exportWrite: (exportId: string, position: number | null, data: Uint8Array) => call<void>('export:write', { exportId, position, data }),
  exportEnd: (exportId: string, cancel = false) => call<{ path: string; bytes: number } | null>('export:end', { exportId, cancel }),
  showItem: (path: string) => call<void>('shell:showItem', { path }),

  /** Opens the system file dialog for a video; null when cancelled. */
  pickVideo: () => call<PickedFile | null>('media:pickVideo'),
  importVideo: (id: string, token: string) => call<ImportedVideo>('media:importVideo', { id, token }),
  discardImport: (id: string, recordingId: string) => call<void>('media:discardImport', { id, recordingId }),

  smokeReport: (report: unknown) => call<void>('smoke:report', report),

  licenses: () => call<ThirdPartyInfo>('licenses:get'),
  openChromiumLicenses: () => call<void>('licenses:openChromium'),
  openThirdPartyNotices: () => call<void>('licenses:openNotices'),

  getSettings: () => call<SettingsInfo>('settings:get'),
  setLanguage: (language: LangSetting) => call<SettingsInfo>('settings:set', { language }),
  onSettingsChanged: (fn: (s: SettingsInfo) => void) => bridge().on('settings:changed', (d) => fn(d as SettingsInfo)),
};
