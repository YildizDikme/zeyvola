import { z } from 'zod';

/**
 * IPC contract between the Electron main process, the renderer windows and the
 * capture backends. Every renderer → main payload is validated with these schemas.
 */

export const ProjectId = z.string().regex(/^prj_[A-Za-z0-9-]{8,64}$/);
const RelPath = z.string().min(1).max(512).refine((p) => !p.includes('..') && !p.startsWith('/') && !p.includes('\\'), 'geçersiz yol');

export const CaptureTarget = z.object({
  kind: z.enum(['display', 'window', 'region']),
  /** desktopCapturer / native source id. */
  sourceId: z.string().min(1).max(256),
  displayId: z.string().max(64).optional(),
  label: z.string().max(256),
  /** For 'region': rect in display points relative to the display's top-left. */
  region: z.object({ x: z.number(), y: z.number(), w: z.number().positive(), h: z.number().positive() }).optional(),
});
export type CaptureTarget = z.infer<typeof CaptureTarget>;

export const CaptureConfig = z.object({
  projectId: ProjectId.optional(),
  projectName: z.string().max(200).optional(),
  target: CaptureTarget,
  cameraDeviceId: z.string().max(512).nullable(),
  /** Device names, used by native backends to match OS devices. */
  cameraLabel: z.string().max(512).nullable().default(null),
  micDeviceId: z.string().max(512).nullable(),
  micLabel: z.string().max(512).nullable().default(null),
  systemAudio: z.boolean(),
  fps: z.union([z.literal(30), z.literal(60)]),
  quality: z.enum(['standard', 'high', 'max']),
  countdown: z.number().int().min(0).max(10),
  backend: z.enum(['auto', 'native', 'web']).default('auto'),
});
export type CaptureConfig = z.infer<typeof CaptureConfig>;

export type CapturePhase = 'idle' | 'preparing' | 'countdown' | 'recording' | 'paused' | 'finishing' | 'error';

export interface CaptureState {
  phase: CapturePhase;
  backend: 'native-macos' | 'native-windows' | 'web' | null;
  elapsedMs: number;
  countdown: number;
  micLevel: number;
  droppedFrames: number;
  diskFreeBytes: number | null;
  /** Camera/microphone are open, warmed up and owned by the recorder. */
  devicesReady: boolean;
  message?: string;
}

export interface CaptureResult {
  projectId: string;
  recordingId: string;
}

/** A recording rebuilt from its files after the recorder stopped unexpectedly. */
export interface RecoveryNotice {
  projectId: string;
  recordingId: string;
  recoveredMs: number;
  /** Ready to show, in the app's language. */
  message: string;
}

export interface SourceInfo {
  id: string;
  kind: 'display' | 'window';
  name: string;
  displayId?: string;
  thumbnail: string | null;
  appIcon?: string | null;
  bounds?: { x: number; y: number; w: number; h: number };
  scaleFactor?: number;
}

export interface BackendInfo {
  id: 'native-macos' | 'native-windows' | 'web';
  available: boolean;
  reason?: string;
  capabilities: {
    separateCursor: boolean;
    clicks: boolean;
    systemAudio: boolean;
    pause: boolean;
  };
}

export type PermissionStatus = 'granted' | 'denied' | 'restricted' | 'not-determined' | 'unknown';

export interface PermissionInfo {
  screen: PermissionStatus;
  camera: PermissionStatus;
  microphone: PermissionStatus;
  /** Click capture (macOS: mouse events need no extra permission; keyboard would). */
  input: PermissionStatus;
}

export interface ProjectSummary {
  id: string;
  name: string;
  updatedAt: string;
  createdAt: string;
  durationTicks: number;
  recordings: number;
  thumbnail: string | null;
  sizeBytes: number;
}

/** Third-party licenses shipped with the app (dist/licenses/third-party.json). */
export interface ThirdPartyInfo {
  /** The app's own license; null while it has not been chosen. */
  ownLicense: string | null;
  /** The license's "Required Notice:" / "Licensor Line of Business:" lines (NOTICE). */
  ownNotice?: string[];
  /** Distribution this build belongs to (apps/desktop/src/shared/distribution.ts). */
  distribution: 'mp4' | 'webm' | 'webm-vp8' | null;
  packages: { name: string; version: string; license: string; copyright: string[]; repository: string; text: string }[];
  electron: { version: string; license: string; copyright: string[]; text: string; chromiumEntries: number; chromiumFile: string };
  codecs: {
    id: string; name: string; nameEn?: string; profiles: ('mp4' | 'webm')[];
    where: { tr: string; en: string }; license: { tr: string; en: string }; patent: { tr: string; en: string };
    status: 'legal-review' | 'low-risk-unverified';
    inChromiumNotice: boolean | null;
  }[];
  /** Components shipped with Electron that its Chromium notices do not cover. */
  supplements: { id: string; name: string; platforms: string[]; version: string; license: string; source: string; text: string }[];
}

/** A video the user picked in the system file dialog. Only main knows its path. */
export interface PickedFile {
  token: string;
  name: string;
  bytes: number;
}

/**
 * Where an export will be written. Main keeps the path; the renderer gets a one-time token to
 * start the export with, plus the folder and name to show.
 */
export interface ExportTarget {
  token: string;
  /** File name with extension. */
  name: string;
  /** Folder for display only; "~" stands for the home folder. */
  folder: string;
  /** True when the user picked it in the system save dialog. */
  chosen: boolean;
}

/** A picked video after it was copied into the project folder. */
export interface ImportedVideo {
  recordingId: string;
  /** Path relative to the project folder. */
  file: string;
  mime: string;
  /** File name without extension, shown to the user. */
  name: string;
  bytes: number;
  /** The video's sound re-encoded by the operating system (Opus on macOS, PCM WAV on Windows), when the app cannot decode the original (AAC). */
  audio?: { file: string; mime: string; from: string };
  /** The video has sound that could not be converted; the user is told and no silent sound track is added. */
  audioIssue?: { codec: string; reason: string };
}

/** Video files that can be added from the computer (Chromium decodes them). */
export const IMPORT_VIDEO_TYPES: Record<string, string> = { '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/mp4', '.webm': 'video/webm' };

export interface OpenedProject {
  id: string;
  json: unknown;
  /** URL prefix for the project's media via the app-media protocol. */
  mediaBase: string;
  dir: string;
}

export interface AppInfo {
  platform: NodeJS.Platform | string;
  arch: string;
  version: string;
  electron: string;
  chrome: string;
  osVersion: string;
  projectsRoot: string;
  smoke: boolean;
  /** Which in-app test suite runs (apps/desktop/src/shared/test-suite.ts); absent in normal use. */
  suite?: 'smoke' | 'perf' | 'ui' | 'docs';
  /** Smoke only: also time exports at 1080p/4K, 30/60 fps (ZEYVOLA_SMOKE_EXPORT_MATRIX=1). */
  smokeExportMatrix?: boolean;
}

/** Test suites only: CPU time used so far by all of the app's processes. */
export interface CpuSample {
  atMs: number;
  seconds: number;
  byType: Record<string, number>;
}

export const ExportTargetToken = z.string().regex(/^exp_[a-f0-9]{24}$/);

/** Asks main for a place to export to: its default folder, or the system save dialog. */
export const ExportTargetRequest = z.object({
  projectId: ProjectId,
  suggestedName: z.string().min(1).max(200),
  extension: z.enum(['mp4', 'webm']),
});

export const ExportBegin = z.object({ token: ExportTargetToken });

/**
 * What can write MP4 besides the renderer's own (hardware) encoders: on Windows, the helper with
 * Windows' Media Foundation encoders. `route` is set only in test runs (ZEYVOLA_TEST_EXPORT_ROUTE)
 * to force a path of the export decision.
 */
export interface EncoderInfo {
  /** `profile`: the H.264 profile Windows' encoder accepted ("high", else "baseline"). */
  mf: { available: boolean; reason?: string; profile?: string };
  /** Test runs only. Answered without the probe, so a forced route works on any machine. */
  route?: 'mf' | 'webm';
}

const Even = (max: number) => z.number().int().min(16).max(max).refine((n) => n % 2 === 0, 'tek sayı');

/** Starts an MP4 export through the Windows helper (Media Foundation), at the place `token` names. */
export const ExportMfBegin = z.object({
  token: ExportTargetToken,
  width: Even(8192),
  height: Even(8192),
  fps: z.number().int().min(1).max(240),
  bitrate: z.number().int().min(1).max(500_000_000),
  audio: z.boolean(),
});

/** One NV12 frame or a block of 16-bit stereo PCM for an export started with export:mfBegin. Times in 100 ns. */
export const ExportMfWrite = z.object({
  exportId: z.string().regex(/^mf_[0-9a-f-]{36}$/),
  kind: z.enum(['video', 'audio']),
  time: z.number().int().min(0),
  duration: z.number().int().min(0),
  data: z.instanceof(Uint8Array),
});

export const ExportWrite = z.object({
  exportId: z.string().min(8).max(80),
  position: z.number().int().min(0).nullable(),
  data: z.instanceof(Uint8Array),
});

export const Schemas = {
  'projects:create': z.object({ name: z.string().min(1).max(200) }),
  'projects:open': z.object({ id: ProjectId }),
  'projects:save': z.object({ id: ProjectId, json: z.string().max(50_000_000) }),
  'projects:rename': z.object({ id: ProjectId, name: z.string().min(1).max(200) }),
  'projects:trash': z.object({ id: ProjectId }),
  'projects:reveal': z.object({ id: ProjectId }),
  'projects:readText': z.object({ id: ProjectId, path: RelPath }),
  'projects:setThumbnail': z.object({ id: ProjectId, dataUrl: z.string().startsWith('data:image/jpeg;base64,').max(2_000_000) }),
  'capture:start': CaptureConfig,
  'permissions:request': z.object({ kind: z.enum(['camera', 'microphone', 'screen']) }),
  'permissions:openSettings': z.object({ kind: z.enum(['camera', 'microphone', 'screen', 'input']) }),
  'export:defaultTarget': ExportTargetRequest,
  'export:chooseTarget': ExportTargetRequest,
  'export:begin': ExportBegin,
  'export:encoderInfo': z.object({ probe: z.boolean() }),
  'export:mfBegin': ExportMfBegin,
  'export:mfWrite': ExportMfWrite,
  'export:write': ExportWrite,
  'export:end': z.object({ exportId: z.string().min(8).max(80), cancel: z.boolean().default(false) }),
  'shell:showItem': z.object({ path: z.string().min(1).max(4096) }),
  'settings:set': z.object({ language: z.enum(['auto', 'tr', 'en']) }),
  'media:importVideo': z.object({ id: ProjectId, token: z.string().regex(/^pick_[a-f0-9]{16}$/) }),
  'media:discardImport': z.object({ id: ProjectId, recordingId: z.string().regex(/^imp_[a-f0-9]{12}$/) }),
  'capture:dismissRecovery': z.object({ recordingId: z.string().regex(/^rec_[A-Za-z0-9-]{8,64}$/) }),
} as const;

export type Channel = keyof typeof Schemas;

/** Messages from the hidden browser-capture window to main. */
/** What a capture-window recorder knows about its track (settings, and on the app clock when its file's first frame was captured). */
const trackMeta = {
  firstFrameMs: z.number().nullable(),
  width: z.number().int().min(0).max(16384).optional(),
  height: z.number().int().min(0).max(16384).optional(),
  fps: z.number().min(0).max(240).optional(),
  sampleRate: z.number().int().min(0).max(384000).optional(),
  channels: z.number().int().min(0).max(16).optional(),
};

export const CaptureWorker = {
  open: z.object({ kind: z.enum(['screen', 'camera', 'mic', 'system']), mime: z.string().max(120) }),
  /** `first`: sent with a file's first chunk, so a crash-recovery log can describe the file early. */
  chunk: z.object({ handle: z.string().max(80), data: z.instanceof(Uint8Array), first: z.object(trackMeta).optional() }),
  close: z.object({ handle: z.string().max(80), ...trackMeta }),
  started: z.object({ startedAtMs: z.number(), kinds: z.array(z.enum(['screen', 'camera', 'mic', 'system'])) }),
  ready: z.object({ cameraWarmupMs: z.number().min(0).max(60_000).nullable() }),
  busy: z.object({ device: z.enum(['camera', 'mic']) }),
  level: z.object({ mic: z.number().min(0).max(1) }),
  failed: z.object({ message: z.string().max(2000) }),
};
