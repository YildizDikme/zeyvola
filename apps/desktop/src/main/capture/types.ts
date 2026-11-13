import type { EventEmitter } from 'node:events';
import type { CaptureInfo, MediaSource, Rect, SourceKind } from '@zeyvola/project-model';
import type { BackendInfo, CaptureConfig } from '@zeyvola/protocol';
import type { ProbedFile } from './helper-client';

export interface BackendStartArgs {
  config: CaptureConfig;
  outDir: string;
  recordingId: string;
  /** Captured display area in global points (display bounds or display + region). */
  targetBounds: Rect;
  displayBounds: Rect;
  scaleFactor: number;
}

export interface BackendResult {
  sources: Partial<Record<SourceKind, MediaSource>>;
  /** Relative to the recording folder. */
  cursorFile?: string;
  durationTicks: number;
  capture: Omit<CaptureInfo, 'platform'>;
  markers: number[];
}

/**
 * The recorder process ended before it reported the recording. Its files and session log
 * are still on disk, so the recording can usually be rebuilt (recovery.ts).
 */
export class RecorderCrash extends Error {}

/**
 * A capture backend records each source into its own file and keeps a cursor/event log.
 * Events: 'level' (mic 0..1), 'status' ({ droppedFrames }), 'error' (Error),
 * 'crashed' (RecorderCrash, while recording or paused).
 */
export interface CaptureBackend extends EventEmitter {
  readonly info: BackendInfo;
  /**
   * Opens and warms up the devices without recording, so the first recorded frames are
   * already good. Runs during the countdown. Optional; start() prepares when needed.
   */
  prepare?(args: BackendStartArgs): Promise<void>;
  start(args: BackendStartArgs): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  /** Adds a marker at the current recording time. */
  mark(): void;
  /** Rejects with RecorderCrash when the recorder died before reporting the files. */
  stop(): Promise<BackendResult>;
  cancel(): Promise<void>;
  /** How much of each file in a recording folder can be played (crash recovery). */
  probe?(dir: string): Promise<ProbedFile[]>;
}
