import { describe, expect, it } from 'vitest';
import { secondsToTicks as sec } from '@zeyvola/timing';
import {
  addCameraLayout, addCameraMoveAt, addPrivacy, addRecording, addZoom, cameraPartAt, cameraSplitTime, clampDrag, conflictsFor, createProject, evaluate, freeWindow,
  laneRange, newCameraMoveLayout, placeItem, setCameraMovePosition, suggestedSecondPosition,
  presetTransition, resolveOverlaps, type NewPrivacy, type NewZoom, type Project,
} from './index';

function base(): Project {
  return addRecording(createProject('t'), {
    id: 'r1', createdAt: '', duration: sec(60),
    sources: { screen: { kind: 'screen', file: 's.mp4', mime: 'video/mp4', width: 1920, height: 1080, startOffset: 0, duration: sec(60) } },
    capture: { backend: 'web', platform: 't', target: { kind: 'display', label: '', bounds: { x: 0, y: 0, w: 1920, h: 1080 }, scaleFactor: 1 }, cursorInFrames: true, hasClicks: false },
    syncOffsets: {}, markers: [],
  });
}
const zoom = (start: number, end: number, origin: 'auto' | 'manual' = 'manual'): NewZoom => ({
  recordingId: 'r1', start: sec(start), end: sec(end), origin, mode: 'region', center: { x: 0.5, y: 0.5 }, scale: 2,
  enter: presetTransition('smooth'), exit: presetTransition('smooth'),
});
const priv = (start: number, end: number, x: number): NewPrivacy => ({
  recordingId: 'r1', start: sec(start), end: sec(end), origin: 'manual', region: { x, y: 0.4, w: 0.2, h: 0.1 },
  keyframes: [], effect: { kind: 'solid', color: '#000000' }, cornerRadius: 0, padFrames: 2,
});

function withCamera(): Project {
  const p = addRecording({ ...base(), recordings: {} }, {
    id: 'r1', createdAt: '', duration: sec(60),
    sources: {
      screen: { kind: 'screen', file: 's.mp4', mime: 'video/mp4', width: 1920, height: 1080, startOffset: 0, duration: sec(60) },
      camera: { kind: 'camera', file: 'c.mp4', mime: 'video/mp4', width: 1280, height: 720, startOffset: 0, duration: sec(60) },
    },
    capture: { backend: 'web', platform: 't', target: { kind: 'display', label: '', bounds: { x: 0, y: 0, w: 1920, h: 1080 }, scaleFactor: 1 }, cursorInFrames: true, hasClicks: false },
    syncOffsets: {}, markers: [],
  });
  return { ...p, sequence: { ...p.sequence, segments: p.sequence.segments.slice(-1) } };
}
const centerX = (p: Project, t: number) => { const c = evaluate(p, sec(t)).camera!; return (c.rect.x + c.rect.w / 2) / 1920; };

describe('dynamic camera: two positions', () => {
  it('starts where the camera is, moves to the 2. konum at the split, then returns', () => {
    const p0 = withCamera();
    const home = centerX(p0, 1);
    const a = addCameraMoveAt(p0, sec(10), { position: { x: 0.2, y: 0.3 } })!;
    const item = a.project.cameraLayouts[0]!;
    expect([item.start, item.end]).toEqual([sec(10), sec(13)]);
    expect(item.layout.position).toEqual(newCameraMoveLayout(p0).position); // 1. konum = where the camera sits
    expect(cameraSplitTime(item)).toBe(sec(11.5));
    expect(centerX(a.project, 10.5)).toBeCloseTo(home, 4);   // first part: still at the 1. konum
    expect(centerX(a.project, 12.9)).toBeCloseTo(0.2, 3);    // second part: at the 2. konum
    expect(centerX(a.project, 20)).toBeCloseTo(home, 4);     // back home afterwards
    expect(cameraPartAt(item, sec(11))).toBe(1);
    expect(cameraPartAt(item, sec(12))).toBe(2);
  });

  it('leaves the 2. konum to be picked, then edits each position on its own', () => {
    const a = addCameraMoveAt(withCamera(), sec(5))!;
    const item = a.project.cameraLayouts[0]!;
    expect(item.second).toBeUndefined();
    expect(cameraPartAt(item, sec(7.5))).toBe(1); // nothing to move to yet
    let p = setCameraMovePosition(a.project, a.id, 2, { position: { x: 0.5, y: 0.15 } });
    expect(p.cameraLayouts[0]!.second).toEqual({ position: { x: 0.5, y: 0.15 }, size: item.layout.size });
    p = setCameraMovePosition(p, a.id, 1, { position: { x: 0.1, y: 0.8 }, size: 0.4 });
    expect(p.cameraLayouts[0]!.layout.position).toEqual({ x: 0.1, y: 0.8 });
    expect(p.cameraLayouts[0]!.second!.position).toEqual({ x: 0.5, y: 0.15 });
    p = setCameraMovePosition(p, a.id, 2, { position: { x: 1.4, y: -0.2 } });
    expect(p.cameraLayouts[0]!.second!.position).toEqual({ x: 1, y: 0 }); // kept on the canvas
  });

  it('chains a following move from the previous 2. konum', () => {
    let p = addCameraMoveAt(withCamera(), sec(10), { position: { x: 0.2, y: 0.3 } })!.project;
    p = addCameraMoveAt(p, sec(13))!.project;
    expect(p.cameraLayouts.map((c) => c.start)).toEqual([sec(10), sec(13)]);
    // Right at the second move's start the camera is still where the first one left it.
    expect(centerX(p, 13.01)).toBeCloseTo(0.2, 1);
  });

  it('suggests the other side for the 2. konum', () => {
    expect(suggestedSecondPosition({ x: 0.88, y: 0.8 })).toEqual({ x: 1 - 0.88, y: 0.8 });
    expect(suggestedSecondPosition({ x: 0.5, y: 0.8 }).y).toBeCloseTo(0.2, 6);
  });
});

describe('placement rules', () => {
  it('refuses a zoom that starts inside another manual zoom', () => {
    const p = addZoom(base(), zoom(5, 10)).project;
    const r = placeItem(p, 'zooms', zoom(7, 12));
    expect(r.ok).toBe(false);
  });

  it('shortens a new zoom that would run into the next one', () => {
    const p = addZoom(base(), zoom(10, 14)).project;
    const r = placeItem(p, 'zooms', zoom(7, 12));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.trimmed).toBe(true);
      expect(r.project.zooms.find((z) => z.id === r.id)!.end).toBe(sec(10));
    }
  });

  it('lets a manual zoom replace overlapping suggestions', () => {
    const p = addZoom(base(), zoom(5, 10, 'auto')).project;
    const r = placeItem(p, 'zooms', zoom(6, 9));
    expect(r.ok && r.replacedSuggestions).toBe(1);
    if (r.ok) expect(r.project.zooms).toHaveLength(1);
  });

  it('allows simultaneous privacy areas only in different places', () => {
    const p = addPrivacy(base(), priv(5, 10, 0.1)).project;
    expect(placeItem(p, 'privacy', priv(6, 9, 0.6)).ok).toBe(true); // elsewhere on screen
    expect(placeItem(p, 'privacy', priv(6, 9, 0.15)).ok).toBe(false); // same place
  });

  it('clamps drags to the free window', () => {
    let p = addZoom(base(), zoom(2, 4)).project;
    p = addZoom(p, zoom(10, 12)).project;
    const mid = addZoom(p, zoom(6, 8));
    p = mid.project;
    const item = p.zooms.find((z) => z.id === mid.id)!;
    const win = freeWindow(p, 'zooms', item);
    expect(win).toEqual({ lo: sec(4), hi: sec(10) });
    expect(clampDrag(win, item.start, item.end, 'move', sec(-10))).toEqual({ start: sec(4), end: sec(6) });
    expect(clampDrag(win, item.start, item.end, 'end', sec(10)).end).toBe(sec(10));
    expect(conflictsFor(p, 'zooms', { ...item, ...clampDrag(win, item.start, item.end, 'move', sec(50)) })).toHaveLength(0);
  });

  it('repairs overlaps in older projects', () => {
    let p = base();
    p = { ...p, zooms: [] };
    p = addZoom(p, zoom(5, 10)).project;
    p = addZoom(p, zoom(7, 12)).project; // overlapping manual
    p = addZoom(p, zoom(8, 9, 'auto')).project; // overlapping suggestion
    p = addPrivacy(p, priv(1, 4, 0.1)).project;
    p = addPrivacy(p, priv(2, 3, 0.1)).project; // same place, inside the first
    const fixed = resolveOverlaps(p);
    expect(fixed.zooms.map((z) => [z.start, z.end])).toEqual([[sec(5), sec(10)], [sec(10), sec(12)]]);
    expect(fixed.privacy).toHaveLength(1);
    expect(resolveOverlaps(fixed)).toBe(fixed);
  });
});

describe('drawing ranges on a timeline lane', () => {
  const cam = (p: Project, start: number, end: number) => addCameraLayout(p, {
    recordingId: 'r1', start: sec(start), end: sec(end), origin: 'manual', layout: newCameraMoveLayout(p), enter: presetTransition('smooth'),
  }).project;

  it('returns the dragged range in either direction', () => {
    expect(laneRange(base(), 'cameraLayouts', sec(4), sec(9))).toEqual({ recordingId: 'r1', start: sec(4), end: sec(9) });
    expect(laneRange(base(), 'cameraLayouts', sec(9), sec(4))).toEqual({ recordingId: 'r1', start: sec(4), end: sec(9) });
  });

  it('stops at neighbours and refuses a press on an existing item', () => {
    const p = cam(base(), 10, 15);
    expect(laneRange(p, 'cameraLayouts', sec(6), sec(20))).toEqual({ recordingId: 'r1', start: sec(6), end: sec(10) });
    expect(laneRange(p, 'cameraLayouts', sec(18), sec(12))).toEqual({ recordingId: 'r1', start: sec(15), end: sec(18) });
    expect(laneRange(p, 'cameraLayouts', sec(12), sec(13))).toBeNull();
    expect(laneRange(p, 'cameraLayouts', sec(5), sec(5.1))).toBeNull(); // shorter than MIN_ITEM
  });

  it('stays inside the recording', () => {
    expect(laneRange(base(), 'cameraLayouts', sec(58), sec(70))).toEqual({ recordingId: 'r1', start: sec(58), end: sec(60) });
  });

  it('lets many camera moves sit at different times', () => {
    let p = base();
    for (const [a, b] of [[2, 5], [20, 24], [40, 41], [8, 12]] as const) {
      const r = laneRange(p, 'cameraLayouts', sec(a), sec(b))!;
      const placed = placeItem(p, 'cameraLayouts', { ...r, origin: 'manual', layout: newCameraMoveLayout(p), enter: presetTransition('smooth') });
      expect(placed.ok).toBe(true);
      if (placed.ok) p = placed.project;
    }
    expect(p.cameraLayouts.map((c) => c.start).sort((x, y) => x - y)).toEqual([sec(2), sec(8), sec(20), sec(40)]);
  });

  it('on the privacy track only areas in the same place block', () => {
    const p = addPrivacy(base(), priv(10, 14, 0.4)).project;
    const same = { x: 0.45, y: 0.42, w: 0.1, h: 0.05 };
    const elsewhere = { x: 0.05, y: 0.05, w: 0.1, h: 0.05 };
    expect(laneRange(p, 'privacy', sec(8), sec(16), same)).toEqual({ recordingId: 'r1', start: sec(8), end: sec(10) });
    expect(laneRange(p, 'privacy', sec(8), sec(16), elsewhere)).toEqual({ recordingId: 'r1', start: sec(8), end: sec(16) });
  });

  it('ignores automatic zoom suggestions on the zoom lane', () => {
    const p = addZoom(base(), zoom(10, 14, 'auto')).project;
    expect(laneRange(p, 'zooms', sec(8), sec(16))).toEqual({ recordingId: 'r1', start: sec(8), end: sec(16) });
  });

});
