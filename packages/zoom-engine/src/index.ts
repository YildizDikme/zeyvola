import { TICKS_PER_SECOND, secondsToTicks, type Ticks } from '@zeyvola/timing';
import {
  effectiveDuration, type CursorTrack, type ID, type Rect, type Transition, type ZoomItem, type ZoomSensitivity,
} from '@zeyvola/project-model';

/**
 * Automatic zoom suggestions. Independent design built from general principles:
 * interest events → greedy time/space clustering → timing with look-ahead
 * (we run after recording, so a zoom can finish before the click) → chaining of
 * close clusters into pans. Output items are parametric and fully editable.
 */
export const ENGINE_VERSION = 'ze-1.1';

export interface ZoomParams {
  /** Events closer than this in time may join one cluster. */
  joinGap: Ticks;
  /** Clusters whose events are closer than this are chained (pan, no zoom-out in between). */
  chainGap: Ticks;
  /** Hold after the last event of a cluster. */
  tail: Ticks;
  /** Extra time between the end of the zoom-in and the first event. */
  settle: Ticks;
  preferredScale: number;
  maxScale: number;
  /** Smallest zoom that is still worth suggesting. */
  minUsefulScale: number;
  margin: number;
  minConfidence: number;
  minHold: Ticks;
}

export function paramsFor(sensitivity: ZoomSensitivity, preferredScale = 1.8): ZoomParams {
  const s = (v: number) => secondsToTicks(v);
  const base: ZoomParams = {
    joinGap: s(1.5), chainGap: s(4.5), tail: s(1.2), settle: s(0.12), preferredScale,
    maxScale: 3, minUsefulScale: 1.3, margin: 0.12, minConfidence: 0.5, minHold: s(0.8),
  };
  if (sensitivity === 'low') return { ...base, joinGap: s(2.5), chainGap: s(6), tail: s(2.0), margin: 0.18, minConfidence: 0.7, preferredScale: Math.min(preferredScale, 1.6) };
  if (sensitivity === 'high') return { ...base, joinGap: s(1.0), chainGap: s(3), tail: s(0.8), margin: 0.08, minConfidence: 0.35 };
  return base;
}

export interface ZoomEngineInput {
  recordingId: ID;
  duration: Ticks;
  track: CursorTrack;
  /** False when the backend cannot observe clicks (e.g. Wayland, browser capture). */
  hasClicks: boolean;
  markers?: Ticks[];
  sensitivity: ZoomSensitivity;
  defaults: { scale: number; enter: Transition; exit: Transition };
  params?: Partial<ZoomParams>;
}

export interface InterestEvent {
  t: Ticks;
  box: Rect;
  weight: number;
  kind: 'click' | 'drag' | 'dwell' | 'marker';
}

const CLICK_BOX = 0.03;
const DOUBLE_CLICK_GAP = 0.35 * TICKS_PER_SECOND;
const DRAG_MIN = 0.02;
const DWELL_TIME = 0.7 * TICKS_PER_SECOND;
const DWELL_RADIUS = 0.012;
const SCROLL_BEFORE = 0.2 * TICKS_PER_SECOND;
const SCROLL_AFTER = 0.5 * TICKS_PER_SECOND;

const inside = (x: number, y: number) => x >= 0 && x <= 1 && y >= 0 && y <= 1;
const boxAround = (x: number, y: number, size: number): Rect => ({ x: x - size / 2, y: y - size / 2, w: size, h: size });

function union(a: Rect, b: Rect): Rect {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
}

function positionAt(track: CursorTrack, t: Ticks): { x: number; y: number } | null {
  const s = track.samples;
  if (s.length === 0) return null;
  let lo = 0;
  let hi = s.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (s[mid]!.t <= t) lo = mid;
    else hi = mid - 1;
  }
  return s[lo]!;
}

/** Extracts interest events from the raw cursor log. Exported for tests and debugging. */
export function interestEvents(input: ZoomEngineInput): InterestEvent[] {
  const track = {
    samples: [...input.track.samples].sort((a, b) => a.t - b.t),
    clicks: [...input.track.clicks].sort((a, b) => a.t - b.t),
    scrolls: [...input.track.scrolls].sort((a, b) => a.t - b.t),
  };
  const events: InterestEvent[] = [];
  const scrolling = (t: Ticks) => track.scrolls.some((s) => t >= s.t - SCROLL_BEFORE && t <= s.t + SCROLL_AFTER);

  if (input.hasClicks) {
    const downs = track.clicks.filter((c) => c.kind === 'down' && c.button === 'left');
    const ups = track.clicks.filter((c) => c.kind === 'up');
    for (let i = 0; i < downs.length; i++) {
      const d = downs[i]!;
      if (!inside(d.x, d.y)) continue;
      const prev = events[events.length - 1];
      if (prev && prev.kind === 'click' && d.t - prev.t < DOUBLE_CLICK_GAP
        && Math.abs(prev.box.x + prev.box.w / 2 - d.x) < 0.015 && Math.abs(prev.box.y + prev.box.h / 2 - d.y) < 0.015) {
        prev.weight = 1.1;
        continue;
      }
      const up = ups.find((u) => u.t >= d.t);
      if (up && Math.hypot(up.x - d.x, up.y - d.y) > DRAG_MIN) {
        let box = boxAround(d.x, d.y, CLICK_BOX);
        for (const s of track.samples) if (s.t >= d.t && s.t <= up.t && inside(s.x, s.y)) box = union(box, boxAround(s.x, s.y, 0.01));
        events.push({ t: d.t, box, weight: 0.8, kind: 'drag' });
      } else {
        events.push({ t: d.t, box: boxAround(d.x, d.y, CLICK_BOX), weight: 1, kind: 'click' });
      }
    }
  }

  // Dwell: the pointer moves somewhere on purpose and rests there.
  const samples = track.samples;
  let anchor = 0;
  let movedRecently = false;
  let emitted = false;
  for (let i = 1; i < samples.length; i++) {
    const a = samples[anchor]!;
    const s = samples[i]!;
    if (Math.hypot(s.x - a.x, s.y - a.y) > DWELL_RADIUS) {
      movedRecently = true;
      anchor = i;
      emitted = false;
      continue;
    }
    if (!emitted && movedRecently && s.t - a.t >= DWELL_TIME && inside(a.x, a.y) && !scrolling(a.t)) {
      const nearClick = events.some((e) => Math.abs(e.t - a.t) < secondsToTicks(1));
      if (!nearClick) events.push({ t: a.t, box: boxAround(a.x, a.y, 0.06), weight: input.hasClicks ? 0.45 : 0.75, kind: 'dwell' });
      emitted = true;
      movedRecently = false;
    }
  }

  for (const m of input.markers ?? []) {
    const p = positionAt(track, m);
    if (p && inside(p.x, p.y)) events.push({ t: m, box: boxAround(p.x, p.y, 0.08), weight: 1.2, kind: 'marker' });
  }
  return events.sort((a, b) => a.t - b.t);
}

interface Cluster {
  first: Ticks;
  last: Ticks;
  box: Rect;
  weight: number;
  kinds: Set<InterestEvent['kind']>;
}

export function suggestZooms(input: ZoomEngineInput): Omit<ZoomItem, 'id'>[] {
  const p = { ...paramsFor(input.sensitivity, input.defaults.scale), ...input.params };
  const events = interestEvents(input);
  const usable = (1 - 2 * p.margin) / p.minUsefulScale;

  // 1) Greedy clustering in time and space.
  const clusters: Cluster[] = [];
  for (const e of events) {
    const c = clusters[clusters.length - 1];
    if (c) {
      const merged = union(c.box, e.box);
      if (e.t - c.last <= p.joinGap && merged.w <= usable && merged.h <= usable) {
        c.box = merged;
        c.last = e.t;
        c.weight += e.weight;
        c.kinds.add(e.kind);
        continue;
      }
    }
    clusters.push({ first: e.t, last: e.t, box: e.box, weight: e.weight, kinds: new Set([e.kind]) });
  }

  // 2) Score and size each cluster; drop weak or useless ones.
  const enterD = effectiveDuration(input.defaults.enter);
  const exitD = effectiveDuration(input.defaults.exit);
  const lead = enterD + p.settle;
  const minEnter = secondsToTicks(0.22);
  type Draft = {
    start: Ticks; end: Ticks; firstEvent: Ticks; lastEvent: Ticks; box: Rect;
    weight: number; dwellOnly: boolean; scale: number; confidence: number; enter: Ticks; chainedToNext: boolean;
    /** An event left out right after/before this shot must be seen in full view: no pan across it. */
    endBy?: Ticks; startAfter?: Ticks;
  };
  const measure = (box: Rect, weight: number, dwellOnly: boolean) => {
    const compact = Math.min(1, 0.01 / Math.max(1e-4, box.w * box.h));
    const confidence = Math.min(1, 0.25 + 0.3 * weight + 0.15 * compact) * (dwellOnly && input.hasClicks ? 0.8 : 1);
    const fit = Math.min((1 - 2 * p.margin) / Math.max(box.w, 1e-3), (1 - 2 * p.margin) / Math.max(box.h, 1e-3));
    return { confidence, scale: Math.max(1, Math.min(fit, p.preferredScale, p.maxScale)) };
  };
  const natural = (d: Draft) => {
    d.start = Math.max(0, d.firstEvent - lead);
    d.end = Math.min(input.duration, d.lastEvent + p.tail);
  };
  let drafts: Draft[] = [];
  for (const c of clusters) {
    const dwellOnly = c.kinds.size === 1 && c.kinds.has('dwell');
    const m = measure(c.box, c.weight, dwellOnly);
    if (m.confidence < p.minConfidence || m.scale < p.minUsefulScale) continue;
    const d: Draft = { start: 0, end: 0, firstEvent: c.first, lastEvent: c.last, box: c.box, weight: c.weight, dwellOnly, ...m, enter: enterD, chainedToNext: false };
    natural(d);
    drafts.push(d);
  }

  // 3) Events too close for even a quick pan become one wider shot. If that shot would be
  //    too wide to be worth it, the stronger of the two keeps its own shot and the other
  //    is shown in full view: the kept shot zooms out before it (or zooms in after it).
  //    Only when there is no time even for that are both left out.
  const cutFor = (a: Draft, b: Draft) => Math.min(b.firstEvent, Math.max(a.lastEvent + p.minHold / 2, b.firstEvent - lead));
  const quickExit = secondsToTicks(0.3);
  const merged: Draft[] = [];
  for (const d of drafts) {
    const a = merged[merged.length - 1];
    if (a && a.endBy === undefined && d.firstEvent - p.settle - cutFor(a, d) < minEnter) {
      const box = union(a.box, d.box);
      const dwellOnly = a.dwellOnly && d.dwellOnly;
      const wide = measure(box, a.weight + d.weight, dwellOnly);
      const gap = d.firstEvent - a.lastEvent;
      if (wide.scale >= p.minUsefulScale) {
        a.box = box;
        a.lastEvent = d.lastEvent;
        a.weight += d.weight;
        a.dwellOnly = dwellOnly;
        Object.assign(a, wide);
        natural(a);
      } else if (a.weight >= d.weight && gap >= quickExit) {
        a.end = Math.min(a.end, d.firstEvent);
        a.endBy = d.firstEvent;
      } else if (d.weight > a.weight && gap - p.settle >= minEnter) {
        d.start = Math.max(d.start, a.lastEvent);
        d.enter = Math.min(enterD, d.firstEvent - p.settle - d.start);
        d.startAfter = a.lastEvent;
        merged[merged.length - 1] = d;
      } else {
        merged.pop();
      }
      continue;
    }
    merged.push(d);
  }
  drafts = merged;

  // 4) Chain neighbours: they meet at one boundary (pan, no zoom-out in between).
  for (let i = 1; i < drafts.length; i++) {
    const a = drafts[i - 1]!;
    const b = drafts[i]!;
    if (a.endBy !== undefined || b.startAfter !== undefined) continue;
    if (b.firstEvent - a.lastEvent <= p.chainGap || b.start <= a.end) {
      // Stay on A as long as possible, then pan so B is reached just before its first event.
      const cut = cutFor(a, b);
      a.end = cut;
      a.chainedToNext = true;
      b.start = cut;
      b.enter = Math.max(0, Math.min(enterD, b.firstEvent - p.settle - cut));
    }
  }

  // 5) Emit. Unchained items always finish their zoom-out after their last event.
  const out: Omit<ZoomItem, 'id'>[] = [];
  for (const d of drafts) {
    const prev = out[out.length - 1];
    if (prev && d.start < prev.end) d.start = prev.end;
    if (d.end - d.start < p.minHold) continue;
    const exit = d.chainedToNext ? 0 : Math.min(exitD, Math.max(0, d.end - d.lastEvent - secondsToTicks(0.1)));
    out.push({
      type: 'zoom', recordingId: input.recordingId, start: d.start, end: d.end, origin: 'auto', mode: 'region',
      center: { x: d.box.x + d.box.w / 2, y: d.box.y + d.box.h / 2 }, scale: Math.round(d.scale * 100) / 100,
      enter: { ...input.defaults.enter, duration: d.enter },
      exit: { ...input.defaults.exit, duration: d.chainedToNext ? input.defaults.exit.duration : exit },
      confidence: Math.round(d.confidence * 100) / 100,
    });
  }
  return out;
}

// ─── Why there are no suggestions ────────────────────────────────────────────

/**
 * Why a recording got no zoom suggestions, so the editor can say so instead of showing nothing:
 *   - 'no-cursor': there is no pointer data at all;
 *   - 'outside': the pointer was almost never inside the recorded area (typically: another
 *     screen was recorded than the one being worked on). Such points are ignored on purpose;
 *   - 'no-clicks': no clicks are known inside the area and the pointer never rested long enough;
 *   - 'quiet': there was activity, but nothing that makes a useful zoom at this sensitivity.
 */
export type NoSuggestionReason = 'no-cursor' | 'outside' | 'no-clicks' | 'quiet';

/** Below this share of pointer samples inside the recorded area, the pointer counts as elsewhere. */
export const OUTSIDE_SHARE = 0.2;

export function whyNoSuggestions(track: CursorTrack | null | undefined, hasClicks: boolean): NoSuggestionReason {
  if (!track || (track.samples.length === 0 && track.clicks.length === 0)) return 'no-cursor';
  const points = track.samples.length > 0 ? track.samples : track.clicks;
  let inPoints = 0;
  for (const s of points) if (inside(s.x, s.y)) inPoints++;
  if (inPoints / points.length < OUTSIDE_SHARE) return 'outside';
  const clicksInside = hasClicks && track.clicks.some((c) => c.kind === 'down' && c.button === 'left' && inside(c.x, c.y));
  return clicksInside ? 'quiet' : 'no-clicks';
}

/**
 * The reason for a whole project from its recordings' reasons: the one that tells the user most
 * ('outside' first, since it is the one they can act on), or null when there is no recording.
 */
export function combineNoSuggestionReasons(reasons: readonly NoSuggestionReason[]): NoSuggestionReason | null {
  for (const r of ['outside', 'no-clicks', 'quiet', 'no-cursor'] as const) if (reasons.includes(r)) return r;
  return null;
}
