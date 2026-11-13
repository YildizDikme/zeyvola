import { frameDuration, type Ticks } from '@zeyvola/timing';
import { newId } from './factory';
import { layoutSegments, timelineToSource } from './mapping';
import type {
  AudioMix, CameraLayoutItem, ID, MagnifierItem, PrivacyItem, Project, SourceKind, Style, Variant, ZoomItem,
} from './types';

/**
 * Pure document commands. Each returns a new Project (structural sharing) and never
 * mutates its input, so history can keep previous documents by reference.
 */

export type DeepPartial<T> = T extends readonly unknown[] ? T : T extends object ? { [K in keyof T]?: DeepPartial<T[K]> } : T;

export function deepMerge<T>(base: T, patch: DeepPartial<T> | undefined): T {
  if (patch === undefined) return base;
  if (typeof base !== 'object' || base === null || Array.isArray(base)) return patch as T;
  if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) return patch as T;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
    if (v === undefined) continue;
    const b = (base as Record<string, unknown>)[k];
    // Discriminated unions (objects with a `kind`) are replaced, not merged, when the kind changes.
    const kindChanged = isObj(b) && isObj(v) && 'kind' in v && (b as { kind?: unknown }).kind !== (v as { kind?: unknown }).kind;
    out[k] = isObj(b) && isObj(v) && !kindChanged ? deepMerge(b, v as DeepPartial<typeof b>) : v;
  }
  return out as T;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// ─── Segments ───────────────────────────────────────────────────────────────

/** Splits the segment under timeline time `t`. No-op at segment boundaries. */
export function splitAt(project: Project, t: Ticks): Project {
  const pos = timelineToSource(project, t);
  if (!pos) return project;
  const { segment } = pos.placement;
  const minLen = frameDuration(project.sequence.fps);
  if (pos.sourceTime - segment.sourceStart < minLen || segment.sourceEnd - pos.sourceTime < minLen) return project;
  const left = { ...segment, sourceEnd: pos.sourceTime };
  const right = { ...segment, id: newId('seg'), sourceStart: pos.sourceTime };
  const segments = [...project.sequence.segments];
  segments.splice(pos.placement.index, 1, left, right);
  return { ...project, sequence: { ...project.sequence, segments } };
}

export function removeSegment(project: Project, segmentId: ID): Project {
  const segments = project.sequence.segments.filter((s) => s.id !== segmentId);
  if (segments.length === project.sequence.segments.length) return project;
  return { ...project, sequence: { ...project.sequence, segments } };
}

/** Moves one edge of a segment to a new source time, keeping at least one frame. */
export function trimSegment(project: Project, segmentId: ID, edge: 'start' | 'end', sourceTime: Ticks): Project {
  const minLen = frameDuration(project.sequence.fps);
  const segments = project.sequence.segments.map((s) => {
    if (s.id !== segmentId) return s;
    const rec = project.recordings[s.recordingId];
    const max = rec ? rec.duration : s.sourceEnd;
    if (edge === 'start') return { ...s, sourceStart: Math.max(0, Math.min(sourceTime, s.sourceEnd - minLen)) };
    return { ...s, sourceEnd: Math.min(max, Math.max(sourceTime, s.sourceStart + minLen)) };
  });
  return { ...project, sequence: { ...project.sequence, segments } };
}

export function moveSegment(project: Project, segmentId: ID, toIndex: number): Project {
  const segments = [...project.sequence.segments];
  const from = segments.findIndex((s) => s.id === segmentId);
  if (from < 0) return project;
  const [seg] = segments.splice(from, 1);
  segments.splice(Math.max(0, Math.min(toIndex, segments.length)), 0, seg!);
  return { ...project, sequence: { ...project.sequence, segments } };
}

/** Removes the timeline range [start, end), splitting segments as needed (ripple delete). */
export function removeTimelineRange(project: Project, start: Ticks, end: Ticks): Project {
  let p = splitAt(splitAt(project, start), end);
  const placements = layoutSegments(p);
  const keep = placements.filter((pl) => pl.timelineEnd <= start || pl.timelineStart >= end).map((pl) => pl.segment);
  p = { ...p, sequence: { ...p.sequence, segments: keep } };
  return p;
}

// ─── Items ──────────────────────────────────────────────────────────────────

type ItemKey = 'zooms' | 'cameraLayouts' | 'privacy' | 'magnifiers';
type ItemOf<K extends ItemKey> = Project[K][number];

function upsert<K extends ItemKey>(project: Project, key: K, item: ItemOf<K>): Project {
  const list = project[key] as ItemOf<K>[];
  const idx = list.findIndex((i) => i.id === item.id);
  const next = idx >= 0 ? list.map((i) => (i.id === item.id ? item : i)) : [...list, item];
  next.sort((a, b) => a.start - b.start);
  return { ...project, [key]: next };
}

function patchItem<K extends ItemKey>(project: Project, key: K, id: ID, patch: DeepPartial<ItemOf<K>>, markManual: boolean): Project {
  const list = project[key] as ItemOf<K>[];
  const current = list.find((i) => i.id === id);
  if (!current) return project;
  let next = deepMerge(current, patch);
  if (next.end <= next.start) next = { ...next, end: next.start + frameDuration(project.sequence.fps) };
  if (markManual) next = { ...next, origin: 'manual' };
  return upsert(project, key, next);
}

function removeItem(project: Project, key: ItemKey, id: ID): Project {
  const list = project[key] as { id: ID }[];
  const next = list.filter((i) => i.id !== id);
  return next.length === list.length ? project : { ...project, [key]: next };
}

export type NewZoom = Omit<ZoomItem, 'id' | 'type'> & { id?: ID };
export type NewCameraLayout = Omit<CameraLayoutItem, 'id' | 'type'> & { id?: ID };
export type NewPrivacy = Omit<PrivacyItem, 'id' | 'type'> & { id?: ID };
export type NewMagnifier = Omit<MagnifierItem, 'id' | 'type'> & { id?: ID };

export function addZoom(project: Project, z: NewZoom): { project: Project; id: ID } {
  const id = z.id ?? newId('zm');
  return { project: upsert(project, 'zooms', { ...z, id, type: 'zoom' }), id };
}
export const updateZoom = (p: Project, id: ID, patch: DeepPartial<ZoomItem>, markManual = true) => patchItem(p, 'zooms', id, patch, markManual);
export const removeZoom = (p: Project, id: ID) => removeItem(p, 'zooms', id);

export function addCameraLayout(project: Project, c: NewCameraLayout): { project: Project; id: ID } {
  const id = c.id ?? newId('cam');
  return { project: upsert(project, 'cameraLayouts', { ...c, id, type: 'camera' }), id };
}
export const updateCameraLayout = (p: Project, id: ID, patch: DeepPartial<CameraLayoutItem>) => patchItem(p, 'cameraLayouts', id, patch, true);
export const removeCameraLayout = (p: Project, id: ID) => removeItem(p, 'cameraLayouts', id);

export function addPrivacy(project: Project, item: NewPrivacy): { project: Project; id: ID } {
  const id = item.id ?? newId('prv');
  return { project: upsert(project, 'privacy', { ...item, id, type: 'privacy' }), id };
}
export const updatePrivacy = (p: Project, id: ID, patch: DeepPartial<PrivacyItem>) => patchItem(p, 'privacy', id, patch, true);
export const removePrivacy = (p: Project, id: ID) => removeItem(p, 'privacy', id);

export function addMagnifier(project: Project, item: NewMagnifier): { project: Project; id: ID } {
  const id = item.id ?? newId('mag');
  return { project: upsert(project, 'magnifiers', { ...item, id, type: 'magnifier' }), id };
}
export const updateMagnifier = (p: Project, id: ID, patch: DeepPartial<MagnifierItem>) => patchItem(p, 'magnifiers', id, patch, true);
export const removeMagnifier = (p: Project, id: ID) => removeItem(p, 'magnifiers', id);

/**
 * Replaces the automatic zoom suggestions of a recording. Items the user edited
 * (origin 'manual') are never touched; suggestions overlapping them are dropped.
 */
export function applyZoomSuggestions(project: Project, recordingId: ID, suggestions: Omit<ZoomItem, 'id'>[]): Project {
  const manual = project.zooms.filter((z) => z.recordingId === recordingId && z.origin === 'manual');
  const others = project.zooms.filter((z) => z.recordingId !== recordingId);
  const fresh = suggestions
    .filter((s) => !manual.some((m) => s.start < m.end && m.start < s.end))
    .map((s) => ({ ...s, id: newId('zm'), origin: 'auto' as const }));
  const zooms = [...others, ...manual, ...fresh].sort((a, b) => a.start - b.start);
  return { ...project, zooms };
}

export function clearAutoZooms(project: Project, recordingId: ID): Project {
  return { ...project, zooms: project.zooms.filter((z) => z.recordingId !== recordingId || z.origin === 'manual') };
}

// ─── Style, variants, audio, metadata ───────────────────────────────────────

export function setStyle(project: Project, patch: DeepPartial<Style>): Project {
  return { ...project, style: deepMerge<Style>(project.style, patch) };
}

export function setActiveVariant(project: Project, variantId: ID): Project {
  if (!project.variants.some((v) => v.id === variantId) || project.activeVariantId === variantId) return project;
  return { ...project, activeVariantId: variantId };
}

export function updateVariant(project: Project, variantId: ID, patch: DeepPartial<Variant>): Project {
  return { ...project, variants: project.variants.map((v) => (v.id === variantId ? deepMerge<Variant>(v, patch) : v)) };
}

export function renameProject(project: Project, name: string): Project {
  const trimmed = name.trim();
  return trimmed && trimmed !== project.name ? { ...project, name: trimmed } : project;
}

export function setAudio(project: Project, patch: DeepPartial<AudioMix>): Project {
  return { ...project, audio: deepMerge<AudioMix>(project.audio, patch) };
}

export function setSyncOffset(project: Project, recordingId: ID, kind: SourceKind, offset: Ticks): Project {
  const rec = project.recordings[recordingId];
  if (!rec) return project;
  return {
    ...project,
    recordings: { ...project.recordings, [recordingId]: { ...rec, syncOffsets: { ...rec.syncOffsets, [kind]: offset } } },
  };
}

export function setZoomSensitivity(project: Project, sensitivity: Project['zoomEngine']['sensitivity']): Project {
  return { ...project, zoomEngine: { ...project.zoomEngine, sensitivity } };
}
