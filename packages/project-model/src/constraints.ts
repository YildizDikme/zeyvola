import { secondsToTicks, type Ticks } from '@zeyvola/timing';
import { addCameraLayout, addMagnifier, addPrivacy, addZoom, type NewCameraLayout, type NewMagnifier, type NewPrivacy, type NewZoom } from './commands';
import type { Rect } from './geometry';
import { layoutSegments, timelineToSource } from './mapping';
import type { CameraLayoutItem, ID, MagnifierItem, PrivacyItem, Project, ZoomItem } from './types';

/**
 * Placement rules for timeline items:
 *  - zooms never overlap each other in time (one camera move at a time);
 *  - camera layout changes never overlap each other;
 *  - magnifier ranges never overlap each other (one lens at a time);
 *  - privacy areas may run at the same time only when they cover different parts of the
 *    screen; two areas over the same place at the same time are not allowed.
 */
export type TrackKey = 'zooms' | 'cameraLayouts' | 'privacy' | 'magnifiers';
export type TrackItem = ZoomItem | CameraLayoutItem | PrivacyItem | MagnifierItem;

export const MIN_ITEM: Ticks = secondsToTicks(0.2);

export function trackItems(p: Project, key: TrackKey): TrackItem[] {
  return p[key] as TrackItem[];
}

/** Union of an area's base region and all its keyframe regions. */
export function privacyBounds(item: Pick<PrivacyItem, 'region' | 'keyframes'>): Rect {
  let x0 = item.region.x;
  let y0 = item.region.y;
  let x1 = item.region.x + item.region.w;
  let y1 = item.region.y + item.region.h;
  for (const k of item.keyframes) {
    x0 = Math.min(x0, k.region.x);
    y0 = Math.min(y0, k.region.y);
    x1 = Math.max(x1, k.region.x + k.region.w);
    y1 = Math.max(y1, k.region.y + k.region.h);
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** True when two rectangles share a positive area. */
export function rectsIntersect(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/** Whether `other` may not share time with `item` on this track. */
function blocks(key: TrackKey, item: TrackItem, other: TrackItem): boolean {
  if (item.recordingId !== other.recordingId || item.id === other.id) return false;
  if (key !== 'privacy') return true;
  return rectsIntersect(privacyBounds(item as PrivacyItem), privacyBounds(other as PrivacyItem));
}

export function conflictsFor(p: Project, key: TrackKey, item: TrackItem): TrackItem[] {
  return trackItems(p, key).filter((o) => blocks(key, item, o) && item.start < o.end && o.start < item.end);
}

/** The free time window around `item`, bounded by blocking neighbours and the recording. */
export function freeWindow(p: Project, key: TrackKey, item: TrackItem): { lo: Ticks; hi: Ticks } {
  let lo = 0;
  let hi = p.recordings[item.recordingId]?.duration ?? Number.MAX_SAFE_INTEGER;
  for (const o of trackItems(p, key)) {
    if (!blocks(key, item, o)) continue;
    if (o.end <= item.start) lo = Math.max(lo, o.end);
    else if (o.start >= item.end) hi = Math.min(hi, o.start);
  }
  // Legacy overlaps: never push an item away from where it already is.
  return { lo: Math.min(lo, item.start), hi: Math.max(hi, item.end) };
}

/** Applies a drag delta within the free window. */
export function clampDrag(win: { lo: Ticks; hi: Ticks }, start0: Ticks, end0: Ticks, mode: 'move' | 'start' | 'end', dt: Ticks): { start: Ticks; end: Ticks } {
  if (mode === 'move') {
    const d = Math.max(win.lo - start0, Math.min(win.hi - end0, dt));
    return { start: Math.round(start0 + d), end: Math.round(end0 + d) };
  }
  if (mode === 'start') return { start: Math.round(Math.max(win.lo, Math.min(end0 - MIN_ITEM, start0 + dt))), end: end0 };
  return { start: start0, end: Math.round(Math.min(win.hi, Math.max(start0 + MIN_ITEM, end0 + dt))) };
}

export type PlaceResult =
  | { ok: true; project: Project; id: ID; replacedSuggestions: number; trimmed: boolean }
  | { ok: false; conflict: TrackItem };

type NewByKey = { zooms: NewZoom; cameraLayouts: NewCameraLayout; privacy: NewPrivacy; magnifiers: NewMagnifier };

/**
 * Adds an item if the rules allow it. A manual zoom placed over automatic suggestions
 * replaces them. If the start is free but the end runs into a neighbour, the new item is
 * shortened to fit. Returns the blocking item otherwise.
 */
export function placeItem<K extends TrackKey>(p: Project, key: K, input: NewByKey[K]): PlaceResult {
  const item = { ...input };
  const TYPE: Record<TrackKey, TrackItem['type']> = { zooms: 'zoom', privacy: 'privacy', cameraLayouts: 'camera', magnifiers: 'magnifier' };
  const probe = { ...item, id: '__new__', type: TYPE[key] } as TrackItem;
  let project = p;
  let replaced = 0;
  let conflicts = conflictsFor(project, key, probe);
  if (key === 'zooms' && conflicts.length > 0 && conflicts.every((c) => c.origin === 'auto')) {
    const drop = new Set(conflicts.map((c) => c.id));
    replaced = drop.size;
    project = { ...project, zooms: project.zooms.filter((z) => !drop.has(z.id)) };
    conflicts = [];
  }
  let trimmed = false;
  if (conflicts.length > 0) {
    const covering = conflicts.find((c) => c.start <= probe.start && probe.start < c.end);
    if (covering) return { ok: false, conflict: covering };
    const nextStart = Math.min(...conflicts.map((c) => c.start));
    if (nextStart - probe.start < MIN_ITEM) return { ok: false, conflict: conflicts[0]! };
    (item as { end: Ticks }).end = nextStart;
    trimmed = true;
  }
  const add = key === 'zooms' ? addZoom(project, item as NewZoom)
    : key === 'privacy' ? addPrivacy(project, item as NewPrivacy)
      : key === 'magnifiers' ? addMagnifier(project, item as NewMagnifier)
        : addCameraLayout(project, item as NewCameraLayout);
  return { ok: true, project: add.project, id: add.id, replacedSuggestions: replaced, trimmed };
}

/**
 * Repairs overlaps in older projects: automatic suggestions that collide are dropped,
 * later manual items are shortened to start after the earlier one, and anything left
 * shorter than MIN_ITEM is removed.
 */
export function resolveOverlaps(p: Project): Project {
  let changed = false;
  const fix = <T extends TrackItem>(key: TrackKey, items: T[]): T[] => {
    const sorted = [...items].sort((a, b) => a.start - b.start || (a.origin === 'manual' ? -1 : 1));
    const kept: T[] = [];
    for (const it of sorted) {
      let cur = it;
      for (const k of kept) {
        if (!blocks(key, cur, k) || !(cur.start < k.end && k.start < cur.end)) continue;
        if (cur.origin === 'auto') { cur = { ...cur, end: cur.start }; break; }
        cur = { ...cur, start: k.end };
      }
      if (cur.end - cur.start >= MIN_ITEM) kept.push(cur);
      if (cur !== it) changed = true;
    }
    return kept;
  };
  const next = {
    ...p,
    zooms: fix('zooms', p.zooms),
    cameraLayouts: fix('cameraLayouts', p.cameraLayouts),
    privacy: fix('privacy', p.privacy),
    magnifiers: fix('magnifiers', p.magnifiers),
  };
  return changed ? next : p;
}

/**
 * Turns a press-and-drag on the timeline (timeline times `from` → `to`, either direction)
 * into the source range of a new item on track `key`. The range stays inside the clip
 * section under the press and inside the free space between neighbouring items; on the zoom
 * track, automatic suggestions do not block (a manual zoom replaces them); on the privacy
 * track only areas overlapping `region` block. Null when the press time is already taken or
 * there is no room for at least MIN_ITEM.
 */
export function laneRange(
  p: Project, key: TrackKey, from: Ticks, to: Ticks, region?: Rect,
): { recordingId: ID; start: Ticks; end: Ticks } | null {
  const pos = timelineToSource(p, from, layoutSegments(p));
  if (!pos) return null;
  const seg = pos.placement.segment;
  const s0 = pos.sourceTime;
  let lo = seg.sourceStart;
  let hi = seg.sourceEnd;
  for (const o of trackItems(p, key)) {
    if (o.recordingId !== pos.recordingId) continue;
    if (key === 'zooms' && o.origin === 'auto') continue;
    if (key === 'privacy' && (!region || !rectsIntersect(region, privacyBounds(o as PrivacyItem)))) continue;
    if (o.start <= s0 && s0 < o.end) return null;
    if (o.end <= s0) lo = Math.max(lo, o.end);
    else hi = Math.min(hi, o.start);
  }
  const s1 = s0 + (to - from);
  const clamp = (v: Ticks) => Math.round(Math.min(hi, Math.max(lo, v)));
  const start = clamp(Math.min(s0, s1));
  const end = clamp(Math.max(s0, s1));
  if (end - start < MIN_ITEM) return null;
  return { recordingId: pos.recordingId, start, end };
}
