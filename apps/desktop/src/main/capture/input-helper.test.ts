import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { InputHelper, inputHelperArgs, parseInputLine, UptimeMap, windowIdOf, type PointerEvent, type WindowBoundsEvent } from './input-helper';

// Started through node, as helper-client.test.ts does: Windows cannot run a script by its shebang.
const FAKE = join(import.meta.dirname, '__fixtures__', 'fake-input.mjs');
const REAL = resolve(import.meta.dirname, '..', '..', '..', '..', '..', 'native', 'input-macos', 'bin', 'zeyvola-input');

describe('pointer helper protocol', () => {
  it('reads ready, button and scroll lines and ignores anything else', () => {
    expect(parseInputLine('{"type":"ready","now":12.5}')).toEqual({ type: 'ready', now: 12.5 });
    expect(parseInputLine('{"e":"d","b":"r","at":1,"now":1.1,"gx":5,"gy":6}')).toMatchObject({ e: 'd', b: 'r', at: 1, now: 1.1, gx: 5, gy: 6 });
    expect(parseInputLine('{"e":"s","dy":-2,"at":1,"now":1,"gx":0,"gy":0}')).toMatchObject({ e: 's', dy: -2 });
    expect(parseInputLine('{"e":"k","t":1}')).toBeNull();
    expect(parseInputLine('{"e":"d","at":"x","now":1,"gx":0,"gy":0}')).toBeNull();
    expect(parseInputLine('not json')).toBeNull();
  });

  it('reads window bounds lines and rejects empty or malformed ones', () => {
    expect(parseInputLine('{"type":"window","at":1,"now":1.1,"gx":-20,"gy":30,"w":800,"h":600}'))
      .toEqual({ type: 'window', at: 1, now: 1.1, gx: -20, gy: 30, w: 800, h: 600 });
    expect(parseInputLine('{"type":"window","at":1,"now":1,"gx":0,"gy":0,"w":0,"h":600}')).toBeNull();
    expect(parseInputLine('{"type":"window","at":1,"now":1,"gx":0,"gy":0,"w":800}')).toBeNull();
    expect(parseInputLine('{"type":"window","at":1,"now":1,"gx":"0","gy":0,"w":800,"h":600}')).toBeNull();
  });

  it('takes the native window id from a capture source id and passes it to the helper', () => {
    expect(windowIdOf('window:34769:0')).toBe(34769);
    expect(windowIdOf('window:197390:1')).toBe(197390);
    expect(windowIdOf('screen:1:0')).toBeNull();
    expect(windowIdOf('window:0:0')).toBeNull();
    expect(windowIdOf('window:abc:0')).toBeNull();
    expect(windowIdOf('window:99999999999999999999:0')).toBeNull();
    expect(inputHelperArgs(null, 'darwin')).toEqual([]);
    expect(inputHelperArgs(34769, 'darwin')).toEqual(['--window', '34769']);
    expect(inputHelperArgs(null, 'win32')).toEqual(['--input']);
    expect(inputHelperArgs(197390, 'win32')).toEqual(['--input', '--window', '197390']);
  });

  it('maps the Mac uptime clock to epoch time with the smallest observed pipe delay', () => {
    const m = new UptimeMap();
    expect(m.known).toBe(false);
    m.observe(100, 1_000_000 + 100_000 + 8); // arrived 8 ms after writing
    m.observe(101, 1_000_000 + 101_000 + 2); // 2 ms: better estimate
    m.observe(102, 1_000_000 + 102_000 + 30);
    expect(m.known).toBe(true);
    expect(m.toEpochMs(100.25)).toBe(1_000_000 + 100_250 + 2);
  });
});

describe('pointer helper process', () => {
  it('starts, turns events into epoch-timed clicks and scrolls, and stops', async () => {
    // The lines were written at uptime 1000.6 s and arrive at epoch 2_000_005 ms.
    let clockMs = 0;
    const helper = new InputHelper(process.execPath, () => clockMs, [FAKE]);
    const events: PointerEvent[] = [];
    helper.on('event', (e: PointerEvent) => events.push(e));
    clockMs = 2_000_000 + 5; // the first chunk (ready + events) arrives together
    expect(await helper.start(5000)).toBe(true);
    await new Promise((r) => setTimeout(r, 200));
    await helper.stop();
    expect(events.map((e) => e.e)).toEqual(['d', 'u', 's']);
    // The click happened 350 ms before it was written: 2_000_005 − 350.
    expect(events[0]!.atMs).toBeCloseTo(1_999_655, 6);
    expect(events[1]!.atMs - events[0]!.atMs).toBeCloseTo(60, 6);
    expect(events[0]).toMatchObject({ e: 'd', b: 'l', gx: 300, gy: 200 });
    expect(events[2]).toMatchObject({ e: 's', dy: -3, gx: 310, gy: 210 });
  });

  it('reports the window bounds on the same epoch clock, known as soon as the helper is ready', async () => {
    let clockMs = 0;
    const helper = new InputHelper(process.execPath, () => clockMs, [FAKE, '--window', '42']);
    const windows: WindowBoundsEvent[] = [];
    helper.on('window', (w: WindowBoundsEvent) => windows.push(w));
    clockMs = 2_000_000 + 5;
    expect(await helper.start(5000)).toBe(true);
    expect(windows.length).toBeGreaterThanOrEqual(1);
    await new Promise((r) => setTimeout(r, 200));
    await helper.stop();
    expect(windows.map((w) => w.bounds)).toEqual([{ x: 100, y: 50, w: 800, h: 600 }, { x: 150, y: 50, w: 800, h: 600 }]);
    // Written at uptime 1000.6 s, arrived at 2_000_005 ms: 1000.1 s → 500 ms earlier.
    expect(windows[0]!.atMs).toBeCloseTo(1_999_505, 6);
    expect(windows[1]!.atMs).toBeCloseTo(1_999_805, 6);
  });

  it('reports false when the helper cannot be started, so recording continues without clicks', async () => {
    const helper = new InputHelper('/nonexistent/zeyvola-input', undefined, []);
    expect(await helper.start(2000)).toBe(false);
    await helper.stop();
  });
});

describe.skipIf(process.platform !== 'darwin' || !existsSync(REAL))('macOS pointer helper binary', () => {
  it('listens for mouse events and exits cleanly when asked to stop', async () => {
    const helper = new InputHelper(REAL, undefined, []);
    expect(await helper.start(5000)).toBe(true);
    const t0 = Date.now();
    await helper.stop();
    expect(Date.now() - t0).toBeLessThan(1500);
  });

  it('accepts a window to follow and stays quiet about a window that does not exist', async () => {
    const helper = new InputHelper(REAL, undefined, ['--window', '4294967294']);
    const windows: WindowBoundsEvent[] = [];
    helper.on('window', (w: WindowBoundsEvent) => windows.push(w));
    expect(await helper.start(5000)).toBe(true);
    await new Promise((r) => setTimeout(r, 150));
    await helper.stop();
    expect(windows).toEqual([]);
  });
});
