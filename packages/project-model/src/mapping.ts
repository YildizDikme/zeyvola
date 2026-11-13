import type { Ticks, TimeRange } from '@zeyvola/timing';
import type { ID, ItemBase, Project, Segment } from './types';

export interface SegmentPlacement {
  segment: Segment;
  index: number;
  timelineStart: Ticks;
  timelineEnd: Ticks;
}

export function layoutSegments(project: Project): SegmentPlacement[] {
  const out: SegmentPlacement[] = [];
  let cursor = 0;
  project.sequence.segments.forEach((segment, index) => {
    const len = Math.max(0, segment.sourceEnd - segment.sourceStart);
    out.push({ segment, index, timelineStart: cursor, timelineEnd: cursor + len });
    cursor += len;
  });
  return out;
}

export function sequenceDuration(project: Project): Ticks {
  let total = 0;
  for (const s of project.sequence.segments) total += Math.max(0, s.sourceEnd - s.sourceStart);
  return total;
}

export interface SourcePosition {
  placement: SegmentPlacement;
  recordingId: ID;
  sourceTime: Ticks;
}

/** Maps timeline time to recording time. `t` past the end resolves to the last instant. */
export function timelineToSource(project: Project, t: Ticks, placements = layoutSegments(project)): SourcePosition | null {
  if (placements.length === 0) return null;
  const last = placements[placements.length - 1]!;
  const tt = Math.max(0, Math.min(t, last.timelineEnd - 1));
  let lo = 0;
  let hi = placements.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const p = placements[mid]!;
    if (tt < p.timelineStart) hi = mid - 1;
    else if (tt >= p.timelineEnd) lo = mid + 1;
    else {
      return { placement: p, recordingId: p.segment.recordingId, sourceTime: p.segment.sourceStart + (tt - p.timelineStart) };
    }
  }
  return null;
}

/** First timeline time showing `sourceTime` of the recording, or null if that moment was cut. */
export function sourceToTimeline(project: Project, recordingId: ID, sourceTime: Ticks, placements = layoutSegments(project)): Ticks | null {
  for (const p of placements) {
    const s = p.segment;
    if (s.recordingId === recordingId && sourceTime >= s.sourceStart && sourceTime < s.sourceEnd) {
      return p.timelineStart + (sourceTime - s.sourceStart);
    }
  }
  return null;
}

/** Timeline ranges where a source-anchored item is visible (an item can be split by cuts). */
export function itemTimelineRanges(project: Project, item: ItemBase, placements = layoutSegments(project)): TimeRange[] {
  const out: TimeRange[] = [];
  for (const p of placements) {
    const s = p.segment;
    if (s.recordingId !== item.recordingId) continue;
    const start = Math.max(item.start, s.sourceStart);
    const end = Math.min(item.end, s.sourceEnd);
    if (end > start) out.push({ start: p.timelineStart + (start - s.sourceStart), end: p.timelineStart + (end - s.sourceStart) });
  }
  return out;
}

/** Converts a timeline range to the source range of the segment containing its start. */
export function timelineRangeToSource(project: Project, range: TimeRange): { recordingId: ID; start: Ticks; end: Ticks } | null {
  const a = timelineToSource(project, range.start);
  if (!a) return null;
  const segEndSource = a.placement.segment.sourceEnd;
  const end = Math.min(segEndSource, a.sourceTime + (range.end - range.start));
  return { recordingId: a.recordingId, start: a.sourceTime, end };
}
