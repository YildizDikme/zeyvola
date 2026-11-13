import { describe, expect, it } from 'vitest';
import {
  TICKS_PER_SECOND, frameDuration, frameToTicks, ticksToFrame, snapToFrame, frameCount,
  sampleToTicks, ticksToSample, formatTimecode, intersectRanges, secondsToTicks,
} from './index';

describe('tick rate', () => {
  it('divides common frame rates exactly', () => {
    for (const fps of [24, 25, 30, 48, 50, 60, 90, 100, 120]) {
      expect(Number.isInteger(TICKS_PER_SECOND / fps)).toBe(true);
    }
    for (const num of [24000, 30000, 60000]) {
      expect(Number.isInteger((TICKS_PER_SECOND * 1001) / num)).toBe(true);
    }
  });

  it('divides common sample rates exactly', () => {
    for (const sr of [8000, 16000, 22050, 32000, 44100, 48000, 88200, 96000, 192000]) {
      expect(Number.isInteger(TICKS_PER_SECOND / sr)).toBe(true);
    }
  });
});

describe('frame math', () => {
  const fps60 = { num: 60, den: 1 };
  const ntsc = { num: 30000, den: 1001 };

  it('round-trips frame indices', () => {
    for (const fps of [fps60, ntsc]) {
      for (let n = 0; n < 5000; n += 37) {
        expect(ticksToFrame(frameToTicks(n, fps), fps)).toBe(n);
        expect(ticksToFrame(frameToTicks(n, fps) + frameDuration(fps) - 1, fps)).toBe(n);
      }
    }
  });

  it('accumulates no drift over two hours at NTSC rate', () => {
    const n = 2 * 3600 * 30;
    expect(frameToTicks(n, ntsc)).toBe((n * TICKS_PER_SECOND * 1001) / 30000);
  });

  it('snaps and counts', () => {
    expect(snapToFrame(frameToTicks(10, fps60) + 5, fps60)).toBe(frameToTicks(10, fps60));
    expect(frameCount(secondsToTicks(1), fps60)).toBe(60);
    expect(frameCount(secondsToTicks(1) + 1, fps60)).toBe(61);
  });

  it('converts samples', () => {
    expect(sampleToTicks(48000, 48000)).toBe(TICKS_PER_SECOND);
    expect(ticksToSample(TICKS_PER_SECOND, 44100)).toBe(44100);
  });
});

describe('ranges and formatting', () => {
  it('intersects half-open ranges', () => {
    expect(intersectRanges({ start: 0, end: 10 }, { start: 10, end: 20 })).toBeNull();
    expect(intersectRanges({ start: 0, end: 10 }, { start: 5, end: 20 })).toEqual({ start: 5, end: 10 });
  });

  it('formats timecodes', () => {
    expect(formatTimecode(secondsToTicks(72))).toBe('01:12');
    expect(formatTimecode(secondsToTicks(3723))).toBe('1:02:03');
    expect(formatTimecode(secondsToTicks(1.5), { num: 30, den: 1 })).toBe('00:01:15');
  });
});
