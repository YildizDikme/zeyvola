import { msToTicks, type Ticks } from '@zeyvola/timing';

/** Wall-clock epoch milliseconds with sub-millisecond resolution (same base in every process). */
export function nowMs(): number {
  return performance.timeOrigin + performance.now();
}

/**
 * Recording clock: time since start with paused intervals removed. All sources and the
 * cursor log are stamped with this clock so they line up in the editor.
 */
export class SessionClock {
  private t0 = 0;
  private pausedTotal = 0;
  private pausedAt: number | null = null;

  start(at = nowMs()): void {
    this.t0 = at;
    this.pausedTotal = 0;
    this.pausedAt = null;
  }

  get startedAt(): number {
    return this.t0;
  }

  pause(at = nowMs()): void {
    if (this.pausedAt === null) this.pausedAt = at;
  }

  resume(at = nowMs()): void {
    if (this.pausedAt !== null) {
      this.pausedTotal += at - this.pausedAt;
      this.pausedAt = null;
    }
  }

  get paused(): boolean {
    return this.pausedAt !== null;
  }

  /** Recording time in ms for an epoch timestamp. */
  elapsedMs(at = nowMs()): number {
    const end = this.pausedAt ?? at;
    return Math.max(0, end - this.t0 - this.pausedTotal);
  }

  ticks(at = nowMs()): Ticks {
    return msToTicks(this.elapsedMs(at));
  }
}
