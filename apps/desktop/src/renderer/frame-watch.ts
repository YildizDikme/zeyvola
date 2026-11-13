import { firstRecordedFrameMs, type FrameSeen } from '../shared/track-start';

type Frame = VideoFrame | AudioData;
type Processor = new (init: { track: MediaStreamTrack }) => { readable: ReadableStream<Frame> };

const BEFORE = 30; // frames kept from before start(), for the arrival delay
const AFTER = 12; // frames after start() that settle the estimate
const AFTER_MS = 2000; // or this long after start(), whichever comes first

/**
 * Watches a copy of a recorded track around the recorder's start, so the file's first frame can be
 * placed on the recording clock (shared/track-start.ts). Frames are closed as soon as they are
 * read; the copy stops once the start is settled.
 */
export class FrameWatch {
  private frames: FrameSeen[] = [];
  private callAt: number | null = null;
  private reader: ReadableStreamDefaultReader<Frame> | null = null;
  private copy: MediaStreamTrack | null = null;

  constructor(track: MediaStreamTrack) {
    // Chromium offers MediaStreamTrackProcessor in pages; without it the start() call time is used.
    const P = (globalThis as { MediaStreamTrackProcessor?: Processor }).MediaStreamTrackProcessor;
    if (!P) return;
    try {
      this.copy = track.clone();
      this.reader = new P({ track: this.copy }).readable.getReader();
      void this.read();
    } catch {
      this.close();
    }
  }

  private async read(): Promise<void> {
    let after = 0;
    while (this.reader) {
      const r = await this.reader.read().catch(() => null);
      if (!r || r.done) break;
      const at = performance.timeOrigin + performance.now();
      this.frames.push({ ts: r.value.timestamp, at });
      r.value.close();
      if (this.callAt === null) {
        if (this.frames.length > BEFORE) this.frames.shift();
      } else if (at >= this.callAt && (++after >= AFTER || at - this.callAt >= AFTER_MS)) break;
    }
    this.close();
  }

  /** The recorder was started now (epoch ms, the moment just before `start()`). */
  started(at: number): void {
    this.callAt = at;
  }

  /** Epoch ms of the recorder's first frame (see track-start.ts); the start() call until known. */
  firstFrameMs(): number | null {
    if (this.callAt === null) return null;
    return firstRecordedFrameMs(this.frames, this.callAt, performance.timeOrigin) ?? this.callAt;
  }

  close(): void {
    const reader = this.reader;
    this.reader = null;
    void reader?.cancel().catch(() => undefined);
    this.copy?.stop();
    this.copy = null;
  }
}
