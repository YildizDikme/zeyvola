/**
 * Time is stored as integer ticks. 1 s = 705 600 000 ticks, a number that divides
 * evenly by 24/25/30/48/50/60/90/100/120 fps, the NTSC x/1.001 variants and
 * 8k–192 kHz audio rates, so frame and sample boundaries never round.
 * JS numbers stay exact up to 2^53 ticks (~147 days).
 */
export type Ticks = number;

export const TICKS_PER_SECOND = 705_600_000;

export interface Rational {
  num: number;
  den: number;
}

export const FPS_30: Rational = { num: 30, den: 1 };
export const FPS_60: Rational = { num: 60, den: 1 };

export function secondsToTicks(seconds: number): Ticks {
  return Math.round(seconds * TICKS_PER_SECOND);
}

export function ticksToSeconds(t: Ticks): number {
  return t / TICKS_PER_SECOND;
}

export function msToTicks(ms: number): Ticks {
  return Math.round((ms * TICKS_PER_SECOND) / 1000);
}

export function ticksToMs(t: Ticks): number {
  return (t * 1000) / TICKS_PER_SECOND;
}

export function microsToTicks(us: number): Ticks {
  return Math.round((us * TICKS_PER_SECOND) / 1_000_000);
}

export function ticksToMicros(t: Ticks): number {
  return Math.round((t * 1_000_000) / TICKS_PER_SECOND);
}

/** Duration of one frame. Exact for every rate whose denominator divides the tick rate. */
export function frameDuration(fps: Rational): Ticks {
  return (TICKS_PER_SECOND * fps.den) / fps.num;
}

/** Start time of frame `n`. */
export function frameToTicks(n: number, fps: Rational): Ticks {
  return Math.round((n * TICKS_PER_SECOND * fps.den) / fps.num);
}

/** Index of the frame whose interval [start, start + duration) contains `t`. */
export function ticksToFrame(t: Ticks, fps: Rational): number {
  return Math.floor((t * fps.num) / (TICKS_PER_SECOND * fps.den) + 1e-9);
}

/** Snap `t` down to the start of its frame. */
export function snapToFrame(t: Ticks, fps: Rational): Ticks {
  return frameToTicks(ticksToFrame(t, fps), fps);
}

export function frameCount(duration: Ticks, fps: Rational): number {
  return Math.ceil((duration * fps.num) / (TICKS_PER_SECOND * fps.den) - 1e-9);
}

export function sampleToTicks(sample: number, sampleRate: number): Ticks {
  return Math.round((sample * TICKS_PER_SECOND) / sampleRate);
}

export function ticksToSample(t: Ticks, sampleRate: number): number {
  return Math.floor((t * sampleRate) / TICKS_PER_SECOND + 1e-9);
}

/** Half-open interval [start, end). */
export interface TimeRange {
  start: Ticks;
  end: Ticks;
}

export function rangeDuration(r: TimeRange): Ticks {
  return Math.max(0, r.end - r.start);
}

export function rangesOverlap(a: TimeRange, b: TimeRange): boolean {
  return a.start < b.end && b.start < a.end;
}

export function rangeContains(r: TimeRange, t: Ticks): boolean {
  return t >= r.start && t < r.end;
}

export function intersectRanges(a: TimeRange, b: TimeRange): TimeRange | null {
  const start = Math.max(a.start, b.start);
  const end = Math.min(a.end, b.end);
  return end > start ? { start, end } : null;
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** "mm:ss" or "h:mm:ss" with optional frame suffix ":ff". */
export function formatTimecode(t: Ticks, fps?: Rational): string {
  const negative = t < 0;
  const abs = Math.abs(t);
  const totalSeconds = Math.floor(abs / TICKS_PER_SECOND);
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  let out = h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
  if (fps) {
    const frac = abs - totalSeconds * TICKS_PER_SECOND;
    out += `:${pad(ticksToFrame(frac, fps))}`;
  }
  return negative ? `-${out}` : out;
}

/** Short human duration, e.g. "4 dk 12 sn". */
export function formatDuration(t: Ticks): string {
  const totalSeconds = Math.round(t / TICKS_PER_SECOND);
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  if (h > 0) return `${h} sa ${m} dk`;
  if (m > 0) return `${m} dk ${s} sn`;
  return `${s} sn`;
}
