import { secondsToTicks, type Ticks } from '@zeyvola/timing';
import { presetTransition } from './easing';
import { activeVariant, cameraSplitTime, resolvedBaseCamera } from './evaluate';
import { laneRange, placeItem } from './constraints';
import { updateCameraLayout } from './commands';
import type { Vec2 } from './geometry';
import type { CameraLayout, CameraLayoutItem, ID, Project } from './types';

/**
 * Dynamic camera. A camera move covers a time range and has two positions: the 1. konum
 * (where it starts — by default where the camera normally sits) and the 2. konum (where it
 * moves to at the split, picked by the user). When the range ends the camera eases back to
 * its default place.
 */
export const DEFAULT_CAMERA_MOVE: Ticks = secondsToTicks(3);

const clampPos = (p: Vec2): Vec2 => ({ x: Math.min(1, Math.max(0, p.x)), y: Math.min(1, Math.max(0, p.y)) });

/** Suggested spot for a 2. konum: the other side of the frame from the 1. konum. */
export function suggestedSecondPosition(p: Vec2): Vec2 {
  return Math.abs(p.x - 0.5) > 0.1 ? { x: 1 - p.x, y: p.y } : { x: p.x, y: 1 - p.y };
}

/** 1. konum of a new move: the camera's default place and look. */
export function newCameraMoveLayout(project: Project): CameraLayout {
  return { ...resolvedBaseCamera(project, activeVariant(project)), visible: true };
}

/**
 * Adds a camera move starting at timeline time `t`, lasting `duration` (shortened to fit
 * before the next move or the end of the clip). The 2. konum is `second` when given;
 * otherwise it is left for the user to pick. Null when there is no room at `t`.
 */
export function addCameraMoveAt(
  project: Project, t: Ticks, second?: { position: Vec2; size?: number }, duration: Ticks = DEFAULT_CAMERA_MOVE,
): { project: Project; id: ID } | null {
  const r = laneRange(project, 'cameraLayouts', t, t + duration);
  if (!r) return null;
  const layout = newCameraMoveLayout(project);
  const placed = placeItem(project, 'cameraLayouts', {
    ...r, origin: 'manual', layout, enter: presetTransition('smooth'),
    ...(second ? { second: { position: clampPos(second.position), size: second.size ?? layout.size } } : {}),
  });
  return placed.ok ? { project: placed.project, id: placed.id } : null;
}

/** Moves or resizes one of a move's two positions. The first edit of the 2. konum picks it. */
export function setCameraMovePosition(project: Project, id: ID, which: 1 | 2, patch: { position?: Vec2; size?: number }): Project {
  const item = project.cameraLayouts.find((c) => c.id === id);
  if (!item) return project;
  const clean = { ...patch, ...(patch.position ? { position: clampPos(patch.position) } : {}) };
  if (which === 1) return updateCameraLayout(project, id, { layout: clean });
  const cur = item.second ?? { position: suggestedSecondPosition(item.layout.position), size: item.layout.size };
  return updateCameraLayout(project, id, { second: { ...cur, ...clean } });
}

/** Which of the two positions is in effect at source time `s` inside `item`. */
export function cameraPartAt(item: CameraLayoutItem, s: Ticks): 1 | 2 {
  return item.second && s >= cameraSplitTime(item) ? 2 : 1;
}
