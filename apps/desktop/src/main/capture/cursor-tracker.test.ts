import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { msToTicks } from '@zeyvola/timing';
import { BoundsTimeline, CursorTracker } from './cursor-tracker';
import { SessionClock } from './session-clock';

const A = { x: 100, y: 50, w: 800, h: 600 };
const B = { x: 200, y: 50, w: 800, h: 600 }; // A moved 100 pt to the right
const C = { x: 200, y: 50, w: 400, h: 300 }; // B resized to half

describe('recorded area over time', () => {
  it('keeps one fixed area for display and region recordings', () => {
    const area = new BoundsTimeline({ x: -1440, y: 0, w: 1440, h: 900 });
    expect(area.known).toBe(true);
    expect(area.normalize(-720, 450, 0)).toEqual({ x: 0.5, y: 0.5 });
    // On another display: outside 0..1, which the zoom engine ignores.
    expect(area.normalize(100, 450, 1e12)).toEqual({ x: (100 + 1440) / 1440, y: 0.5 });
  });

  it('knows nothing until the helper reports the window', () => {
    const area = new BoundsTimeline();
    expect(area.known).toBe(false);
    expect(area.at(1000)).toBeNull();
    expect(area.normalize(10, 10, 1000)).toBeNull();
    area.set({ x: 0, y: 0, w: 0, h: 600 }, 1000); // empty: ignored
    expect(area.known).toBe(false);
  });

  it('normalizes each point against the bounds in effect at its own time', () => {
    const area = new BoundsTimeline();
    area.set(A, 1000);
    area.set(B, 2000);
    area.set(C, 3000);
    expect(area.at(500)).toEqual(A); // before the first report: the first bounds
    expect(area.at(1999)).toEqual(A);
    expect(area.at(2000)).toEqual(B);
    expect(area.at(2999)).toEqual(B);
    expect(area.at(9999)).toEqual(C);
    // The same screen point lands at different places of the moving, resizing window.
    expect(area.normalize(500, 350, 1500)).toEqual({ x: 0.5, y: 0.5 });
    expect(area.normalize(500, 350, 2500)).toEqual({ x: 0.375, y: 0.5 });
    expect(area.normalize(500, 350, 3500)).toEqual({ x: 0.75, y: 1 });
  });

  it('ignores unchanged reports and treats a late one as happening now', () => {
    const area = new BoundsTimeline();
    area.set(A, 1000);
    area.set({ ...A }, 1500); // unchanged: the move to B below must not be shadowed
    area.set(B, 2000);
    area.set(C, 1800); // out of order: from 2000 on, not from 1800
    expect(area.at(1900)).toEqual(A);
    expect(area.at(2000)).toEqual(C);
  });

  it('forgets bounds that are long past but always keeps the latest before the window', () => {
    const area = new BoundsTimeline();
    area.set(A, 0);
    area.set(B, 1000);
    area.set(C, 1000 + BoundsTimeline.KEEP_MS + 5000);
    // A was dropped; B is the oldest kept and stands in for anything earlier.
    expect(area.at(0)).toEqual(B);
    expect(area.at(1000 + BoundsTimeline.KEEP_MS + 4999)).toEqual(B);
    expect(area.at(1000 + BoundsTimeline.KEEP_MS + 5000)).toEqual(C);
  });
});

describe('cursor log of a window recording', () => {
  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

  it('writes positions, clicks and scrolls relative to the window as it moves and resizes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zeyvola-cursor-'));
    dirs.push(dir);
    const file = join(dir, 'cursor.jsonl');
    const clock = new SessionClock();
    clock.start(10_000);
    const area = new BoundsTimeline();
    area.set(A, 9_000); // reported by the helper before recording started
    let now = 10_000;
    let pointer = { x: 500, y: 350 };
    // A very slow timer: the test takes the samples itself.
    const tracker = new CursorTracker(clock, area, { hz: 0.001, pointer: () => pointer, now: () => now });
    tracker.start(file);

    tracker.sample(); // window A, pointer in its middle
    area.set(B, 10_100); // the user drags the window, the pointer moves with it
    now = 10_150;
    pointer = { x: 600, y: 350 };
    tracker.sample(); // same place in the window: not written again
    now = 10_200;
    pointer = { x: 700, y: 350 };
    tracker.sample();
    // A click made before the move that arrives after it keeps the old bounds.
    tracker.writeInput({ e: 'd', b: 'l', atMs: 10_050, gx: 500, gy: 350 });
    area.set(C, 10_300); // the window is resized
    tracker.writeInput({ e: 'u', b: 'l', atMs: 10_350, gx: 300, gy: 125 });
    tracker.writeInput({ e: 's', dy: -2, atMs: 10_400, gx: 400, gy: 200 });
    tracker.writeMarker(clock.ticks(10_450));
    clock.pause(10_500);
    now = 10_600;
    pointer = { x: 210, y: 60 };
    tracker.sample(); // paused: nothing
    await tracker.stop();
    tracker.sample(); // stopped: nothing

    const lines = readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines).toEqual([
      { e: 'm', t: 0, x: 0.5, y: 0.5 },
      { e: 'm', t: msToTicks(200), x: 0.625, y: 0.5 },
      { e: 'd', t: msToTicks(50), x: 0.5, y: 0.5, b: 'l' },
      { e: 'u', t: msToTicks(350), x: 0.25, y: 0.25, b: 'l' },
      { e: 's', t: msToTicks(400), x: 0.5, y: 0.5, dy: -2 },
      { e: 'k', t: msToTicks(450), x: 0, y: 0 },
    ]);
  });

  it('writes nothing while the window bounds are unknown', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zeyvola-cursor-'));
    dirs.push(dir);
    const file = join(dir, 'cursor.jsonl');
    const clock = new SessionClock();
    clock.start(0);
    const tracker = new CursorTracker(clock, new BoundsTimeline(), { hz: 0.001, pointer: () => ({ x: 1, y: 1 }), now: () => 5 });
    tracker.start(file);
    tracker.sample();
    tracker.writeInput({ e: 'd', b: 'l', atMs: 5, gx: 1, gy: 1 });
    await tracker.stop();
    expect(readFileSync(file, 'utf8')).toBe('');
  });
});
