import { createWriteStream, type WriteStream } from 'node:fs';
import { screen } from 'electron';
import type { Rect } from '@zeyvola/project-model';
import { nowMs, type SessionClock } from './session-clock';

/**
 * The recorded area in Electron's screen coordinates over time. Display and region recordings
 * have one fixed area; a window recording follows the window, whose bounds the pointer helper
 * reports as it moves or resizes. Each position is normalized against the bounds that were in
 * effect at its own time, so a click that arrives after the window has moved still lands where
 * it was made.
 */
export class BoundsTimeline {
  private items: { atMs: number; rect: Rect }[] = [];

  /** Bounds older than this (behind the newest change) are dropped; events arrive within milliseconds. */
  static readonly KEEP_MS = 5000;

  constructor(fixed?: Rect) {
    if (fixed) this.items.push({ atMs: Number.NEGATIVE_INFINITY, rect: fixed });
  }

  get known(): boolean {
    return this.items.length > 0;
  }

  /** New bounds from atMs (epoch ms) on. Empty or unchanged bounds are ignored. */
  set(rect: Rect, atMs: number): void {
    if (!(rect.w > 0 && rect.h > 0)) return;
    const last = this.items[this.items.length - 1];
    if (last && last.rect.x === rect.x && last.rect.y === rect.y && last.rect.w === rect.w && last.rect.h === rect.h) return;
    // Reports come in time order; one that does not is taken as happening now.
    this.items.push({ atMs: last ? Math.max(atMs, last.atMs) : atMs, rect: { ...rect } });
    const cutoff = atMs - BoundsTimeline.KEEP_MS;
    let drop = 0;
    while (drop + 1 < this.items.length && this.items[drop + 1]!.atMs <= cutoff) drop++;
    if (drop) this.items.splice(0, drop);
  }

  /** The bounds in effect at atMs; before the first report, the first known bounds. */
  at(atMs: number): Rect | null {
    for (let i = this.items.length - 1; i >= 0; i--) if (this.items[i]!.atMs <= atMs) return this.items[i]!.rect;
    return this.items[0]?.rect ?? null;
  }

  /**
   * A global point as 0..1 of the area at atMs (top-left origin). Outside the area the values
   * leave 0..1, as in the native recorder's log; the zoom engine ignores such points.
   */
  normalize(gx: number, gy: number, atMs: number): { x: number; y: number } | null {
    const b = this.at(atMs);
    if (!b) return null;
    return { x: (gx - b.x) / Math.max(1, b.w), y: (gy - b.y) / Math.max(1, b.h) };
  }
}

export interface CursorTrackerOptions {
  hz?: number;
  /** Pointer position in Electron screen coordinates; tests replace it. */
  pointer?: () => { x: number; y: number };
  /** Epoch milliseconds, the recording clock's base; tests replace it. */
  now?: () => number;
}

/**
 * Pointer sampler for backends without native input monitoring. Uses Electron's
 * cursor position; clicks and scrolls come from the pointer helper when it runs
 * (input-helper.ts, writeInput). Writes the same JSONL format as the native helpers:
 * {"e":"m","t":<ticks>,"x":<0..1>,"y":<0..1>}, {"e":"d"|"u",…,"b":"l"|"r"|"o"}, {"e":"s",…,"dy"}.
 */
export class CursorTracker {
  private timer: NodeJS.Timeout | null = null;
  private out: WriteStream | null = null;
  private lastX = Number.NaN;
  private lastY = Number.NaN;
  private lastWrite = 0;
  private readonly hz: number;
  private readonly pointer: () => { x: number; y: number };
  private readonly now: () => number;

  constructor(private readonly clock: SessionClock, private readonly area: BoundsTimeline, opts: CursorTrackerOptions = {}) {
    this.hz = opts.hz ?? 60;
    this.pointer = opts.pointer ?? (() => screen.getCursorScreenPoint());
    this.now = opts.now ?? nowMs;
  }

  start(file: string): void {
    this.out = createWriteStream(file, { flags: 'w' });
    this.timer = setInterval(() => this.sample(), 1000 / this.hz);
  }

  /** Writes the pointer position now (called by the timer). */
  sample(): void {
    if (!this.out || this.clock.paused) return;
    const at = this.now();
    const p = this.pointer();
    const n = this.area.normalize(p.x, p.y, at);
    if (!n) return;
    const t = this.clock.ticks(at);
    // Skip identical samples but keep a 2 Hz heartbeat so idle periods stay explicit.
    if (n.x === this.lastX && n.y === this.lastY && t - this.lastWrite < 352_800_000) return;
    this.lastX = n.x;
    this.lastY = n.y;
    this.lastWrite = t;
    this.out.write(`{"e":"m","t":${t},"x":${n.x.toFixed(5)},"y":${n.y.toFixed(5)}}\n`);
  }

  /** A click or scroll from the pointer helper, timed in epoch ms, at a point in Electron screen coordinates. */
  writeInput(ev: { e: 'd' | 'u' | 's'; b?: string; dy?: number; atMs: number; gx: number; gy: number }): void {
    if (!this.out) return;
    const n = this.area.normalize(ev.gx, ev.gy, ev.atMs);
    if (!n) return;
    const t = this.clock.ticks(ev.atMs);
    const x = n.x.toFixed(5);
    const y = n.y.toFixed(5);
    if (ev.e === 's') this.out.write(`{"e":"s","t":${t},"x":${x},"y":${y},"dy":${(ev.dy ?? 0).toFixed(3)}}\n`);
    else this.out.write(`{"e":"${ev.e}","t":${t},"x":${x},"y":${y},"b":"${ev.b ?? 'l'}"}\n`);
  }

  writeMarker(t: number): void {
    this.out?.write(`{"e":"k","t":${t},"x":0,"y":0}\n`);
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    const out = this.out;
    this.out = null;
    if (out) await new Promise<void>((res) => out.end(res));
  }
}
