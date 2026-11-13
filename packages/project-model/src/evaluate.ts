import { TICKS_PER_SECOND, frameDuration, type Ticks } from '@zeyvola/timing';
import type { PreparedCursor } from './cursor';
import { effectiveDuration, transitionProgress } from './easing';
import { MAGNIFIER_LIMITS } from './factory';
import { clamp01, fitAspect, lerp, lerpRect, logLerp, type Rect, type Vec2 } from './geometry';
import { layoutSegments, timelineToSource, type SegmentPlacement } from './mapping';
import type {
  Background, CameraLayout, CameraLayoutItem, FrameStyle, Hex, ID, PrivacyEffect, PrivacyItem,
  Project, Recording, Variant, ZoomItem,
} from './types';

// ─── Render plan ────────────────────────────────────────────────────────────

export interface ScreenLayer {
  mediaTime: Ticks;
  /** Frame rectangle on the canvas, in pixels. */
  frame: Rect;
  radius: number;
  shadow: { opacity: number; blur: number; offsetY: number };
  border: { width: number; color: Hex };
  /** Normalized content rectangle shown inside the frame (relative to `crop`). */
  viewport: Rect;
  /** Normalized region of the screen video that is the content area. */
  crop: Rect;
  zoom: number;
}

export interface CameraLayer {
  mediaTime: Ticks;
  rect: Rect;
  radius: number;
  /** 2 = circular corners, 4 ≈ squircle corners. */
  cornerExponent: number;
  border: { width: number; color: Hex };
  shadow: { opacity: number; blur: number };
  mirror: boolean;
  /** Normalized crop inside the camera feed. */
  crop: Rect;
  opacity: number;
}

export interface CursorLayer {
  /** Normalized source position. */
  position: Vec2;
  scale: number;
  opacity: number;
  click: { position: Vec2; progress: number; effect: 'ring' | 'pulse' } | null;
}

export interface PrivacyLayer {
  id: ID;
  region: Rect;
  effect: PrivacyEffect;
  cornerRadius: number;
}

export interface MagnifierLayer {
  /** Cursor point the lens magnifies about, in canvas pixels; it stays put on screen. */
  focus: Vec2;
  /** Lens rectangle on the canvas, in pixels, kept inside the screen frame. */
  rect: Rect;
  radius: number;
  /** Magnification relative to the screen as drawn in the frame. */
  zoom: number;
  border: { width: number; color: Hex };
  shadow: { opacity: number; blur: number };
  opacity: number;
}

export interface RenderPlan {
  width: number;
  height: number;
  time: Ticks;
  /** Output pixels per 1080p reference pixel. */
  unit: number;
  background: Background;
  recordingId: ID | null;
  sourceTime: Ticks | null;
  screen: ScreenLayer | null;
  camera: CameraLayer | null;
  cursor: CursorLayer | null;
  magnifier: MagnifierLayer | null;
  privacy: PrivacyLayer[];
}

export interface EvaluateOptions {
  variantId?: ID;
  /** Prepared cursor tracks keyed by recording id. */
  cursors?: Record<ID, PreparedCursor | undefined>;
  placements?: SegmentPlacement[];
  /** Overrides output size (e.g. preview canvas). Layout scales proportionally. */
  size?: { width: number; height: number };
}

export function activeVariant(project: Project, variantId?: ID): Variant {
  return project.variants.find((v) => v.id === (variantId ?? project.activeVariantId)) ?? project.variants[0]!;
}

export function resolvedFrameStyle(project: Project, variant: Variant): FrameStyle {
  return { ...project.style.frame, ...variant.frameOverride };
}

export function resolvedBaseCamera(project: Project, variant: Variant): CameraLayout {
  return { ...project.style.camera, ...variant.cameraOverride };
}

function sourceAspect(rec: Recording | undefined, kind: 'screen' | 'camera', fallback: number): number {
  const s = rec?.sources[kind];
  if (!s?.width || !s?.height) return fallback;
  const crop = kind === 'screen' ? rec?.capture.crop : undefined;
  return crop ? (s.width * crop.w) / (s.height * crop.h) : s.width / s.height;
}

const FULL_CROP: Rect = { x: 0, y: 0, w: 1, h: 1 };

// ─── Screen frame and viewport ──────────────────────────────────────────────

export interface FrameGeometry {
  frame: Rect;
  frameAspect: number;
  /** Viewport size at zoom 1, in normalized source units. */
  baseW: number;
  baseH: number;
}

export function frameGeometry(width: number, height: number, frame: FrameStyle, srcAspect: number): FrameGeometry {
  const pad = frame.padding * Math.min(width, height);
  const area = { x: frame.area.x * width, y: frame.area.y * height, w: frame.area.w * width, h: frame.area.h * height };
  const inner = { x: area.x + pad, y: area.y + pad, w: Math.max(1, area.w - 2 * pad), h: Math.max(1, area.h - 2 * pad) };
  const rect = frame.aspectMode === 'source' ? fitAspect(inner, srcAspect) : inner;
  const frameAspect = rect.w / rect.h;
  const baseW = frameAspect >= srcAspect ? 1 : frameAspect / srcAspect;
  const baseH = frameAspect >= srcAspect ? srcAspect / frameAspect : 1;
  return { frame: rect, frameAspect, baseW, baseH };
}

export interface ViewState {
  cx: number;
  cy: number;
  z: number;
}

const FULL: ViewState = { cx: 0.5, cy: 0.5, z: 1 };
const ADJACENT = TICKS_PER_SECOND / 20; // items closer than 50 ms are chained (pan, no zoom-out)

export function clampView(v: ViewState, baseW: number, baseH: number): ViewState {
  const z = Math.max(1, v.z);
  const hw = baseW / (2 * z);
  const hh = baseH / (2 * z);
  return {
    z,
    cx: hw >= 0.5 ? 0.5 : Math.min(1 - hw, Math.max(hw, v.cx)),
    cy: hh >= 0.5 ? 0.5 : Math.min(1 - hh, Math.max(hh, v.cy)),
  };
}

/**
 * Interpolates two views. When the zoom changes, the path keeps one fixed point
 * f = (z1·c1 − z0·c0)/(z1 − z0) stationary on screen and scales about it with a
 * logarithmic zoom curve; this avoids the sideways "swoop" of independent lerps.
 */
export function interpolateView(a: ViewState, b: ViewState, u: number): ViewState {
  if (u <= 0) return a;
  if (u >= 1) return b;
  const z = logLerp(a.z, b.z, u);
  if (Math.abs(Math.log(b.z / a.z)) < 1e-3) {
    return { cx: lerp(a.cx, b.cx, u), cy: lerp(a.cy, b.cy, u), z };
  }
  const fx = (b.z * b.cx - a.z * a.cx) / (b.z - a.z);
  const fy = (b.z * b.cy - a.z * a.cy) / (b.z - a.z);
  const far = fx < -0.25 || fx > 1.25 || fy < -0.25 || fy > 1.25;
  if (far) {
    // Fixed point far outside the source: fall back to eased pan + log zoom.
    return { cx: lerp(a.cx, b.cx, u), cy: lerp(a.cy, b.cy, u), z };
  }
  return { cx: fx - ((fx - a.cx) * a.z) / z, cy: fy - ((fy - a.cy) * a.z) / z, z };
}

function zoomTarget(item: ZoomItem, s: Ticks, cursor: PreparedCursor | undefined): ViewState {
  if (item.mode === 'follow' && cursor?.hasSamples) {
    const p = cursor.smoothAt(s);
    if (p) return { cx: p.x, cy: p.y, z: item.scale };
  }
  return { cx: item.center.x, cy: item.center.y, z: item.scale };
}

/** Resting view without zoom: centered, or following the cursor when the frame crops (fill mode). */
function restingView(s: Ticks, cropping: boolean, cursor: PreparedCursor | undefined): ViewState {
  if (cropping && cursor?.hasSamples) {
    const p = cursor.smoothAt(s);
    if (p) return { cx: p.x, cy: p.y, z: 1 };
  }
  return FULL;
}

export function zoomViewAt(
  items: ZoomItem[], s: Ticks, geom: FrameGeometry, cursor?: PreparedCursor, strength = 1,
): ViewState {
  if (strength !== 1) {
    items = items.map((it) => ({ ...it, scale: 1 + (it.scale - 1) * strength }));
  }
  const cropping = geom.baseW < 0.999 || geom.baseH < 0.999;
  const clampV = (v: ViewState) => clampView(v, geom.baseW, geom.baseH);
  let k = -1;
  for (let i = 0; i < items.length; i++) {
    const it = items[i]!;
    if (it.start <= s && s < it.end) k = i;
    if (it.start > s) break;
  }
  if (k < 0) return clampV(restingView(s, cropping, cursor));
  const item = items[k]!;
  const prev = k > 0 && items[k]!.start <= items[k - 1]!.end + ADJACENT ? items[k - 1]! : null;
  const next = k + 1 < items.length && items[k + 1]!.start <= item.end + ADJACENT ? items[k + 1]! : null;
  const len = item.end - item.start;
  const enterD = Math.min(effectiveDuration(item.enter), len / 2);
  const exitD = next ? 0 : Math.min(effectiveDuration(item.exit), len / 2);
  const target = clampV(zoomTarget(item, s, cursor));

  if (s < item.start + enterD || (item.enter.easing.kind === 'instant' && s === item.start)) {
    const from = clampV(prev ? zoomTarget(prev, s, cursor) : restingView(s, cropping, cursor));
    return clampV(interpolateView(from, target, transitionProgress(s, item.start, { ...item.enter, duration: enterD })));
  }
  if (exitD > 0 && s >= item.end - exitD) {
    const to = clampV(restingView(s, cropping, cursor));
    return clampV(interpolateView(target, to, transitionProgress(s, item.end - exitD, { ...item.exit, duration: exitD })));
  }
  return target;
}

export function viewToViewport(v: ViewState, geom: FrameGeometry): Rect {
  const w = geom.baseW / v.z;
  const h = geom.baseH / v.z;
  return { x: v.cx - w / 2, y: v.cy - h / 2, w, h };
}

// ─── Camera ─────────────────────────────────────────────────────────────────

interface ResolvedCamera {
  position: Vec2;
  size: number;
  aspect: number;
  radius: number; // fraction of shorter side
  exponent: number;
  borderWidth: number;
  borderColor: Hex;
  shadowOpacity: number;
  shadowBlur: number;
  mirror: boolean;
  zoom: number;
  opacity: number;
}

export function resolveCamera(l: CameraLayout, cameraAspect: number): ResolvedCamera {
  let aspect = 1;
  let radius = l.cornerRadius;
  let exponent = 2;
  switch (l.shape) {
    case 'circle': aspect = 1; radius = 0.5; break;
    case 'square': aspect = 1; radius = Math.min(radius, 0.04); break;
    case 'rounded': aspect = 1; break;
    case 'rect': aspect = cameraAspect; break;
    case 'free': aspect = Math.max(0.2, Math.min(5, l.aspect)); break;
    case 'squircle': aspect = 1; radius = 0.5; exponent = 4.5; break;
  }
  return {
    position: l.position, size: l.size, aspect, radius: Math.max(0, Math.min(0.5, radius)), exponent,
    borderWidth: l.border.width, borderColor: l.border.color, shadowOpacity: l.shadow.opacity,
    shadowBlur: l.shadow.blur, mirror: l.mirror, zoom: Math.max(1, l.zoom), opacity: l.visible ? 1 : 0,
  };
}

function mixCamera(a: ResolvedCamera, b: ResolvedCamera, u: number): ResolvedCamera {
  if (u <= 0) return a;
  if (u >= 1) return b;
  // When one side is hidden, keep the visible geometry and fade/scale instead of flying.
  const aGeo = a.opacity === 0 ? b : a;
  const bGeo = b.opacity === 0 ? a : b;
  const opacity = lerp(a.opacity, b.opacity, u);
  const pop = a.opacity === 0 || b.opacity === 0 ? lerp(0.86, 1, opacity) : 1;
  return {
    position: { x: lerp(aGeo.position.x, bGeo.position.x, u), y: lerp(aGeo.position.y, bGeo.position.y, u) },
    size: logLerp(aGeo.size, bGeo.size, u) * pop,
    aspect: logLerp(aGeo.aspect, bGeo.aspect, u),
    radius: lerp(aGeo.radius, bGeo.radius, u),
    exponent: lerp(aGeo.exponent, bGeo.exponent, u),
    borderWidth: lerp(aGeo.borderWidth, bGeo.borderWidth, u),
    borderColor: u < 0.5 ? aGeo.borderColor : bGeo.borderColor,
    shadowOpacity: lerp(aGeo.shadowOpacity, bGeo.shadowOpacity, u),
    shadowBlur: lerp(aGeo.shadowBlur, bGeo.shadowBlur, u),
    mirror: u < 0.5 ? a.mirror : b.mirror,
    zoom: logLerp(aGeo.zoom, bGeo.zoom, u),
    opacity,
  };
}

/** Default moment of the move to the 2. konum: the middle of the range. */
export const DEFAULT_CAMERA_SPLIT = 0.5;

/** Source time at which a camera move heads for its 2. konum. */
export function cameraSplitTime(item: Pick<CameraLayoutItem, 'start' | 'end' | 'split'>): Ticks {
  const f = Math.min(0.9, Math.max(0.1, item.split ?? DEFAULT_CAMERA_SPLIT));
  return Math.round(item.start + (item.end - item.start) * f);
}

/** Full layout of a move's 2. konum, or null while it has not been picked. */
export function cameraSecondLayout(item: CameraLayoutItem): CameraLayout | null {
  return item.second ? { ...item.layout, position: item.second.position, size: item.second.size } : null;
}

/** Where a move leaves the camera when it ends. */
function cameraEndLayout(item: CameraLayoutItem): CameraLayout {
  return cameraSecondLayout(item) ?? item.layout;
}

/** Canvas rectangle and corner shape of the camera bubble drawn with `layout` (no transitions). */
export function cameraFrameFor(
  project: Project, recordingId: ID, layout: CameraLayout, size: { width: number; height: number },
): { rect: Rect; radius: number; cornerExponent: number } | null {
  const rec = project.recordings[recordingId];
  if (!rec?.sources.camera) return null;
  const c = resolveCamera(layout, sourceAspect(rec, 'camera', 16 / 9));
  const h = c.size * size.height;
  const w = h * c.aspect;
  return { rect: { x: c.position.x * size.width - w / 2, y: c.position.y * size.height - h / 2, w, h }, radius: c.radius * Math.min(w, h), cornerExponent: c.exponent };
}

export function cameraAt(items: CameraLayoutItem[], s: Ticks, base: CameraLayout, cameraAspect: number): ResolvedCamera {
  const resolve = (l: CameraLayout) => resolveCamera(l, cameraAspect);
  let k = -1;
  for (let i = 0; i < items.length; i++) {
    const it = items[i]!;
    if (it.start <= s && s < it.end) k = i;
    if (it.start > s) break;
  }
  if (k < 0) {
    // Returning to the base layout after an item ends uses that item's transition.
    let last: CameraLayoutItem | null = null;
    for (const it of items) if (it.end <= s) last = it;
    if (last) {
      const d = effectiveDuration(last.enter);
      if (d > 0 && s < last.end + d) {
        return mixCamera(resolve(cameraEndLayout(last)), resolve(base), transitionProgress(s, last.end, last.enter));
      }
    }
    return resolve(base);
  }
  const item = items[k]!;
  const prev = k > 0 && item.start <= items[k - 1]!.end + ADJACENT ? items[k - 1]! : null;
  const from = resolve(prev ? cameraEndLayout(prev) : base);
  const to = resolve(item.layout);
  // Second part: from the 1. konum to the 2. konum, starting at the split.
  const second = cameraSecondLayout(item);
  const split = second ? cameraSplitTime(item) : item.end;
  if (second && s >= split) {
    const to2 = resolve(second);
    const d2 = Math.min(effectiveDuration(item.enter), item.end - split);
    if (d2 > 0 && s < split + d2) return mixCamera(to, to2, transitionProgress(s, split, { ...item.enter, duration: d2 }));
    return to2;
  }
  const d = Math.min(effectiveDuration(item.enter), split - item.start);
  if (d > 0 && s < item.start + d) return mixCamera(from, to, transitionProgress(s, item.start, { ...item.enter, duration: d }));
  return to;
}

function cameraCrop(cameraAspect: number, targetAspect: number, zoom: number): Rect {
  const w0 = targetAspect >= cameraAspect ? 1 : targetAspect / cameraAspect;
  const h0 = targetAspect >= cameraAspect ? cameraAspect / targetAspect : 1;
  const w = w0 / zoom;
  const h = h0 / zoom;
  return { x: 0.5 - w / 2, y: 0.5 - h / 2, w, h };
}

// ─── Privacy ────────────────────────────────────────────────────────────────

export function privacyRegionAt(item: PrivacyItem, s: Ticks): Rect {
  const kf = item.keyframes;
  if (kf.length === 0) return item.region;
  if (s <= kf[0]!.t) return kf[0]!.region;
  const last = kf[kf.length - 1]!;
  if (s >= last.t) return last.region;
  for (let i = 0; i < kf.length - 1; i++) {
    const a = kf[i]!;
    const b = kf[i + 1]!;
    if (s >= a.t && s < b.t) return lerpRect(a.region, b.region, (s - a.t) / (b.t - a.t));
  }
  return last.region;
}

/**
 * "Hide when in doubt": an item covers a frame if its padded range touches any part of
 * the frame's interval [s, s + frame).
 */
export function privacyActive(item: PrivacyItem, s: Ticks, frame: Ticks): boolean {
  const pad = item.padFrames * frame;
  return s < item.end + pad && item.start - pad < s + frame;
}

// ─── Cursor ─────────────────────────────────────────────────────────────────

const CLICK_EFFECT = 0.55 * TICKS_PER_SECOND;
const IDLE_HIDE = 1.6 * TICKS_PER_SECOND;
const IDLE_FADE = 0.3 * TICKS_PER_SECOND;

/** Where the pointer is drawn at source time `s` (normalized), with the user's smoothing. */
function pointerAt(project: Project, s: Ticks, cursor: PreparedCursor): Vec2 | null {
  const raw = cursor.rawAt(s);
  const smooth = cursor.smoothAt(s);
  if (!raw || !smooth) return null;
  const k = clamp01(project.style.cursor.smoothing);
  return { x: lerp(raw.x, smooth.x, k), y: lerp(raw.y, smooth.y, k) };
}

/** 1 while the pointer is active; fades to 0 after IDLE_HIDE without movement or clicks. */
function idleOpacity(cursor: PreparedCursor, s: Ticks): number {
  const lastMove = cursor.lastMoveAt(s);
  const lastClick = cursor.lastClickBefore(s);
  const idle = s - Math.max(lastMove ?? 0, lastClick?.t ?? 0);
  return idle > IDLE_HIDE ? clamp01(1 - (idle - IDLE_HIDE) / IDLE_FADE) : 1;
}

const outsideSource = (p: Vec2) => p.x < -0.02 || p.x > 1.02 || p.y < -0.02 || p.y > 1.02;

function cursorLayer(project: Project, rec: Recording, s: Ticks, cursor: PreparedCursor | undefined): CursorLayer | null {
  const st = project.style.cursor;
  if (!st.visible || rec.capture.cursorInFrames || !cursor?.hasSamples) return null;
  const position = pointerAt(project, s, cursor);
  if (!position) return null;
  let opacity = st.hideWhenIdle ? idleOpacity(cursor, s) : 1;
  if (outsideSource(position)) opacity = 0;
  let click: CursorLayer['click'] = null;
  if (st.clickEffect !== 'none') {
    const c = cursor.lastClickBefore(s);
    if (c && s - c.t < CLICK_EFFECT) click = { position: { x: c.x, y: c.y }, progress: (s - c.t) / CLICK_EFFECT, effect: st.clickEffect };
  }
  return { position, scale: st.scale, opacity, click };
}

// ─── Magnifier ──────────────────────────────────────────────────────────────

const MAGNIFIER_SHADOW = { opacity: 0.38, blur: 26 };
/** The lens fades and grows in at the start of its range, and out at the end. */
const MAGNIFIER_FADE = 0.25 * TICKS_PER_SECOND;

function inRange(v: number, r: { min: number; max: number }): number {
  return Number.isFinite(v) ? Math.min(r.max, Math.max(r.min, v)) : r.min;
}

function magnifierLayer(project: Project, rec: Recording, s: Ticks, cursor: PreparedCursor | undefined, screen: ScreenLayer, unit: number): MagnifierLayer | null {
  const item = project.magnifiers.find((m) => m.recordingId === rec.id && m.start <= s && s < m.end);
  if (!item || !cursor?.hasSamples) return null;
  const m = project.style.magnifier;
  const p = pointerAt(project, s, cursor);
  if (!p || outsideSource(p)) return null;
  const fade = Math.min(MAGNIFIER_FADE, (item.end - item.start) / 2);
  const edge = fade > 0 ? clamp01(Math.min(s - item.start, item.end - s) / fade) : 1;
  const ease = edge * edge * (3 - 2 * edge);
  const { frame, viewport } = screen;
  const focus = { x: frame.x + ((p.x - viewport.x) / viewport.w) * frame.w, y: frame.y + ((p.y - viewport.y) / viewport.h) * frame.h };
  const size = Math.min(inRange(item.size, MAGNIFIER_LIMITS.size) * unit * lerp(0.85, 1, ease), frame.w, frame.h);
  if (size < 4) return null;
  let opacity = ease * (m.hideWhenIdle ? idleOpacity(cursor, s) : 1);
  // Fade out while the pointer leaves the frame (e.g. outside a zoomed-in view).
  const dx = Math.max(frame.x - focus.x, 0, focus.x - (frame.x + frame.w));
  const dy = Math.max(frame.y - focus.y, 0, focus.y - (frame.y + frame.h));
  opacity *= clamp01(1 - Math.hypot(dx, dy) / (size * 0.25));
  if (opacity <= 0.001) return null;
  // Centered on the pointer, but never past the frame's edges.
  const rect: Rect = {
    x: Math.min(frame.x + frame.w - size, Math.max(frame.x, focus.x - size / 2)),
    y: Math.min(frame.y + frame.h - size, Math.max(frame.y, focus.y - size / 2)),
    w: size, h: size,
  };
  return {
    focus, rect, radius: m.shape === 'circle' ? size / 2 : size * 0.18,
    zoom: inRange(item.zoom, MAGNIFIER_LIMITS.zoom),
    border: { width: inRange(m.border.width, MAGNIFIER_LIMITS.border) * unit, color: m.border.color },
    shadow: { opacity: MAGNIFIER_SHADOW.opacity, blur: MAGNIFIER_SHADOW.blur * unit },
    opacity,
  };
}

/**
 * How the lens reads the screen texture: the uv at the lens's top-left pixel, the uv step per
 * canvas pixel, and the uv range it may read (the recorded area only). The lens scales about
 * its focus, so the pointer stays where it is and everything around it grows by `zoom`.
 */
export function magnifierSampling(screen: ScreenLayer, m: MagnifierLayer): { uv0: Vec2; uvPerPx: Vec2; bounds: Rect } {
  const { frame, viewport, crop } = screen;
  const toUV = (px: number, py: number): Vec2 => ({
    x: crop.x + (viewport.x + ((px - frame.x) / frame.w) * viewport.w) * crop.w,
    y: crop.y + (viewport.y + ((py - frame.y) / frame.h) * viewport.h) * crop.h,
  });
  return {
    uv0: toUV(m.focus.x + (m.rect.x - m.focus.x) / m.zoom, m.focus.y + (m.rect.y - m.focus.y) / m.zoom),
    uvPerPx: { x: (viewport.w * crop.w) / (frame.w * m.zoom), y: (viewport.h * crop.h) / (frame.h * m.zoom) },
    bounds: crop,
  };
}

// ─── Main entry ─────────────────────────────────────────────────────────────

/** Pure function: everything the compositor needs to draw timeline time `t`. */
export function evaluate(project: Project, t: Ticks, opts: EvaluateOptions = {}): RenderPlan {
  const variant = activeVariant(project, opts.variantId);
  const width = opts.size?.width ?? variant.width;
  const height = opts.size?.height ?? variant.height;
  const unit = Math.min(width, height) / 1080;
  const plan: RenderPlan = {
    width, height, time: t, unit, background: project.style.background,
    recordingId: null, sourceTime: null, screen: null, camera: null, cursor: null, magnifier: null, privacy: [],
  };
  const pos = timelineToSource(project, t, opts.placements ?? layoutSegments(project));
  if (!pos) return plan;
  const rec = project.recordings[pos.recordingId];
  if (!rec) return plan;
  const s = pos.sourceTime;
  plan.recordingId = rec.id;
  plan.sourceTime = s;
  const cursor = opts.cursors?.[rec.id];
  const styled = resolvedFrameStyle(project, variant);
  // Zero padding means edge to edge: fill the area (cropping a little if the aspect
  // differs) and drop corners, shadow and border, which would otherwise show background.
  const fullBleed = styled.padding <= 0.0005;
  const frameStyle: FrameStyle = fullBleed
    ? { ...styled, padding: 0, aspectMode: 'fill', radius: 0, shadow: { ...styled.shadow, opacity: 0 }, border: { ...styled.border, width: 0 } }
    : styled;

  const screenSrc = rec.sources.screen;
  if (screenSrc) {
    const geom = frameGeometry(width, height, frameStyle, sourceAspect(rec, 'screen', 16 / 10));
    const zooms = project.zooms.filter((z) => z.recordingId === rec.id);
    const view = zoomViewAt(zooms, s, geom, cursor, variant.zoomStrength ?? 1);
    plan.screen = {
      mediaTime: s - screenSrc.startOffset - (rec.syncOffsets.screen ?? 0),
      frame: geom.frame,
      radius: frameStyle.radius * unit,
      shadow: { opacity: frameStyle.shadow.opacity, blur: frameStyle.shadow.blur * unit, offsetY: frameStyle.shadow.offsetY * unit },
      border: { width: frameStyle.border.width * unit, color: frameStyle.border.color },
      viewport: viewToViewport(view, geom),
      crop: rec.capture.crop ?? FULL_CROP,
      zoom: view.z,
    };
    const frame = frameDuration(project.sequence.fps);
    for (const p of project.privacy) {
      if (p.recordingId !== rec.id || !privacyActive(p, s, frame)) continue;
      plan.privacy.push({ id: p.id, region: privacyRegionAt(p, s), effect: p.effect, cornerRadius: p.cornerRadius });
    }
    plan.cursor = cursorLayer(project, rec, s, cursor);
    plan.magnifier = magnifierLayer(project, rec, s, cursor, plan.screen, unit);
    // The pointer is magnified with everything else in the lens; its tip stays put.
    if (plan.magnifier && plan.cursor) {
      plan.cursor = { ...plan.cursor, scale: plan.cursor.scale * lerp(1, plan.magnifier.zoom, plan.magnifier.opacity) };
    }
  }

  const camSrc = rec.sources.camera;
  if (camSrc) {
    const camAspect = sourceAspect(rec, 'camera', 16 / 9);
    const items = project.cameraLayouts.filter((c) => c.recordingId === rec.id);
    const c = cameraAt(items, s, resolvedBaseCamera(project, variant), camAspect);
    if (c.opacity > 0.001) {
      const h = c.size * height;
      const w = h * c.aspect;
      plan.camera = {
        mediaTime: s - camSrc.startOffset - (rec.syncOffsets.camera ?? 0),
        rect: { x: c.position.x * width - w / 2, y: c.position.y * height - h / 2, w, h },
        radius: c.radius * Math.min(w, h),
        cornerExponent: c.exponent,
        border: { width: c.borderWidth * unit, color: c.borderColor },
        shadow: { opacity: c.shadowOpacity, blur: c.shadowBlur * unit },
        mirror: c.mirror,
        crop: cameraCrop(camAspect, c.aspect, c.zoom),
        opacity: c.opacity,
      };
    }
  }
  return plan;
}

/** Maps a canvas pixel to normalized screen-source coordinates using a render plan. */
export function canvasToSource(plan: RenderPlan, px: number, py: number): Vec2 | null {
  const sc = plan.screen;
  if (!sc) return null;
  const u = (px - sc.frame.x) / sc.frame.w;
  const v = (py - sc.frame.y) / sc.frame.h;
  return { x: sc.viewport.x + u * sc.viewport.w, y: sc.viewport.y + v * sc.viewport.h };
}

/** Maps normalized screen-source coordinates to canvas pixels. */
export function sourceToCanvas(plan: RenderPlan, p: Vec2): Vec2 | null {
  const sc = plan.screen;
  if (!sc) return null;
  return {
    x: sc.frame.x + ((p.x - sc.viewport.x) / sc.viewport.w) * sc.frame.w,
    y: sc.frame.y + ((p.y - sc.viewport.y) / sc.viewport.h) * sc.frame.h,
  };
}
