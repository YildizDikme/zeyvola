import { describe, expect, it } from 'vitest';
import { frameDuration, secondsToTicks as sec } from '@zeyvola/timing';
import {
  History, addCameraLayout, addPrivacy, addRecording, addZoom, applyZoomSuggestions, canvasToSource,
  createProject, cubicBezier, defaultCameraLayout, evaluate, frameGeometry, interpolateView,
  itemTimelineRanges, layoutSegments, parseProject, prepareCursor, presetTransition, privacyActive,
  removeSegment, removeTimelineRange, sequenceDuration, serializeProject, setStyle, sourceToCanvas, splitAt,
  timelineToSource, updateZoom, zoomViewAt, type Project, type Recording, type ZoomItem,
} from './index';

function rec(id = 'r1', seconds = 60): Recording {
  return {
    id, createdAt: '2026-10-16T00:00:00Z', duration: sec(seconds),
    sources: {
      screen: { kind: 'screen', file: 'media/s.mp4', mime: 'video/mp4', width: 2880, height: 1800, fps: 60, startOffset: 0, duration: sec(seconds) },
      camera: { kind: 'camera', file: 'media/c.mp4', mime: 'video/mp4', width: 1920, height: 1080, fps: 30, startOffset: sec(0.1), duration: sec(seconds) },
    },
    capture: { backend: 'web', platform: 'test', target: { kind: 'display', label: 'Ekran', bounds: { x: 0, y: 0, w: 1440, h: 900 }, scaleFactor: 2 }, cursorInFrames: false, hasClicks: true },
    syncOffsets: {}, markers: [],
  };
}

function withRecording(): Project {
  return addRecording(createProject('Test'), rec());
}

/** Deterministic PRNG (mulberry32) for property tests. */
function rng(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('timeline mapping and cuts', () => {
  it('maps a fresh recording one-to-one', () => {
    const p = withRecording();
    expect(sequenceDuration(p)).toBe(sec(60));
    expect(timelineToSource(p, sec(12))?.sourceTime).toBe(sec(12));
  });

  it('split + delete shifts later content and keeps effects anchored to source time', () => {
    let p = withRecording();
    p = addPrivacy(p, {
      recordingId: 'r1', start: sec(12), end: sec(19), origin: 'manual', region: { x: 0.1, y: 0.1, w: 0.2, h: 0.05 },
      keyframes: [], effect: { kind: 'solid', color: '#000000' }, cornerRadius: 0.1, padFrames: 2,
    }).project;
    p = splitAt(splitAt(p, sec(2)), sec(5));
    expect(p.sequence.segments).toHaveLength(3);
    p = removeSegment(p, p.sequence.segments[1]!.id); // removes 2s–5s
    expect(sequenceDuration(p)).toBe(sec(57));
    const ranges = itemTimelineRanges(p, p.privacy[0]!);
    expect(ranges).toEqual([{ start: sec(9), end: sec(16) }]);
    // The phone number at source 15 s now appears at timeline 12 s and is still covered.
    const plan = evaluate(p, sec(12));
    expect(plan.sourceTime).toBe(sec(15));
    expect(plan.privacy).toHaveLength(1);
  });

  it('ripple-deletes a timeline range', () => {
    const p = removeTimelineRange(withRecording(), sec(10), sec(20));
    expect(sequenceDuration(p)).toBe(sec(50));
    expect(timelineToSource(p, sec(10))?.sourceTime).toBe(sec(20));
    expect(layoutSegments(p)).toHaveLength(2);
  });
});

describe('history', () => {
  it('undoes, redoes and coalesces gestures', () => {
    const h = new History(1);
    h.push(2, { coalesceKey: 'drag', now: 0 });
    h.push(3, { coalesceKey: 'drag', now: 100 });
    h.push(4, { now: 200 });
    expect(h.present).toBe(4);
    expect(h.undo()).toBe(true);
    expect(h.present).toBe(3);
    expect(h.undo()).toBe(true);
    expect(h.present).toBe(1);
    expect(h.undo()).toBe(false);
    expect(h.redo()).toBe(true);
    expect(h.present).toBe(3);
  });
});

describe('easing', () => {
  it('cubic bezier is monotonic with exact endpoints', () => {
    let prev = 0;
    for (let i = 0; i <= 100; i++) {
      const v = cubicBezier(0.4, 0, 0.2, 1, i / 100);
      expect(v).toBeGreaterThanOrEqual(prev - 1e-9);
      prev = v;
    }
    expect(cubicBezier(0.4, 0, 0.2, 1, 0)).toBe(0);
    expect(cubicBezier(0.4, 0, 0.2, 1, 1)).toBe(1);
  });
});

describe('zoom view', () => {
  const geom = frameGeometry(1920, 1080, { padding: 0.06, radius: 0, shadow: { opacity: 0, blur: 0, offsetY: 0 }, border: { width: 0, color: '#fff' }, aspectMode: 'source', area: { x: 0, y: 0, w: 1, h: 1 } }, 16 / 10);

  it('fixed-point interpolation hits both endpoints and keeps the fixed point still', () => {
    const a = { cx: 0.5, cy: 0.5, z: 1 };
    const b = { cx: 0.7, cy: 0.3, z: 2 };
    expect(interpolateView(a, b, 0)).toEqual(a);
    expect(interpolateView(a, b, 1)).toEqual(b);
    const f = { x: (b.z * b.cx - a.z * a.cx) / (b.z - a.z), y: (b.z * b.cy - a.z * a.cy) / (b.z - a.z) };
    for (const u of [0.25, 0.5, 0.75]) {
      const v = interpolateView(a, b, u);
      // Screen position of f relative to the view center, scaled by zoom, stays constant.
      expect((f.x - v.cx) * v.z).toBeCloseTo((f.x - a.cx) * a.z, 9);
      expect((f.y - v.cy) * v.z).toBeCloseTo((f.y - a.cy) * a.z, 9);
    }
  });

  it('never shows outside the source (property test)', () => {
    const r = rng(42);
    for (let n = 0; n < 200; n++) {
      const items: ZoomItem[] = [];
      let t = 0;
      for (let i = 0; i < 4; i++) {
        t += sec(r() * 3);
        const len = sec(0.5 + r() * 4);
        items.push({
          id: `z${i}`, type: 'zoom', recordingId: 'r1', start: t, end: t + len, origin: 'auto', mode: 'region',
          center: { x: r() * 1.4 - 0.2, y: r() * 1.4 - 0.2 }, scale: 1 + r() * 3,
          enter: presetTransition(r() > 0.5 ? 'smooth' : 'fast'), exit: presetTransition('smooth'),
        });
        t += len;
      }
      for (let s = 0; s < t; s += sec(0.05)) {
        const v = zoomViewAt(items, s, geom);
        const w = geom.baseW / v.z;
        const h = geom.baseH / v.z;
        expect(v.cx - w / 2).toBeGreaterThanOrEqual(-1e-9);
        expect(v.cx + w / 2).toBeLessThanOrEqual(1 + 1e-9);
        expect(v.cy - h / 2).toBeGreaterThanOrEqual(-1e-9);
        expect(v.cy + h / 2).toBeLessThanOrEqual(1 + 1e-9);
      }
    }
  });

  it('is continuous across chained items (pan without zooming out)', () => {
    const z = (id: string, start: number, end: number, cx: number): ZoomItem => ({
      id, type: 'zoom', recordingId: 'r1', start: sec(start), end: sec(end), origin: 'auto', mode: 'region',
      center: { x: cx, y: 0.5 }, scale: 2, enter: presetTransition('smooth'), exit: presetTransition('smooth'),
    });
    const items = [z('a', 5, 9, 0.3), z('b', 9, 15, 0.7)];
    expect(zoomViewAt(items, sec(8.99), geom).z).toBeCloseTo(2, 5);
    expect(zoomViewAt(items, sec(9.01), geom).z).toBeCloseTo(2, 2);
    let prev = zoomViewAt(items, sec(4), geom);
    for (let s = sec(4); s < sec(16); s += sec(1 / 60)) {
      const v = zoomViewAt(items, s, geom);
      expect(Math.abs(v.cx - prev.cx)).toBeLessThan(0.05);
      expect(Math.abs(Math.log(v.z / prev.z))).toBeLessThan(0.08);
      prev = v;
    }
    expect(zoomViewAt(items, sec(16), geom).z).toBe(1);
  });
});

describe('privacy timing', () => {
  it('covers a frame when any part of it overlaps the padded range', () => {
    const fd = frameDuration({ num: 30, den: 1 });
    const item = { start: sec(12), end: sec(19), padFrames: 0 } as Parameters<typeof privacyActive>[0];
    expect(privacyActive(item, sec(12) - fd, fd)).toBe(false);
    expect(privacyActive(item, sec(12) - fd + 1, fd)).toBe(true);
    expect(privacyActive(item, sec(19) - 1, fd)).toBe(true);
    expect(privacyActive(item, sec(19), fd)).toBe(false);
    expect(privacyActive({ ...item, padFrames: 2 }, sec(19) + fd, fd)).toBe(true);
  });
});

describe('evaluate', () => {
  it('lays out screen, camera and maps coordinates both ways', () => {
    const p = withRecording();
    const plan = evaluate(p, sec(3));
    expect(plan.screen).not.toBeNull();
    expect(plan.camera).not.toBeNull();
    expect(plan.camera!.mediaTime).toBe(sec(2.9));
    const c = sourceToCanvas(plan, { x: 0.25, y: 0.75 })!;
    const back = canvasToSource(plan, c.x, c.y)!;
    expect(back.x).toBeCloseTo(0.25, 9);
    expect(back.y).toBeCloseTo(0.75, 9);
  });

  it('animates camera layouts and returns to the base layout', () => {
    let p = withRecording();
    p = addCameraLayout(p, {
      recordingId: 'r1', start: sec(10), end: sec(15), origin: 'manual',
      layout: { ...defaultCameraLayout(), position: { x: 0.5, y: 0.5 }, size: 0.6 }, enter: presetTransition('smooth'),
    }).project;
    const before = evaluate(p, sec(9)).camera!;
    const held = evaluate(p, sec(12)).camera!;
    const after = evaluate(p, sec(17)).camera!;
    expect(held.rect.h).toBeCloseTo(0.6 * 1080, 3);
    expect(held.rect.x + held.rect.w / 2).toBeCloseTo(960, 3);
    expect(after.rect).toEqual(before.rect);
  });

  it('fills edge to edge when padding is zero, even if the aspect differs', () => {
    const p = setStyle(withRecording(), { frame: { padding: 0 } });
    const plan = evaluate(p, sec(3));
    expect(plan.screen!.frame).toEqual({ x: 0, y: 0, w: 1920, h: 1080 });
    expect(plan.screen!.radius).toBe(0);
    expect(plan.screen!.shadow.opacity).toBe(0);
    // 16:10 source in a 16:9 frame: full width, slightly cropped height.
    expect(plan.screen!.viewport.w).toBeCloseTo(1, 9);
    expect(plan.screen!.viewport.h).toBeCloseTo((16 / 10) / (16 / 9), 6);
  });

  it('follows the cursor while cropping in fill mode (vertical variant)', () => {
    const p = { ...withRecording(), activeVariantId: 'v_9x16' };
    const cursor = prepareCursor({ samples: [{ t: 0, x: 0.1, y: 0.5 }, { t: sec(60), x: 0.1, y: 0.5 }], clicks: [], scrolls: [] });
    const plan = evaluate(p, sec(5), { cursors: { r1: cursor } });
    expect(plan.screen!.viewport.w).toBeLessThan(1);
    expect(plan.screen!.viewport.x).toBeCloseTo(0, 6); // clamped to the left edge
  });
});

describe('suggestions and persistence', () => {
  it('replaces auto zooms but never manual ones', () => {
    let p = withRecording();
    const base = { recordingId: 'r1', mode: 'region' as const, center: { x: 0.5, y: 0.5 }, scale: 2, enter: presetTransition('smooth'), exit: presetTransition('smooth') };
    p = addZoom(p, { ...base, start: sec(1), end: sec(3), origin: 'auto' }).project;
    const { project, id } = addZoom(p, { ...base, start: sec(10), end: sec(12), origin: 'auto' });
    p = updateZoom(project, id, { scale: 2.5 }); // user edit → manual
    p = applyZoomSuggestions(p, 'r1', [
      { ...base, type: 'zoom', start: sec(4), end: sec(6), origin: 'auto' },
      { ...base, type: 'zoom', start: sec(11), end: sec(13), origin: 'auto' }, // overlaps manual → dropped
    ]);
    expect(p.zooms.map((z) => [z.start, z.origin])).toEqual([[sec(4), 'auto'], [sec(10), 'manual']]);
  });

  it('round-trips through JSON and fills defaults', () => {
    const p = withRecording();
    const parsed = parseProject(JSON.parse(serializeProject(p)));
    expect(parsed.sequence).toEqual(p.sequence);
    const partial = JSON.parse(serializeProject(p));
    delete partial.style.cursor;
    expect(parseProject(partial).style.cursor.visible).toBe(true);
    expect(() => parseProject({ schema: 99 })).toThrow();
  });
});
