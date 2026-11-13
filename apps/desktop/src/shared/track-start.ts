/**
 * Where a browser-recorded file starts on the recording clock.
 *
 * MediaRecorder's file time 0 is the first frame (video) or audio buffer it receives after
 * `start()`; later frames are placed by their own timestamps. Its "start" event comes only when
 * the first frame has been encoded, which for a large screen is well over 100 ms later, so it is
 * not used. Instead the capture window watches a copy of each track around `start()` and notes,
 * for every frame, its timestamp and when the page received it (measured: tests/real-capture-web).
 *
 * - Audio frames carry their capture time on the page's own clock (performance.now), i.e. already
 *   without the input latency: the file starts at that time, which is before `start()`.
 * - Video frames carry a timestamp on another clock. The delay between it and the page receiving
 *   the frame is constant apart from the page's own scheduling, so the smallest delay seen turns
 *   each timestamp into the moment the frame reached the browser. The recorder's first frame is the
 *   first one to arrive after `start()`; with a still screen that can be much later.
 */

export interface FrameSeen {
  /** The frame's own timestamp (VideoFrame / AudioData `timestamp`), microseconds. */
  ts: number;
  /** When the page received it: epoch milliseconds (performance.timeOrigin + performance.now()). */
  at: number;
}

/** Frame timestamps this close behind the page's clock are taken to be on it (ms). */
const PAGE_CLOCK_LAG_MAX = 2000;

/**
 * Epoch ms of the first frame a recorder started at `callAt` records, or null when no frame
 * arrived after the call. `timeOrigin` is the page's performance.timeOrigin.
 */
export function firstRecordedFrameMs(frames: readonly FrameSeen[], callAt: number, timeOrigin: number): number | null {
  if (!frames.length) return null;
  const lags = frames.map((f) => f.at - (timeOrigin + f.ts / 1000));
  const pageClock = lags.every((l) => l >= -1 && l <= PAGE_CLOCK_LAG_MAX);
  // Arrival = timestamp + the smallest delay seen (the page reads some frames late, never early).
  const delay = Math.min(...lags);
  const arrival = (f: FrameSeen) => timeOrigin + f.ts / 1000 + delay;
  const first = frames.find((f) => arrival(f) >= callAt);
  if (!first) return null;
  return pageClock ? timeOrigin + first.ts / 1000 : arrival(first);
}

/**
 * A file's place on the recording clock: its start (may be negative: audio captured just before
 * the clock started) and its length up to the end of the recording.
 */
export function trackSpan(firstFrameMs: number | null, clockStartMs: number, recordingMs: number): { startOffsetMs: number; durationMs: number } {
  const startOffsetMs = firstFrameMs !== null && Number.isFinite(firstFrameMs) ? firstFrameMs - clockStartMs : 0;
  return { startOffsetMs, durationMs: Math.max(0, recordingMs - startOffsetMs) };
}
