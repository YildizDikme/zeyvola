import { TICKS_PER_SECOND, type Ticks } from '@zeyvola/timing';
import type { Vec2 } from './geometry';
import type { ClickEvent, CursorTrack } from './types';

const GRID_HZ = 120;
const GRID_DT = TICKS_PER_SECOND / GRID_HZ;

/**
 * Cursor log resampled onto a uniform 120 Hz grid, plus a zero-phase smoothed copy
 * (forward then backward exponential filter). Because we work after recording,
 * smoothing adds no lag.
 */
export interface PreparedCursor {
  readonly start: Ticks;
  readonly end: Ticks;
  rawAt(t: Ticks): Vec2 | null;
  smoothAt(t: Ticks): Vec2 | null;
  /** Time of the last movement (> 0.2 % of the frame) at or before t. */
  lastMoveAt(t: Ticks): Ticks | null;
  /** Most recent button-down at or before t. */
  lastClickBefore(t: Ticks): ClickEvent | null;
  readonly clicks: ClickEvent[];
  readonly hasSamples: boolean;
}

export function prepareCursor(track: CursorTrack, tauSeconds = 0.18): PreparedCursor {
  const samples = [...track.samples].sort((a, b) => a.t - b.t);
  const clicks = track.clicks.filter((c) => c.kind === 'down').sort((a, b) => a.t - b.t);
  if (samples.length === 0) {
    return {
      start: 0, end: 0, hasSamples: false, clicks,
      rawAt: () => null, smoothAt: () => null, lastMoveAt: () => null,
      lastClickBefore: (t) => lastBefore(clicks, t),
    };
  }
  const start = samples[0]!.t;
  const end = samples[samples.length - 1]!.t;
  const n = Math.max(1, Math.floor((end - start) / GRID_DT) + 1);
  const rx = new Float64Array(n);
  const ry = new Float64Array(n);
  let j = 0;
  for (let i = 0; i < n; i++) {
    const t = start + i * GRID_DT;
    while (j < samples.length - 2 && samples[j + 1]!.t <= t) j++;
    const a = samples[j]!;
    const b = samples[Math.min(j + 1, samples.length - 1)]!;
    const span = b.t - a.t;
    const u = span > 0 ? Math.min(1, Math.max(0, (t - a.t) / span)) : 0;
    rx[i] = a.x + (b.x - a.x) * u;
    ry[i] = a.y + (b.y - a.y) * u;
  }

  const alpha = 1 - Math.exp(-1 / (GRID_HZ * Math.max(1e-3, tauSeconds)));
  const sx = Float64Array.from(rx);
  const sy = Float64Array.from(ry);
  for (let i = 1; i < n; i++) {
    sx[i] = sx[i - 1]! + alpha * (sx[i]! - sx[i - 1]!);
    sy[i] = sy[i - 1]! + alpha * (sy[i]! - sy[i - 1]!);
  }
  for (let i = n - 2; i >= 0; i--) {
    sx[i] = sx[i + 1]! + alpha * (sx[i]! - sx[i + 1]!);
    sy[i] = sy[i + 1]! + alpha * (sy[i]! - sy[i + 1]!);
  }

  // Last-movement index for idle detection.
  const moved = new Int32Array(n);
  const EPS = 0.002;
  let last = 0;
  for (let i = 0; i < n; i++) {
    if (i > 0 && (Math.abs(rx[i]! - rx[last]!) > EPS || Math.abs(ry[i]! - ry[last]!) > EPS)) last = i;
    moved[i] = last;
  }

  const sampleGrid = (xs: Float64Array, ys: Float64Array, t: Ticks): Vec2 => {
    const f = Math.min(n - 1, Math.max(0, (t - start) / GRID_DT));
    const i0 = Math.floor(f);
    const i1 = Math.min(n - 1, i0 + 1);
    const u = f - i0;
    return { x: xs[i0]! + (xs[i1]! - xs[i0]!) * u, y: ys[i0]! + (ys[i1]! - ys[i0]!) * u };
  };

  return {
    start, end, hasSamples: true, clicks,
    rawAt: (t) => sampleGrid(rx, ry, t),
    smoothAt: (t) => sampleGrid(sx, sy, t),
    lastMoveAt: (t) => {
      const i = Math.min(n - 1, Math.max(0, Math.floor((t - start) / GRID_DT)));
      return start + moved[i]! * GRID_DT;
    },
    lastClickBefore: (t) => lastBefore(clicks, t),
  };
}

function lastBefore(clicks: ClickEvent[], t: Ticks): ClickEvent | null {
  let lo = 0;
  let hi = clicks.length - 1;
  let found: ClickEvent | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (clicks[mid]!.t <= t) {
      found = clicks[mid]!;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found;
}

/** Parses the newline-delimited cursor log written by the capture backends. */
export function parseCursorLog(text: string): CursorTrack {
  const track: CursorTrack = { samples: [], clicks: [], scrolls: [] };
  for (const line of text.split('\n')) {
    if (!line) continue;
    let o: Record<string, unknown>;
    try { o = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
    const t = Number(o.t);
    const x = Number(o.x);
    const y = Number(o.y);
    if (!Number.isFinite(t) || !Number.isFinite(x) || !Number.isFinite(y)) continue;
    switch (o.e) {
      case 'm':
        track.samples.push({ t, x, y });
        break;
      case 'd':
      case 'u':
        track.clicks.push({ t, x, y, kind: o.e === 'd' ? 'down' : 'up', button: o.b === 'r' ? 'right' : o.b === 'o' ? 'other' : 'left' });
        break;
      case 's':
        track.scrolls.push({ t, x, y, dy: Number(o.dy) || 0 });
        break;
    }
  }
  return track;
}
