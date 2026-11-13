import { describe, expect, it } from 'vitest';
import { secondsToTicks as sec } from '@zeyvola/timing';
import {
  MAGNIFIER_LIMITS, addMagnifier, addRecording, addZoom, createProject, evaluate, laneRange, magnifierSampling, parseProject,
  placeItem, prepareCursor, presetTransition, removeMagnifier, removeSegment, resolveOverlaps, serializeProject, setStyle,
  sourceToCanvas, splitAt, updateMagnifier, type CursorSample, type DeepPartial, type MagnifierStyle, type NewMagnifier,
  type PreparedCursor, type Project, type Recording,
} from './index';

function rec(opts: Partial<Recording['capture']> = {}): Recording {
  return {
    id: 'r1', createdAt: '2026-10-18T00:00:00Z', duration: sec(10),
    sources: { screen: { kind: 'screen', file: 'media/s.mp4', mime: 'video/mp4', width: 2880, height: 1800, fps: 60, startOffset: 0, duration: sec(10) } },
    cursorFile: 'media/cursor.jsonl',
    capture: { backend: 'native-macos', platform: 'test', target: { kind: 'display', label: 'Ekran', bounds: { x: 0, y: 0, w: 1440, h: 900 }, scaleFactor: 2 }, cursorInFrames: false, hasClicks: true, ...opts },
    syncOffsets: {}, markers: [],
  };
}

const range = (start: number, end: number, size = 280, zoom = 2): NewMagnifier => ({ recordingId: 'r1', start: sec(start), end: sec(end), origin: 'manual', size, zoom });

/** A recording with one magnifier range (default: 1 s – 9 s). */
function project(item: Partial<NewMagnifier> = {}, look: DeepPartial<MagnifierStyle> = {}, capture: Partial<Recording['capture']> = {}): Project {
  const p = setStyle(addRecording(createProject('Büyüteç'), rec(capture)), { magnifier: look });
  return addMagnifier(p, { ...range(1, 9), ...item }).project;
}

/** Pointer resting at `at` for the whole recording. */
function still(at: { x: number; y: number }): PreparedCursor {
  const samples: CursorSample[] = [];
  for (let s = 0; s <= 10; s += 0.05) samples.push({ t: sec(s), ...at });
  return prepareCursor({ samples, clicks: [], scrolls: [] });
}

const near = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) < eps;
const lensAt = (p: Project, t: number, at = { x: 0.5, y: 0.5 }) => evaluate(p, sec(t), { cursors: { r1: still(at) } }).magnifier;

describe('magnifier ranges', () => {
  it('shows nothing without a range, also in projects saved before ranges existed', () => {
    const p = addRecording(createProject('Eski'), rec());
    expect(p.magnifiers).toEqual([]);
    expect(lensAt(p, 2)).toBeNull();
    const json = JSON.parse(serializeProject(p)) as Record<string, unknown> & { style: Record<string, unknown> };
    delete json.magnifiers;
    delete json.style.magnifier;
    const reopened = parseProject(json);
    expect(reopened.magnifiers).toEqual([]);
    expect(reopened.style.magnifier).toEqual(createProject('x').style.magnifier);
  });

  it('appears only inside its range, fading and growing in at the start and out at the end', () => {
    const p = project({ start: sec(2), end: sec(6), size: 300 });
    expect(lensAt(p, 1.9)).toBeNull();
    expect(lensAt(p, 6)).toBeNull();
    expect(lensAt(p, 7)).toBeNull();
    const entering = lensAt(p, 2.08)!;
    const middle = lensAt(p, 4)!;
    const leaving = lensAt(p, 5.95)!;
    expect(middle.opacity).toBe(1);
    expect(middle.rect.w).toBe(300);
    expect(entering.opacity).toBeGreaterThan(0);
    expect(entering.opacity).toBeLessThan(1);
    expect(entering.rect.w).toBeLessThan(300);
    expect(leaving.opacity).toBeLessThan(1);
  });

  it('uses each range’s own size and zoom', () => {
    let p = project({ start: sec(1), end: sec(3), size: 200, zoom: 1.5 });
    p = addMagnifier(p, range(5, 8, 480, 3.5)).project;
    expect(lensAt(p, 2)!.rect.w).toBe(200);
    expect(lensAt(p, 2)!.zoom).toBe(1.5);
    expect(lensAt(p, 4)).toBeNull();
    expect(lensAt(p, 6.5)!.rect.w).toBe(480);
    expect(lensAt(p, 6.5)!.zoom).toBe(3.5);
  });

  it('follows the pointer: the lens is centered on where the pointer is drawn', () => {
    const p = project({ size: 300, zoom: 2 });
    const plan = evaluate(p, sec(4), { cursors: { r1: still({ x: 0.4, y: 0.55 }) } });
    const m = plan.magnifier!;
    const at = sourceToCanvas(plan, { x: 0.4, y: 0.55 })!;
    expect(near(m.focus.x, at.x) && near(m.focus.y, at.y)).toBe(true);
    expect(near(m.rect.x + m.rect.w / 2, at.x) && near(m.rect.y + m.rect.h / 2, at.y)).toBe(true);
    expect(m.radius).toBe(150);
    expect(m.zoom).toBe(2);
  });

  it('applies the shared look and scales with the output size', () => {
    const p = project({ size: 400 }, { shape: 'rounded', border: { width: 5, color: '#FF0000' } });
    const m = evaluate(p, sec(4), { cursors: { r1: still({ x: 0.5, y: 0.5 }) }, size: { width: 960, height: 540 } }).magnifier!;
    expect(m.rect.w).toBeCloseTo(200);
    expect(m.radius).toBeCloseTo(200 * 0.18);
    expect(m.border).toEqual({ width: 2.5, color: '#FF0000' });
  });

  it('keeps settings in range, even from a hand-edited file', () => {
    const p = project({ size: 99_999, zoom: 0.2 }, { border: { width: Number.NaN } });
    const m = lensAt(p, 4)!;
    expect(m.rect.w).toBe(MAGNIFIER_LIMITS.size.max);
    expect(m.zoom).toBe(MAGNIFIER_LIMITS.zoom.min);
    expect(m.border.width).toBe(MAGNIFIER_LIMITS.border.min);
  });

  it('stays inside the screen frame near its edges while the pointer stays where it is', () => {
    const p = project({ size: 400 });
    for (const at of [{ x: 0.005, y: 0.01 }, { x: 0.995, y: 0.99 }, { x: 0.5, y: 0.002 }]) {
      const plan = evaluate(p, sec(4), { cursors: { r1: still(at) } });
      const { rect, focus } = plan.magnifier!;
      const f = plan.screen!.frame;
      expect(rect.x).toBeGreaterThanOrEqual(f.x - 1e-6);
      expect(rect.y).toBeGreaterThanOrEqual(f.y - 1e-6);
      expect(rect.x + rect.w).toBeLessThanOrEqual(f.x + f.w + 1e-6);
      expect(rect.y + rect.h).toBeLessThanOrEqual(f.y + f.h + 1e-6);
      const drawn = sourceToCanvas(plan, at)!;
      expect(near(focus.x, drawn.x) && near(focus.y, drawn.y)).toBe(true);
    }
  });

  it('magnifies about the pointer: the pointer pixel reads the pointer, others read zoom-times closer', () => {
    const p = project({ size: 300, zoom: 2.5 });
    const plan = evaluate(p, sec(4), { cursors: { r1: still({ x: 0.3, y: 0.6 }) } });
    const m = plan.magnifier!;
    const { uv0, uvPerPx } = magnifierSampling(plan.screen!, m);
    const read = (px: number, py: number) => ({ x: uv0.x + (px - m.rect.x) * uvPerPx.x, y: uv0.y + (py - m.rect.y) * uvPerPx.y });
    const atPointer = read(m.focus.x, m.focus.y);
    expect(atPointer.x).toBeCloseTo(0.3, 9);
    expect(atPointer.y).toBeCloseTo(0.6, 9);
    // 100 px right of the pointer in the lens shows what is 40 px right of it in the frame.
    const right = read(m.focus.x + 100, m.focus.y);
    const unmagnified = sourceToCanvas(plan, right)!;
    expect(unmagnified.x - m.focus.x).toBeCloseTo(100 / 2.5, 6);
    expect(unmagnified.y - m.focus.y).toBeCloseTo(0, 6);
  });

  it('reads only the recorded area of a region capture', () => {
    const crop = { x: 0.25, y: 0.2, w: 0.5, h: 0.4 };
    const p = project({ size: 320, zoom: 2 }, {}, { crop });
    const plan = evaluate(p, sec(4), { cursors: { r1: still({ x: 0.02, y: 0.98 }) } });
    const m = plan.magnifier!;
    const { uv0, uvPerPx, bounds } = magnifierSampling(plan.screen!, m);
    expect(bounds).toEqual(crop);
    for (const [cx, cy] of [[0, 0], [1, 0], [0, 1], [1, 1]] as const) {
      const u = uv0.x + cx * m.rect.w * uvPerPx.x;
      const v = uv0.y + cy * m.rect.h * uvPerPx.y;
      expect(u).toBeGreaterThanOrEqual(crop.x - 1e-9);
      expect(u).toBeLessThanOrEqual(crop.x + crop.w + 1e-9);
      expect(v).toBeGreaterThanOrEqual(crop.y - 1e-9);
      expect(v).toBeLessThanOrEqual(crop.y + crop.h + 1e-9);
    }
  });

  it('works when the pointer is part of the video, and magnifies the drawn pointer otherwise', () => {
    const baked = evaluate(project({}, {}, { cursorInFrames: true }), sec(4), { cursors: { r1: still({ x: 0.5, y: 0.5 }) } });
    expect(baked.cursor).toBeNull();
    expect(baked.magnifier).not.toBeNull();
    const p = project({ zoom: 2 });
    const inside = evaluate(p, sec(4), { cursors: { r1: still({ x: 0.5, y: 0.5 }) } });
    const outside = evaluate(p, sec(0.5), { cursors: { r1: still({ x: 0.5, y: 0.5 }) } });
    expect(inside.cursor!.scale).toBeCloseTo(p.style.cursor.scale * 2);
    expect(outside.cursor!.scale).toBeCloseTo(p.style.cursor.scale);
  });

  it('follows zoomed views and hides when the pointer leaves the frame', () => {
    let p = project({ size: 240, zoom: 2 });
    p = addZoom(p, {
      recordingId: 'r1', start: 0, end: sec(10), origin: 'manual', mode: 'region', center: { x: 0.25, y: 0.25 }, scale: 2,
      enter: { duration: 0, easing: { kind: 'instant' } }, exit: presetTransition('smooth'),
    }).project;
    const inside = evaluate(p, sec(3), { cursors: { r1: still({ x: 0.3, y: 0.3 }) } });
    const at = sourceToCanvas(inside, { x: 0.3, y: 0.3 })!;
    expect(near(inside.magnifier!.focus.x, at.x)).toBe(true);
    expect(lensAt(p, 3, { x: 0.9, y: 0.9 })).toBeNull();
  });

  it('hides when the pointer is idle only if asked to', () => {
    const samples: CursorSample[] = [];
    for (let s = 0; s <= 10; s += 0.05) samples.push({ t: sec(s), x: s < 2 ? 0.2 + s * 0.1 : 0.4, y: 0.5 });
    const cursor = prepareCursor({ samples, clicks: [], scrolls: [] });
    const at = (p: Project, t: number) => evaluate(p, sec(t), { cursors: { r1: cursor } }).magnifier;
    expect(at(project({}, { hideWhenIdle: true }), 1.5)).not.toBeNull();
    expect(at(project({}, { hideWhenIdle: true }), 8)).toBeNull();
    expect(at(project({}, { hideWhenIdle: false }), 8)).not.toBeNull();
  });

  it('needs cursor data and a pointer inside the recorded area', () => {
    const p = project();
    expect(evaluate(p, sec(4)).magnifier).toBeNull();
    expect(evaluate(p, sec(4), { cursors: { r1: prepareCursor({ samples: [], clicks: [], scrolls: [] }) } }).magnifier).toBeNull();
    expect(lensAt(p, 4, { x: 1.3, y: 0.5 })).toBeNull();
  });

  it('stays on its content through cuts (anchored to recording time)', () => {
    let p = project({ start: sec(6), end: sec(8) });
    p = splitAt(splitAt(p, sec(1)), sec(3));
    p = removeSegment(p, p.sequence.segments[1]!.id); // removes 1 s – 3 s
    expect(lensAt(p, 3.5)).toBeNull();
    expect(lensAt(p, 4.5)).not.toBeNull(); // recording 6.5 s
  });

  it('is edited and removed with commands', () => {
    const p = project();
    const id = p.magnifiers[0]!.id;
    const edited = updateMagnifier(p, id, { size: 360, zoom: 3 });
    expect(edited.magnifiers[0]).toMatchObject({ size: 360, zoom: 3 });
    expect(p.magnifiers[0]!.size).toBe(280); // input untouched
    expect(removeMagnifier(edited, id).magnifiers).toEqual([]);
  });
});

describe('magnifier placement', () => {
  const base = () => addRecording(createProject('Yerleşim'), rec());

  it('never lets two ranges overlap: a start inside one is refused, a run-in is shortened', () => {
    const p = addMagnifier(base(), range(2, 4)).project;
    const inside = placeItem(p, 'magnifiers', range(3, 5));
    expect(inside.ok).toBe(false);
    const runIn = placeItem(p, 'magnifiers', range(1, 3));
    expect(runIn.ok && runIn.trimmed).toBe(true);
    if (runIn.ok) expect(runIn.project.magnifiers.find((m) => m.id === runIn.id)!.end).toBe(sec(2));
  });

  it('draws on the lane only in free time', () => {
    const p = addMagnifier(base(), range(2, 4)).project;
    expect(laneRange(p, 'magnifiers', sec(3), sec(5))).toBeNull();
    expect(laneRange(p, 'magnifiers', sec(5), sec(4.5))).toEqual({ recordingId: 'r1', start: sec(4.5), end: sec(5) });
    expect(laneRange(p, 'magnifiers', sec(5), sec(9))).toEqual({ recordingId: 'r1', start: sec(5), end: sec(9) });
  });

  it('repairs overlapping ranges in older files', () => {
    const p = { ...base(), magnifiers: [{ ...range(1, 4), id: 'a', type: 'magnifier' as const }, { ...range(3, 6), id: 'b', type: 'magnifier' as const }] };
    const fixed = resolveOverlaps(p);
    expect(fixed.magnifiers.map((m) => [m.id, m.start, m.end])).toEqual([['a', sec(1), sec(4)], ['b', sec(4), sec(6)]]);
  });
});
