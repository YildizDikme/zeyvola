import { describe, expect, it } from 'vitest';
import { secondsToTicks as sec } from '@zeyvola/timing';
import {
  frameGeometry, presetTransition, viewToViewport, zoomViewAt, type CursorTrack, type ZoomItem,
} from '@zeyvola/project-model';
import { combineNoSuggestionReasons, interestEvents, suggestZooms, whyNoSuggestions, type ZoomEngineInput } from './index';

const defaults = { scale: 1.8, enter: presetTransition('smooth'), exit: presetTransition('smooth') };

/** Scripted session: the pointer travels to each target, rests, clicks. */
function session(targets: { t: number; x: number; y: number }[], duration = 30): CursorTrack {
  const track: CursorTrack = { samples: [], clicks: [], scrolls: [] };
  let x = 0.5;
  let y = 0.5;
  let t = 0;
  for (const g of targets) {
    const travelStart = Math.max(t, g.t - 0.6);
    for (let s = t; s < travelStart; s += 1 / 60) track.samples.push({ t: sec(s), x, y });
    for (let s = travelStart; s < g.t; s += 1 / 60) {
      const u = (s - travelStart) / (g.t - travelStart);
      track.samples.push({ t: sec(s), x: x + (g.x - x) * u, y: y + (g.y - y) * u });
    }
    x = g.x; y = g.y; t = g.t;
    track.clicks.push({ t: sec(g.t), x, y, button: 'left', kind: 'down' });
    track.clicks.push({ t: sec(g.t + 0.08), x, y, button: 'left', kind: 'up' });
  }
  for (let s = t; s < duration; s += 1 / 60) track.samples.push({ t: sec(s), x, y });
  return track;
}

function input(track: CursorTrack, extra: Partial<ZoomEngineInput> = {}): ZoomEngineInput {
  return { recordingId: 'r1', duration: sec(30), track, hasClicks: true, sensitivity: 'medium', defaults, ...extra };
}

const asItems = (s: ReturnType<typeof suggestZooms>): ZoomItem[] => s.map((z, i) => ({ ...z, id: `z${i}` }));
const geom = frameGeometry(1920, 1200, { padding: 0, radius: 0, shadow: { opacity: 0, blur: 0, offsetY: 0 }, border: { width: 0, color: '#fff' }, aspectMode: 'source', area: { x: 0, y: 0, w: 1, h: 1 } }, 1.6);

describe('zoom engine', () => {
  it('reproduces the brief: zoom at 0:05, pan at 0:09, back to full by 0:15', () => {
    const track = session([{ t: 5, x: 0.2, y: 0.3 }, { t: 9, x: 0.72, y: 0.62 }]);
    const items = asItems(suggestZooms(input(track)));
    expect(items).toHaveLength(2);
    expect(items[0]!.end).toBe(items[1]!.start); // chained → pan, no zoom-out between
    expect(items[0]!.start).toBeLessThan(sec(5));
    expect(items[1]!.end).toBeLessThanOrEqual(sec(15));
    expect(zoomViewAt(items, sec(5), geom).z).toBeCloseTo(1.8, 1);
    expect(zoomViewAt(items, sec(15), geom).z).toBe(1);
  });

  it('keeps every clicked target inside the inner 80 % of the view (property test)', () => {
    let seed = 7;
    const r = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
    for (let n = 0; n < 60; n++) {
      const targets: { t: number; x: number; y: number }[] = [];
      let t = 1.5;
      for (let i = 0; i < 6; i++) {
        t += 0.6 + r() * 3.5;
        targets.push({ t, x: 0.05 + r() * 0.9, y: 0.05 + r() * 0.9 });
      }
      const items = asItems(suggestZooms(input(session(targets, t + 4), { duration: sec(t + 4) })));
      for (let i = 1; i < items.length; i++) expect(items[i]!.start).toBeGreaterThanOrEqual(items[i - 1]!.end);
      for (const g of targets) {
        const v = zoomViewAt(items, sec(g.t), geom);
        if (v.z <= 1.01) continue; // not zoomed: whole screen visible
        const vp = viewToViewport(v, geom);
        const inX = (g.x - vp.x) / vp.w;
        const inY = (g.y - vp.y) / vp.h;
        // Inner 80 %, except where the view is pinned against a source edge.
        const eps = 1e-6;
        expect(inX).toBeGreaterThanOrEqual(vp.x <= eps ? 0 : 0.1 - eps);
        expect(inX).toBeLessThanOrEqual(vp.x + vp.w >= 1 - eps ? 1 : 0.9 + eps);
        expect(inY).toBeGreaterThanOrEqual(vp.y <= eps ? 0 : 0.1 - eps);
        expect(inY).toBeLessThanOrEqual(vp.y + vp.h >= 1 - eps ? 1 : 0.9 + eps);
      }
    }
  });

  it('works without click data (dwell-only, e.g. Wayland)', () => {
    const track = session([{ t: 6, x: 0.3, y: 0.4 }, { t: 14, x: 0.8, y: 0.2 }]);
    const noClicks = { ...track, clicks: [] };
    const events = interestEvents(input(noClicks, { hasClicks: false }));
    expect(events.every((e) => e.kind === 'dwell')).toBe(true);
    expect(suggestZooms(input(noClicks, { hasClicks: false })).length).toBeGreaterThan(0);
  });

  it('is deterministic and respects sensitivity', () => {
    const track = session([{ t: 3, x: 0.2, y: 0.2 }, { t: 4, x: 0.25, y: 0.22 }, { t: 12, x: 0.8, y: 0.8 }, { t: 20, x: 0.5, y: 0.1 }]);
    expect(suggestZooms(input(track))).toEqual(suggestZooms(input(track)));
    const low = suggestZooms(input(track, { sensitivity: 'low' }));
    const high = suggestZooms(input(track, { sensitivity: 'high' }));
    expect(low.length).toBeLessThanOrEqual(high.length);
  });

  it('keeps a group zoom when a later click is too close for its own shot', () => {
    // Click times and positions from a real recording of the synthetic test pattern
    // (2026-10-17): five clicks form one wide group, a sixth follows 0.5 s later.
    const clicks = [
      { t: 7.806, x: 0.233, y: 0.437 }, { t: 8.452, x: 0.534, y: 0.446 }, { t: 9.353, x: 0.771, y: 0.433 },
      { t: 10.088, x: 0.219, y: 0.737 }, { t: 10.797, x: 0.507, y: 0.738 }, { t: 11.289, x: 0.819, y: 0.699 },
    ];
    const items = asItems(suggestZooms(input(session(clicks, 16), { duration: sec(16) })));
    const group = items.find((z) => z.start <= sec(7.806) && z.end >= sec(10.797));
    expect(group).toBeDefined();
    expect(group!.scale).toBeGreaterThanOrEqual(1.3);
    // Every click of the group stays in view while it happens.
    for (const c of clicks.slice(0, 5)) {
      const v = zoomViewAt(items, sec(c.t), geom);
      expect(Math.abs(c.x - v.cx)).toBeLessThan(0.5 / v.z);
      expect(Math.abs(c.y - v.cy)).toBeLessThan(0.5 / v.z);
    }
  });

  it('ignores clicks outside the captured area', () => {
    const track = session([{ t: 5, x: 1.4, y: 0.5 }]);
    expect(suggestZooms(input(track))).toHaveLength(0);
  });
});

describe('whyNoSuggestions', () => {
  const still = (x: number, y: number, seconds = 10): CursorTrack => {
    const track: CursorTrack = { samples: [], clicks: [], scrolls: [] };
    for (let s = 0; s < seconds; s += 1 / 30) track.samples.push({ t: sec(s), x, y });
    return track;
  };

  it('says the pointer was outside the recorded area (another screen was recorded)', () => {
    // The real case: x between 1.16 and 1.57 the whole time, clicks included.
    const track = session([{ t: 2, x: 1.2, y: 0.5 }, { t: 5, x: 1.5, y: 0.8 }, { t: 8, x: 1.3, y: 1.1 }]);
    for (const s of track.samples) s.x = 1.16 + (s.x % 0.41);
    expect(suggestZooms(input(track))).toHaveLength(0);
    expect(whyNoSuggestions(track, true)).toBe('outside');
  });

  it('does not blame the screen when the pointer was mostly inside', () => {
    const track = still(0.5, 0.5);
    for (let i = 0; i < track.samples.length * 0.3; i++) track.samples[i]!.x = 1.4;
    expect(whyNoSuggestions(track, true)).not.toBe('outside');
  });

  it('says there is no pointer data', () => {
    expect(whyNoSuggestions(null, true)).toBe('no-cursor');
    expect(whyNoSuggestions({ samples: [], clicks: [], scrolls: [] }, true)).toBe('no-cursor');
  });

  it('says clicks are missing when none are known inside the area', () => {
    expect(whyNoSuggestions(still(0.5, 0.5), false)).toBe('no-clicks');
    expect(whyNoSuggestions(still(0.5, 0.5), true)).toBe('no-clicks');
  });

  it('calls a session with clicks inside but nothing useful quiet', () => {
    const track = still(0.5, 0.5);
    track.clicks.push({ t: sec(1), x: 0.5, y: 0.5, button: 'left', kind: 'down' }, { t: sec(1.05), x: 0.5, y: 0.5, button: 'left', kind: 'up' });
    expect(whyNoSuggestions(track, true)).toBe('quiet');
  });

  it('combines recordings: the actionable reason wins', () => {
    expect(combineNoSuggestionReasons(['quiet', 'outside', 'no-cursor'])).toBe('outside');
    expect(combineNoSuggestionReasons(['no-cursor', 'no-clicks'])).toBe('no-clicks');
    expect(combineNoSuggestionReasons(['no-cursor'])).toBe('no-cursor');
    expect(combineNoSuggestionReasons([])).toBeNull();
  });
});
