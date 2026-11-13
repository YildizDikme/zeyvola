import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { CaptureInfo, MediaSource, Recording, SourceKind } from '@zeyvola/project-model';
import { msToTicks, ticksToMs } from '@zeyvola/timing';
import { writeFileAtomic } from '../fsutil';
import type { ProbedFile, SessionMeta } from './helper-client';

/**
 * Recovery of recordings whose recorder stopped without reporting them (helper killed or
 * crashed, app quit mid-recording). The native helpers keep a sidecar log, session.jsonl, in
 * the recording folder: the session start, each file as soon as it gets its first sample
 * (with its offset on the recording clock), pauses, markers and the clean end. Together with
 * the playable length of each file (`--probe-files`) that is enough to rebuild the Recording.
 * Nothing here deletes or changes the recorded files.
 */

export const SESSION_FILE = 'session.jsonl';
/** Left in a folder the app examined but could not rebuild, so it is not tried on every start. */
export const RECOVERY_FILE = 'recovery.json';

const KINDS: readonly SourceKind[] = ['screen', 'camera', 'mic', 'system'];
const TARGET_KINDS = ['display', 'window', 'region'] as const;
/** Plain file names only: the log must not point outside its own folder. */
const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
export const RECORDING_DIR = /^rec_[A-Za-z0-9-]{8,64}$/;

export interface SessionTrack {
  kind: SourceKind;
  name: string;
  mime: string;
  startOffsetMs: number;
  width?: number;
  height?: number;
  fps?: number;
  sampleRate?: number;
  channels?: number;
}

export interface SessionLog {
  startedAtMs: number | null;
  /** The helper process that wrote the log. */
  pid: number | null;
  cursor: string | null;
  meta: SessionMeta | null;
  /** One per source kind, in the order they opened. */
  tracks: SessionTrack[];
  /** Ticks on the recording clock. */
  markers: number[];
  /** Set when the helper closed the files itself. */
  endDurationMs: number | null;
  cancelled: boolean;
  /** Whether clicks were captured (browser path; native logs leave it to the cursor file). */
  clicks: boolean | null;
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const optNum = (v: unknown, min = 0): number | undefined => (finite(v) && v > min ? v : undefined);

function parseMeta(v: unknown): SessionMeta | null {
  if (!v || typeof v !== 'object') return null;
  const m = v as Record<string, unknown>;
  const t = m.target as Record<string, unknown> | undefined;
  const b = t?.bounds as Record<string, unknown> | undefined;
  if (typeof m.recordingId !== 'string' || (m.backend !== 'native-macos' && m.backend !== 'native-windows' && m.backend !== 'web')) return null;
  if (!t || !TARGET_KINDS.includes(t.kind as never) || typeof t.label !== 'string' || !finite(t.scaleFactor) || t.scaleFactor <= 0) return null;
  if (!b || ![b.x, b.y, b.w, b.h].every(finite)) return null;
  const c = m.crop as Record<string, unknown> | undefined;
  const crop = c && [c.x, c.y, c.w, c.h].every((n) => finite(n) && n >= 0 && n <= 1) && (c.w as number) > 0 && (c.h as number) > 0
    ? { x: c.x as number, y: c.y as number, w: c.w as number, h: c.h as number } : undefined;
  return {
    recordingId: m.recordingId, backend: m.backend,
    target: {
      kind: t.kind as CaptureInfo['target']['kind'], label: t.label.slice(0, 256), scaleFactor: t.scaleFactor,
      bounds: { x: b.x as number, y: b.y as number, w: b.w as number, h: b.h as number },
    },
    ...(crop ? { crop } : {}),
  };
}

/**
 * Reads session.jsonl. Lines that are not valid (such as one cut off by a crash) are
 * skipped; returns null when the session line itself is missing.
 */
export function parseSessionLog(text: string): SessionLog | null {
  let log: SessionLog | null = null;
  for (const line of text.split('\n')) {
    let v: Record<string, unknown>;
    try { v = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
    if (!v || typeof v !== 'object') continue;
    if (v.e === 'session') {
      if (log) continue;
      log = {
        startedAtMs: finite(v.startedAtMs) ? v.startedAtMs : null,
        pid: finite(v.pid) && v.pid > 0 ? v.pid : null,
        cursor: typeof v.cursor === 'string' && FILE_NAME.test(v.cursor) ? v.cursor : null,
        meta: parseMeta(v.meta),
        tracks: [], markers: [], endDurationMs: null, cancelled: false,
        clicks: typeof v.clicks === 'boolean' ? v.clicks : null,
      };
      continue;
    }
    if (!log) continue;
    switch (v.e) {
      case 'track': {
        const kind = v.kind as SourceKind;
        if (!KINDS.includes(kind) || typeof v.name !== 'string' || !FILE_NAME.test(v.name) || typeof v.mime !== 'string' || !finite(v.startOffsetMs)) break;
        if (log.tracks.some((x) => x.kind === kind)) break;
        log.tracks.push({
          kind, name: v.name, mime: v.mime.slice(0, 120), startOffsetMs: v.startOffsetMs,
          width: optNum(v.width), height: optNum(v.height), fps: optNum(v.fps), sampleRate: optNum(v.sampleRate), channels: optNum(v.channels),
        });
        break;
      }
      case 'mark':
        if (finite(v.t) && v.t >= 0) log.markers.push(Math.round(v.t));
        break;
      case 'end':
        if (finite(v.durationMs) && v.durationMs >= 0) log.endDurationMs = v.durationMs;
        break;
      case 'cancelled':
        log.cancelled = true;
        break;
      default: // pause, resume and anything newer: not needed to rebuild the recording
    }
  }
  return log;
}

export interface RebuildInput {
  recordingId: string;
  log: SessionLog;
  probed: ProbedFile[];
  /** Names of the files in the recording folder. */
  files: readonly string[];
  /** `${process.platform}-${process.arch}` */
  platform: string;
  /** Target label when the log carries no description from the app. */
  fallbackLabel?: string;
}

export interface Rebuilt {
  recording: Recording;
  recoveredMs: number;
  /** The helper closed the files itself (the app was what stopped). */
  cleanEnd: boolean;
}

/**
 * The Recording the app would have stored, from the log and what is playable in each file.
 * Each source keeps its own offset from the log and the length that can actually be read;
 * the recording ends where the screen video ends (or at the helper's own end time). Returns
 * null for a cancelled session or when no screen video can be played.
 */
export function rebuildRecording(input: RebuildInput): Rebuilt | null {
  const { log, recordingId } = input;
  if (log.cancelled) return null;
  const rel = (name: string) => `media/${recordingId}/${name}`;
  const probed = new Map(input.probed.map((p) => [p.name, p]));
  const sources: Partial<Record<SourceKind, MediaSource>> = {};
  for (const t of log.tracks) {
    const p = probed.get(t.name);
    if (!p || p.error || !finite(p.durationMs) || p.durationMs <= 0 || !input.files.includes(t.name)) continue;
    sources[t.kind] = {
      kind: t.kind, file: rel(t.name), mime: t.mime,
      width: t.width ?? p.width, height: t.height ?? p.height, fps: t.fps,
      sampleRate: t.sampleRate ?? p.sampleRate, channels: t.channels ?? p.channels,
      // Negative: audio captured just before the clock started (browser path, track-start.ts).
      startOffset: msToTicks(Math.max(-1000, t.startOffsetMs)), duration: msToTicks(p.durationMs),
    };
  }
  const screen = sources.screen;
  if (!screen) return null;
  const duration = log.endDurationMs !== null ? msToTicks(log.endDurationMs) : screen.startOffset + screen.duration;
  if (duration <= 0) return null;
  // Nothing may run past the end of the recording; a source that starts after it is dropped.
  for (const kind of KINDS) {
    const s = sources[kind];
    if (!s) continue;
    if (s.startOffset >= duration) delete sources[kind];
    else s.duration = Math.min(s.duration, duration - s.startOffset);
  }
  const cursorFile = log.cursor && input.files.includes(log.cursor) ? rel(log.cursor) : undefined;
  const target: CaptureInfo['target'] = log.meta?.target ?? { kind: 'display', label: input.fallbackLabel ?? '', bounds: { x: 0, y: 0, w: 0, h: 0 }, scaleFactor: 1 };
  const recording: Recording = {
    id: recordingId,
    createdAt: new Date(log.startedAtMs ?? Date.now()).toISOString(),
    duration,
    sources,
    cursorFile,
    capture: {
      backend: log.meta?.backend ?? 'native-macos', platform: input.platform, target,
      // The browser path bakes the cursor into the video; native helpers record it separately.
      cursorInFrames: log.meta?.backend === 'web', hasClicks: cursorFile !== undefined && (log.clicks ?? true),
      ...(log.meta?.crop ? { crop: log.meta.crop } : {}),
    },
    syncOffsets: {},
    markers: [...new Set(log.markers)].filter((m) => m <= duration).sort((a, b) => a - b),
  };
  return { recording, recoveredMs: ticksToMs(duration), cleanEnd: log.endDurationMs !== null };
}

// ─── Folders on disk ──────────────────────────────────────────────────────────

export interface RecoveryDeps {
  /** `--probe-files` of the native helper. */
  probe(dir: string): Promise<ProbedFile[]>;
  hasRecording(projectId: string, recordingId: string): Promise<boolean>;
  appendRecording(projectId: string, recording: Recording): Promise<unknown>;
  platform: string;
  fallbackLabel?: string;
  /** Whether the helper that wrote a log may still be running. */
  isAlive?(pid: number): boolean;
  /** A folder the app is recording into right now. */
  isBusy?(dir: string): boolean;
  now?(): number;
}

export type FolderResult =
  | { status: 'recovered'; projectId: string; recordingId: string; recoveredMs: number; cleanEnd: boolean; sources: SourceKind[] }
  | { status: 'empty'; projectId: string; recordingId: string }
  | { status: 'skipped'; projectId: string; recordingId: string; reason: 'no-log' | 'cancelled' | 'in-project' | 'active' | 'examined' };

/** A file this recent means a live helper may still be writing (fragments land every 2 s). */
const ACTIVE_WITHIN_MS = 15_000;

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function newestChange(dir: string, names: readonly string[]): Promise<number> {
  let newest = 0;
  for (const n of names) {
    try { newest = Math.max(newest, (await stat(join(dir, n))).mtimeMs); } catch { /* vanished */ }
  }
  return newest;
}

/**
 * Rebuilds one recording folder (`<project>/media/<recordingId>`) and adds it to its project.
 * A folder that has nothing playable is marked with recovery.json and left as it is.
 */
export async function recoverFolder(projectId: string, dir: string, recordingId: string, deps: RecoveryDeps): Promise<FolderResult> {
  const skipped = (reason: Extract<FolderResult, { status: 'skipped' }>['reason']): FolderResult => ({ status: 'skipped', projectId, recordingId, reason });
  if (deps.isBusy?.(dir)) return skipped('active');
  let text: string;
  try { text = await readFile(join(dir, SESSION_FILE), 'utf8'); } catch { return skipped('no-log'); }
  const log = parseSessionLog(text);
  if (!log) return skipped('no-log');
  if (log.cancelled) return skipped('cancelled');
  const files = await readdir(dir);
  if (files.includes(RECOVERY_FILE)) return skipped('examined');
  if (await deps.hasRecording(projectId, recordingId)) return skipped('in-project');
  if (log.endDurationMs === null && log.pid !== null && (deps.isAlive ?? pidAlive)(log.pid)
    && (deps.now?.() ?? Date.now()) - (await newestChange(dir, files)) < ACTIVE_WITHIN_MS) return skipped('active');

  const probed = await deps.probe(dir);
  const rebuilt = rebuildRecording({ recordingId, log, probed, files, platform: deps.platform, fallbackLabel: deps.fallbackLabel });
  if (!rebuilt) {
    await writeFileAtomic(join(dir, RECOVERY_FILE), JSON.stringify({ status: 'empty', at: new Date(deps.now?.() ?? Date.now()).toISOString(), probed }, null, 1));
    return { status: 'empty', projectId, recordingId };
  }
  await deps.appendRecording(projectId, rebuilt.recording);
  return {
    status: 'recovered', projectId, recordingId, recoveredMs: rebuilt.recoveredMs, cleanEnd: rebuilt.cleanEnd,
    sources: KINDS.filter((k) => rebuilt.recording.sources[k]),
  };
}

export interface ProjectEntry {
  id: string;
  dir: string;
  recordingIds: ReadonlySet<string>;
}

/**
 * Looks through every project's media folder for recordings that are on disk but not in the
 * project, and rebuilds them. A folder that fails (unreadable file, probe error) is left for
 * the next start; the others go on.
 */
export async function recoverAbandoned(projects: readonly ProjectEntry[], deps: RecoveryDeps, onError?: (dir: string, e: unknown) => void): Promise<FolderResult[]> {
  const results: FolderResult[] = [];
  for (const p of projects) {
    let entries;
    try { entries = await readdir(join(p.dir, 'media'), { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (!e.isDirectory() || !RECORDING_DIR.test(e.name) || p.recordingIds.has(e.name)) continue;
      const dir = join(p.dir, 'media', e.name);
      try {
        results.push(await recoverFolder(p.id, dir, e.name, deps));
      } catch (err) {
        onError?.(dir, err);
      }
    }
  }
  return results;
}
