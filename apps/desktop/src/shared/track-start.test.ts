import { describe, expect, it } from 'vitest';
import { firstRecordedFrameMs, trackSpan, type FrameSeen } from './track-start';

const ORIGIN = 1_792_274_600_000; // performance.timeOrigin of the capture window (epoch ms)
const CALL = ORIGIN + 3_000; // recorder.start(), 3 s after the window opened

/** Frames every `every` ms; `ts(t)` gives a frame's own timestamp (µs) for its arrival time t (epoch ms). */
function frames(from: number, to: number, every: number, ts: (t: number) => number, readLate: (i: number) => number = () => 0): FrameSeen[] {
  const out: FrameSeen[] = [];
  for (let t = from, i = 0; t <= to; t += every, i++) out.push({ ts: ts(t), at: t + readLate(i) });
  return out;
}

describe('first recorded frame', () => {
  // Measured (2026-10-18, Electron 44): microphone AudioData carry their capture time on the page's
  // clock, 33.5 ms before the page receives them; each recorder starts with the first buffer after start().
  it('audio: the capture time of the first buffer after start(), before the call', () => {
    const lag = 33.5;
    const f = frames(CALL - 40, CALL + 60, 2.67, (t) => (t - lag - ORIGIN) * 1000);
    const first = f.find((x) => x.at >= CALL)!;
    expect(firstRecordedFrameMs(f, CALL, ORIGIN)).toBeCloseTo(first.at - lag, 6);
    expect(firstRecordedFrameMs(f, CALL, ORIGIN)! - CALL).toBeLessThan(-30);
  });

  // Measured: video frames (screen, camera) carry a timestamp on another clock (time since boot).
  it('video: the arrival of the first frame after start(), on the page clock', () => {
    const BOOT = 221_822_505.5; // ms between that clock and the page's
    const f = frames(CALL - 200, CALL + 200, 16.7, (t) => (t - ORIGIN + BOOT) * 1000);
    const first = f.find((x) => x.at >= CALL)!;
    expect(firstRecordedFrameMs(f, CALL, ORIGIN)).toBeCloseTo(first.at, 6);
  });

  it('video: a frame that arrived before start() but was read after it is not the first', () => {
    const BOOT = 221_822_505.5;
    // The page was busy around start(): the frame that arrived 2 ms before the call is read 6 ms late.
    const arrivals = [CALL - 35.4, CALL - 18.7, CALL - 2, CALL + 14.7, CALL + 31.4, CALL + 48.1];
    const f: FrameSeen[] = arrivals.map((t, i) => ({ ts: (t - ORIGIN + BOOT) * 1000, at: t + (i === 2 ? 6 : 0.3) }));
    expect(firstRecordedFrameMs(f, CALL, ORIGIN)).toBeCloseTo(CALL + 14.7 + 0.3, 6);
  });

  it('a still screen: the first frame may come long after start()', () => {
    const f: FrameSeen[] = [{ ts: 5e9, at: CALL - 900 }, { ts: 5e9 + 2_400_000, at: CALL + 1500 }];
    expect(firstRecordedFrameMs(f, CALL, ORIGIN)).toBeCloseTo(CALL + 1500, 6);
  });

  it('nothing seen, or nothing after start()', () => {
    expect(firstRecordedFrameMs([], CALL, ORIGIN)).toBeNull();
    expect(firstRecordedFrameMs([{ ts: 5e9, at: CALL - 10 }], CALL, ORIGIN)).toBeNull();
  });
});

describe('track span on the recording clock', () => {
  it('starts where the first frame was, may start before the clock, and ends with the recording', () => {
    expect(trackSpan(CALL + 1.5, CALL, 52_000)).toEqual({ startOffsetMs: 1.5, durationMs: 51_998.5 });
    expect(trackSpan(CALL - 32.5, CALL, 52_000)).toEqual({ startOffsetMs: -32.5, durationMs: 52_032.5 });
    expect(trackSpan(null, CALL, 52_000)).toEqual({ startOffsetMs: 0, durationMs: 52_000 });
    expect(trackSpan(CALL + 60_000, CALL, 52_000).durationMs).toBe(0);
  });
});
